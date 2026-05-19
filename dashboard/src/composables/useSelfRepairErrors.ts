import { computed, watch } from "vue";
import { fetchRepairErrors } from "../api";
import type { StreamEvent } from "./useStream";
import { createStreamCache } from "./streamCache";
import { ref } from "vue";
import type { RepairErrorWithAttempts } from "../types";

/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair) — SSE-driven state for the
 * Self-Repair tab.
 *
 * Mirrors the DX-689 stream-cache factory: the REST fetch seeds the
 * initial snapshot, then a single SSE subscription on
 * `system-repair-error:updated` reduces every subsequent mutation into
 * the same in-memory list. No `setInterval`, no polling fallback —
 * the backend's `publishRepairErrorUpdated` helper fans out every
 * write (Phase 2 recordError bumps, Phase 3 dispatcher status flips,
 * Phase 3 finalize verdicts, Phase 5 operator actions).
 *
 * Module-singleton: App.vue owns the lifecycle via `init()` / `destroy()`.
 */

const selectedRepo = ref<string>("");

const filters = computed(() => ({
  ...(selectedRepo.value ? { repo: selectedRepo.value } : {}),
}));

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

const cache = createStreamCache<RepairErrorWithAttempts[]>({
  topic: "system-repair-error:updated",
  initialState: () => [],
  fetchFn: () => fetchRepairErrors(filters.value),
  applyOne,
});

export const unfixableCount = computed<number>(() =>
  cache.state.value.reduce(
    (n, e) => (e.error.status === "unfixable" ? n + 1 : n),
    0,
  ),
);

let stopWatch: (() => void) | null = null;

function init(): void {
  cache.init();
  if (stopWatch) return; // idempotent across repeated init() calls
  stopWatch = watch(filters, () => {
    void cache.hydrate();
  });
}

function destroy(): void {
  cache.destroy();
  stopWatch?.();
  stopWatch = null;
}

export function useSelfRepairErrors() {
  return {
    errors: cache.state,
    loading: cache.loading,
    error: cache.error,
    selectedRepo,
    unfixableCount,
    refresh: cache.hydrate,
    init,
    destroy,
  };
}
