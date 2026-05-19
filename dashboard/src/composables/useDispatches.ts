import { ref, computed, watch } from "vue";
import { fetchDispatches } from "../api";
import type { StreamEvent } from "./useStream";
import { createStreamCache } from "./streamCache";
import type {
  Dispatch,
  DispatchFilters,
  DispatchStatus,
  TriggerType,
} from "../types";

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
 * Single source of truth for topic→reducer dispatch + payload validation.
 * Used for BOTH the pre-hydrate queue drain (inside buffer.hydrate) and
 * live events (via buffer.onLiveEvent).
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

// Module-singleton (DX-689 factory). App.vue::useDispatches() is the only
// caller, and its mount/unmount owns init() / destroy().
const cache = createStreamCache<Dispatch[]>({
  topic: ["dispatch:created", "dispatch:updated"],
  initialState: () => [],
  fetchFn: () => fetchDispatches(filters.value),
  applyOne,
});

let stopWatch: (() => void) | null = null;

function init(): void {
  cache.init();
  if (stopWatch) return;
  // Filter changes drop stale rows via a fresh REST fetch. The hydration
  // buffer re-buffers events that fire mid-refetch and replays them on top
  // of the new snapshot via applyOne (no events lost under the new filter).
  stopWatch = watch(filters, () => {
    void cache.hydrate();
  });
}

function destroy(): void {
  cache.destroy();
  stopWatch?.();
  stopWatch = null;
}

export function useDispatches() {
  return {
    dispatches: cache.state,
    loading: cache.loading,
    error: cache.error,
    selectedRepo,
    selectedTrigger,
    selectedStatus,
    searchQuery,
    // The DashboardHeader's @refresh manual-reload button shares the
    // mount-time hydrate code path — one way to get fresh data, not two.
    refresh: cache.hydrate,
    init,
    destroy,
  };
}
