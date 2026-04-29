import { ref, computed, watch } from "vue";
import { fetchDispatches } from "../api";
import {
  createHydrationBuffer,
  useStream,
  type HydrationBuffer,
  type StreamEvent,
  type UseStreamReturn,
} from "./useStream";
import type {
  Dispatch,
  DispatchFilters,
  DispatchStatus,
  TriggerType,
} from "../types";

const dispatches = ref<Dispatch[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedRepo = ref<string>("");
const selectedTrigger = ref<TriggerType | "">("");
const selectedStatus = ref<DispatchStatus | "">("");
const searchQuery = ref<string>("");

const filters = computed<DispatchFilters>(() => ({
  ...(selectedRepo.value ? { repo: selectedRepo.value } : {}),
  ...(selectedTrigger.value ? { trigger: selectedTrigger.value } : {}),
  ...(selectedStatus.value ? { status: selectedStatus.value } : {}),
  ...(searchQuery.value ? { q: searchQuery.value } : {}),
}));

/**
 * One stream event applied to the dispatch list. Split into created/updated
 * to match the backend's two publish sites in `src/dashboard/dispatch-tracker.ts`:
 * `dispatch:created` carries a full Dispatch row; `dispatch:updated` carries
 * only `{id}` plus the changed fields.
 */
export type DispatchEvent =
  | { type: "created"; dispatch: Dispatch }
  | { type: "updated"; patch: Partial<Dispatch> & { id: string } };

/**
 * Idempotent reducer: apply one stream event to a dispatch list snapshot.
 *
 * Design choices captured for future readers:
 * - `created` prepends (newest-first, matching the backend's ORDER BY
 *   createdAt DESC) and dedupes by id. A duplicate create — either from a
 *   reconnect replaying an old event or from the hydrate-then-patch race —
 *   is a no-op that returns the same reference to avoid Vue's reactivity
 *   from triggering a needless render.
 * - `updated` shallow-merges the patch onto the matching row in a new
 *   array. The backend always emits full Dispatch fields in the patch
 *   (never deep-nested), so a shallow merge is correct.
 * - An `updated` for an unknown id is dropped rather than synthesized into
 *   a stub row. A partial patch lacks required fields like `repo`,
 *   `trigger`, `startedAt`, and rendering a half-filled entry produces
 *   worse UX than briefly missing one event. The Phase 4 card's language
 *   "unknown-id update = create" assumed updates carry full rows; they do
 *   not (see `dispatch-tracker.ts:203-213`). A missed `created` self-heals
 *   on the next filter change or page reload, which both trigger a fresh
 *   REST hydrate. The drop is observable via `console.warn` below so a
 *   regression in the producer (stop emitting `created` before `updated`)
 *   surfaces loudly instead of silently.
 */
export function applyDispatchEvent(
  state: Dispatch[],
  event: DispatchEvent,
): Dispatch[] {
  if (event.type === "created") {
    if (state.some((d) => d.id === event.dispatch.id)) return state;
    return [event.dispatch, ...state];
  }
  const idx = state.findIndex((d) => d.id === event.patch.id);
  if (idx === -1) {
    // Unknown id — producer invariant violated. Surface so it's debuggable.
    // eslint-disable-next-line no-console
    console.warn(
      `useDispatches: dispatch:updated for unknown id "${event.patch.id}" — ` +
        `likely a missed dispatch:created event. Next hydrate will reconcile.`,
    );
    return state;
  }
  const merged = { ...state[idx], ...event.patch };
  return [...state.slice(0, idx), merged, ...state.slice(idx + 1)];
}

/**
 * Runtime guards for SSE payloads. The `/api/stream` wire is `JSON.parse` of
 * untyped text; a backend schema drift would otherwise render half-filled
 * rows silently. These guards enforce the minimum shape the reducer needs
 * (every field accessed in `applyDispatchEvent` and its call sites).
 *
 * We deliberately DO NOT validate every field on the Dispatch interface
 * here — that would duplicate the backend schema and bloat this file. The
 * guards catch the two real failure modes we've seen in practice: (1) the
 * handler receives `null` or a string from a malformed event, and (2) the
 * backend stops emitting `id` on one of the topics. Either case becomes an
 * early return with a `console.warn` instead of a half-rendered row.
 */
function isDispatchCreated(data: unknown): data is Dispatch {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { id?: unknown }).id === "string"
  );
}

function isDispatchPatch(
  data: unknown,
): data is Partial<Dispatch> & { id: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { id?: unknown }).id === "string"
  );
}

/**
 * Stream lifecycle. Module-scoped singletons — `App.vue::useDispatches()`
 * is the only caller, and its mount/unmount owns `init()`/`destroy()`.
 * Tests reset via `vi.resetModules` + re-import.
 *
 * One `HydrationBuffer` covers BOTH topics. The buffer keeps a single
 * subscription per topic across the buffered→live transition, so there
 * is no microtask gap where events can be lost (the bug Phase 4
 * hand-rolled around with `hydrating` + `pendingCreated`/`pendingUpdated`,
 * deleted in Phase 7).
 */
let stream: UseStreamReturn | null = null;
let buffer: HydrationBuffer<Dispatch[]> | null = null;
let stopWatch: (() => void) | null = null;

/**
 * Apply one StreamEvent to a Dispatch[] snapshot. Used for BOTH the
 * pre-hydrate queue drain (inside buffer.hydrate) and live events (via
 * buffer.onLiveEvent). Single source of truth for topic→reducer dispatch
 * + payload validation.
 */
function applyOne(state: Dispatch[], event: StreamEvent): Dispatch[] {
  if (event.topic === "dispatch:created") {
    if (!isDispatchCreated(event.data)) {
      // eslint-disable-next-line no-console
      console.warn("useDispatches: malformed dispatch:created event", event);
      return state;
    }
    return applyDispatchEvent(state, {
      type: "created",
      dispatch: event.data,
    });
  }
  if (event.topic === "dispatch:updated") {
    if (!isDispatchPatch(event.data)) {
      // eslint-disable-next-line no-console
      console.warn("useDispatches: malformed dispatch:updated event", event);
      return state;
    }
    return applyDispatchEvent(state, { type: "updated", patch: event.data });
  }
  return state;
}

async function hydrate(): Promise<void> {
  if (!buffer) return;
  loading.value = true;
  error.value = null;
  try {
    dispatches.value = await buffer.hydrate(
      () => fetchDispatches(filters.value),
      applyOne,
    );
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function init(): void {
  if (stream) return; // idempotent — App.vue may call init() more than once
  stream = useStream();
  buffer = createHydrationBuffer<Dispatch[]>(stream, [
    "dispatch:created",
    "dispatch:updated",
  ]);
  buffer.onLiveEvent((event) => {
    dispatches.value = applyOne(dispatches.value, event);
  });

  void hydrate();

  // Filter changes drop stale rows via a fresh REST fetch. The buffer
  // re-buffers events that fire mid-refetch and replays them on top of
  // the new snapshot via applyOne (no events lost under the new filter).
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

export function useDispatches() {
  return {
    dispatches,
    loading,
    error,
    selectedRepo,
    selectedTrigger,
    selectedStatus,
    searchQuery,
    // The DashboardHeader's @refresh manual-reload button shares the
    // mount-time hydrate code path — one way to get fresh data, not two.
    refresh: hydrate,
    init,
    destroy,
  };
}
