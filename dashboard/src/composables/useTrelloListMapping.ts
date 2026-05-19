import { computed, ref, type Ref } from "vue";
import {
  fetchTrelloBoardLists,
  fetchTrelloListMapping,
  patchTrelloListMapping,
  type TrelloListMappingResponse,
} from "../api";
import type { StreamEvent } from "./useStream";
import { createKeyedStreamCache } from "./streamCache";
import type {
  TrelloListMap,
  TrelloListSummary,
} from "../types";

/**
 * DX-611 (Phase 8b.3 of DX-575) — Vue composable that owns the wire
 * state for the Settings UI's Trello list-mapping panel.
 *
 * **Per-repo shared instance with refcount (DX-688, factored over the
 * DX-689 `createKeyedStreamCache` factory).** Every call to
 * `useTrelloListMapping(repo)` for the same `repo` returns a facade
 * backed by ONE shared per-repo cache. Two Settings-page components
 * mount with the SAME repo prop (`TrelloListMapping.vue` +
 * `BacklogBootstrapBanner.vue`) — pre-DX-688 each instance fired its
 * own `GET /api/trello/list-mapping` AND `GET /api/trello/board-lists`,
 * doubling the cold-cache hits to Trello over the wire. The shared
 * cache fires ONE pair of fetches per repo regardless of how many
 * components mount, refcounting the underlying SSE subscription so the
 * connection survives any single component unmounting and only tears
 * down when the last consumer detaches. Different repos still get
 * independent fetches + subscriptions.
 *
 * Wire contract:
 *  - `fetchTrelloListMapping(repo)` returns the full
 *    `{map, classification, trello_available, board_configured}` shape
 *    the panel consumes (see `src/dashboard/trello-list-mapping-routes.ts`).
 *  - `trello-list-map:updated` SSE payload is `{repoName, map}`. The
 *    composable merges the new `map` into the existing response and
 *    keeps the prior `classification` / `trello_available` /
 *    `board_configured` until the next hydrate (re-classification
 *    requires a fresh trello-lists fetch — operators see the dropdown
 *    selections jump to the new map immediately; badges refresh on the
 *    next mount/refresh).
 *
 * The shape of the cached state is a combined record: BOTH the
 * `mapping` response AND the cached `boardLists` ride one stream-cache
 * instance — the `boardLists` array is fetched in parallel with the
 * mapping on first hydrate so the dropdowns are populated on first
 * paint (the Re-fetch button calls `refetchBoardLists` to refresh
 * separately with the server's 30s cache bypassed).
 */
export interface UseTrelloListMappingReturn {
  mapping: Ref<TrelloListMappingResponse | null>;
  boardLists: Ref<TrelloListSummary[]>;
  loading: Ref<boolean>;
  saving: Ref<boolean>;
  error: Ref<string | null>;
  /** Hydrate from REST + open the SSE subscription. Idempotent across facades for the same repo (refcount). */
  init: () => void;
  /** Tear down the SSE subscription. Call from `onBeforeUnmount`. */
  destroy: () => void;
  /** Manual re-hydrate (Settings UI's retry-on-error button). */
  refresh: () => Promise<void>;
  /**
   * Re-fetch the Trello board lists with the 30s cache bypassed AND
   * re-hydrate the mapping so the SPA's `classification` mirrors the
   * fresh board snapshot. Used by the Re-fetch button.
   */
  refetchBoardLists: () => Promise<void>;
  /**
   * PATCH the mapping. On success, replaces `mapping.value.map` with the
   * server's round-tripped shape so the SPA does NOT wait for the SSE
   * round-trip on the same tab. Other tabs reconcile through SSE.
   */
  save: (next: TrelloListMap) => Promise<void>;
}

function isMapUpdatedPayload(
  data: unknown,
): data is { repoName: string; map: TrelloListMap } {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as { repoName?: unknown; map?: unknown };
  if (typeof obj.repoName !== "string") return false;
  if (typeof obj.map !== "object" || obj.map === null) return false;
  const inner = (obj.map as { list_id_to_trello_list_id?: unknown })
    .list_id_to_trello_list_id;
  return typeof inner === "object" && inner !== null;
}

interface CombinedState {
  mapping: TrelloListMappingResponse | null;
  boardLists: TrelloListSummary[];
}

function applyOne(
  state: CombinedState,
  event: StreamEvent,
  repo: string,
): CombinedState {
  if (event.topic !== "trello-list-map:updated") return state;
  if (!isMapUpdatedPayload(event.data)) {
    // eslint-disable-next-line no-console
    console.warn(
      "useTrelloListMapping: malformed trello-list-map:updated event",
      event,
    );
    return state;
  }
  if (event.data.repoName !== repo) return state;
  if (!state.mapping) return state;
  return {
    ...state,
    mapping: { ...state.mapping, map: event.data.map },
  };
}

/**
 * Both REST sources fan into a single combined state so one
 * `createKeyedStreamCache` instance owns the per-repo cache.
 *
 * On either rejection the whole hydrate fails — state stays at its
 * prior value (initial `null` / `[]` on first paint), `error.value`
 * carries the failure, the panel renders empty + a banner, operator
 * clicks Re-fetch. This is an all-or-nothing simplification from the
 * pre-DX-689 partial-render behavior (mapping ok + boardLists fail
 * used to paint the mapping panel with empty dropdowns). Trade-off
 * weighed: factory API surface area (a per-key `setState` callback
 * threaded through `fetchFn`) was deemed too costly for one
 * consumer's UX nuance. Partial Trello backend failures are rare
 * (both endpoints share availability) and the operator-recovery
 * path is one click. Mapping error wins when both fail.
 */
async function hydrateCombined(repo: string): Promise<CombinedState> {
  const [mappingResult, boardListsResult] = await Promise.allSettled([
    fetchTrelloListMapping(repo),
    fetchTrelloBoardLists(repo),
  ]);
  if (mappingResult.status === "rejected") {
    throw mappingResult.reason;
  }
  if (boardListsResult.status === "rejected") {
    // Mapping landed; surface the board-list error so the operator's
    // banner explains why the dropdowns are empty.
    throw boardListsResult.reason;
  }
  return {
    mapping: mappingResult.value,
    boardLists: boardListsResult.value,
  };
}

const cacheFactory = createKeyedStreamCache<CombinedState, string>({
  topic: "trello-list-map:updated",
  initialState: () => ({ mapping: null, boardLists: [] }),
  fetchFn: hydrateCombined,
  applyOne,
});

// Per-repo `saving` ref. Lives outside the factory because it is purely
// a PATCH-in-flight flag, not SSE-driven state.
const savingByRepo = new Map<string, Ref<boolean>>();

function getSavingRef(repo: string): Ref<boolean> {
  const cached = savingByRepo.get(repo);
  if (cached) return cached;
  const r = ref<boolean>(false);
  savingByRepo.set(repo, r);
  return r;
}

/**
 * Test-only: drop every shared per-repo instance. Tests call this in
 * `beforeEach` so refcount / cached state / streams do not leak across
 * cases.
 */
export function __resetSharedTrelloListMappingForTesting(): void {
  cacheFactory.__resetForTesting();
  savingByRepo.clear();
}

export function useTrelloListMapping(repo: string): UseTrelloListMappingReturn {
  const cache = cacheFactory(repo);
  const saving = getSavingRef(repo);

  // Expose the two halves of the combined state as `WritableComputedRef`
  // projections. Real refs (carry `__v_isRef`), so they behave correctly
  // under `isRef` / `unref` / template auto-unwrap / `watch(mapping, fn)`.
  const mapping = computed<TrelloListMappingResponse | null>({
    get: () => cache.state.value.mapping,
    set: (v) => {
      cache.state.value = { ...cache.state.value, mapping: v };
    },
  });

  const boardLists = computed<TrelloListSummary[]>({
    get: () => cache.state.value.boardLists,
    set: (v) => {
      cache.state.value = { ...cache.state.value, boardLists: v };
    },
  });

  async function refetchBoardLists(): Promise<void> {
    cache.error.value = null;
    try {
      const next = await fetchTrelloBoardLists(repo, { refresh: true });
      cache.state.value = { ...cache.state.value, boardLists: next };
    } catch (err) {
      cache.error.value = err instanceof Error ? err.message : String(err);
      return;
    }
    await cache.hydrate();
  }

  async function save(next: TrelloListMap): Promise<void> {
    if (saving.value) return;
    saving.value = true;
    cache.error.value = null;
    try {
      const written = await patchTrelloListMapping(repo, next);
      const prev = cache.state.value.mapping;
      if (prev) {
        cache.state.value = {
          ...cache.state.value,
          mapping: { ...prev, map: written },
        };
      }
    } catch (err) {
      cache.error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      saving.value = false;
    }
  }

  return {
    mapping,
    boardLists,
    loading: cache.loading,
    saving,
    error: cache.error,
    init: cache.init,
    destroy: cache.destroy,
    refresh: cache.hydrate,
    refetchBoardLists,
    save,
  };
}
