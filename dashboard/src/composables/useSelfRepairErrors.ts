import { ref, computed, watch } from "vue";
import { fetchRepairErrors } from "../api";
import {
  createHydrationBuffer,
  useStream,
  type HydrationBuffer,
  type StreamEvent,
  type UseStreamReturn,
} from "./useStream";
import type { RepairErrorWithAttempts } from "../types";

/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair) — SSE-driven state for the
 * Self-Repair tab.
 *
 * Mirrors the `useDispatches` pattern (DX-227 mandate): the REST
 * fetch seeds the initial snapshot, then a single SSE subscription on
 * `system-repair-error:updated` reduces every subsequent mutation into
 * the same in-memory list. No `setInterval`, no polling fallback —
 * the backend's `publishRepairErrorUpdated` helper fans out every
 * write (Phase 2 recordError bumps, Phase 3 dispatcher status flips,
 * Phase 3 finalize verdicts, Phase 5 operator actions).
 *
 * Module-scoped singletons match the other composables — `App.vue`
 * owns the lifecycle via `init()` / `destroy()`; tests reset by
 * `vi.resetModules` + re-importing.
 */

const errors = ref<RepairErrorWithAttempts[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedRepo = ref<string>("");

const filters = computed(() => ({
  ...(selectedRepo.value ? { repo: selectedRepo.value } : {}),
}));

export const unfixableCount = computed<number>(() =>
  errors.value.reduce(
    (n, e) => (e.error.status === "unfixable" ? n + 1 : n),
    0,
  ),
);

/**
 * Apply one bus payload to the snapshot. Two variants:
 *
 *  - `{ row: RepairErrorWithAttempts }` — upsert by `error.id`,
 *    preserving the count-DESC last_seen-DESC ordering. Rows that
 *    moved up in count get re-sorted to the top so the list reflects
 *    the live ranking the dispatcher would pick.
 *  - `{ removed: true }` — drop the row.
 *
 * Idempotent: a re-applied event for an existing id replaces the row
 * in place; a remove for an unknown id is a no-op.
 */
export function applyRepairErrorEvent(
  state: RepairErrorWithAttempts[],
  event:
    | { error_id: number; row: RepairErrorWithAttempts; removed?: false }
    | { error_id: number; removed: true },
): RepairErrorWithAttempts[] {
  if (event.removed) {
    const idx = state.findIndex((e) => e.error.id === event.error_id);
    if (idx === -1) return state;
    return [...state.slice(0, idx), ...state.slice(idx + 1)];
  }
  const next = [...state];
  const idx = next.findIndex((e) => e.error.id === event.error_id);
  if (idx === -1) {
    next.push(event.row);
  } else {
    next[idx] = event.row;
  }
  next.sort((a, b) => {
    if (b.error.count !== a.error.count) return b.error.count - a.error.count;
    return (
      new Date(b.error.last_seen).getTime() -
      new Date(a.error.last_seen).getTime()
    );
  });
  return next;
}

function isUpdatePayload(
  data: unknown,
): data is
  | { error_id: number; row: RepairErrorWithAttempts; removed?: false }
  | { error_id: number; removed: true } {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { error_id?: unknown }).error_id === "number"
  );
}

let stream: UseStreamReturn | null = null;
let buffer: HydrationBuffer<RepairErrorWithAttempts[]> | null = null;
let stopWatch: (() => void) | null = null;

function applyOne(
  state: RepairErrorWithAttempts[],
  event: StreamEvent,
): RepairErrorWithAttempts[] {
  if (event.topic !== "system-repair-error:updated") return state;
  if (!isUpdatePayload(event.data)) {
    // eslint-disable-next-line no-console
    console.warn(
      "useSelfRepairErrors: malformed system-repair-error:updated event",
      event,
    );
    return state;
  }
  return applyRepairErrorEvent(state, event.data);
}

async function hydrate(): Promise<void> {
  if (!buffer) return;
  loading.value = true;
  error.value = null;
  try {
    errors.value = await buffer.hydrate(
      () => fetchRepairErrors(filters.value),
      applyOne,
    );
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function init(): void {
  if (stream) return;
  stream = useStream();
  buffer = createHydrationBuffer<RepairErrorWithAttempts[]>(stream, [
    "system-repair-error:updated",
  ]);
  buffer.onLiveEvent((event) => {
    errors.value = applyOne(errors.value, event);
  });
  void hydrate();
  stopWatch = watch(filters, () => {
    void hydrate();
  });
}

function destroy(): void {
  buffer?.close();
  buffer = null;
  stream?.disconnect();
  stream = null;
  stopWatch?.();
  stopWatch = null;
}

export function useSelfRepairErrors() {
  return {
    errors,
    loading,
    error,
    selectedRepo,
    unfixableCount,
    refresh: hydrate,
    init,
    destroy,
  };
}
