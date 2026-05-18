import { ref } from "vue";
import type { Ref } from "vue";
import {
  fetchTrelloBoardLists,
  fetchTrelloListMapping,
  patchTrelloListMapping,
  type TrelloListMappingResponse,
} from "../api";
import { useStream, type UseStreamReturn } from "./useStream";
import type {
  TrelloListMap,
  TrelloListSummary,
} from "../types";

/**
 * DX-611 (Phase 8b.3 of DX-575) — Vue composable that owns the wire
 * state for the Settings UI's Trello list-mapping panel.
 *
 * **Per-repo shared instance with refcount (DX-688).** Every call to
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

interface SharedTrelloListMappingInstance {
  mapping: Ref<TrelloListMappingResponse | null>;
  boardLists: Ref<TrelloListSummary[]>;
  loading: Ref<boolean>;
  saving: Ref<boolean>;
  error: Ref<string | null>;
  hydrate: () => Promise<void>;
  refetchBoardLists: () => Promise<void>;
  save: (next: TrelloListMap) => Promise<void>;
  /** Number of facades that have called init() and not yet destroy(). */
  refCount: number;
  /** Live SSE stream; null when refCount === 0. */
  stream: UseStreamReturn | null;
  unsubscribe: (() => void) | null;
}

const sharedByRepo = new Map<string, SharedTrelloListMappingInstance>();

function getOrCreateShared(repo: string): SharedTrelloListMappingInstance {
  const cached = sharedByRepo.get(repo);
  if (cached) return cached;

  const mapping = ref<TrelloListMappingResponse | null>(null);
  const boardLists = ref<TrelloListSummary[]>([]);
  const loading = ref<boolean>(false);
  const saving = ref<boolean>(false);
  const error = ref<string | null>(null);

  async function hydrate(): Promise<void> {
    loading.value = true;
    error.value = null;
    // Fetch BOTH the mapping AND the cached board lists in parallel —
    // the dropdowns need `boardLists` populated on first paint, otherwise
    // the operator sees only "(unmapped)" until they click Re-fetch
    // (reviewer S1). Board lists ride the same 30s server cache; this
    // is one extra round-trip the dashboard can afford.
    const [mappingResult, boardListsResult] = await Promise.allSettled([
      fetchTrelloListMapping(repo),
      fetchTrelloBoardLists(repo),
    ]);
    if (mappingResult.status === "fulfilled") {
      mapping.value = mappingResult.value;
    } else {
      error.value =
        mappingResult.reason instanceof Error
          ? mappingResult.reason.message
          : String(mappingResult.reason);
    }
    if (boardListsResult.status === "fulfilled") {
      boardLists.value = boardListsResult.value;
    } else if (mappingResult.status === "fulfilled") {
      // Mapping arrived, board lists failed — surface the Trello-side
      // failure on `error.value` so the operator's banner explains why
      // the dropdowns are empty. Mapping error wins when both fail.
      error.value =
        boardListsResult.reason instanceof Error
          ? boardListsResult.reason.message
          : String(boardListsResult.reason);
    }
    loading.value = false;
  }

  async function refetchBoardLists(): Promise<void> {
    error.value = null;
    try {
      boardLists.value = await fetchTrelloBoardLists(repo, { refresh: true });
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      return;
    }
    await hydrate();
  }

  async function save(next: TrelloListMap): Promise<void> {
    if (saving.value) return;
    saving.value = true;
    error.value = null;
    try {
      const written = await patchTrelloListMapping(repo, next);
      const prev = mapping.value;
      if (prev) {
        mapping.value = { ...prev, map: written };
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      saving.value = false;
    }
  }

  const instance: SharedTrelloListMappingInstance = {
    mapping,
    boardLists,
    loading,
    saving,
    error,
    hydrate,
    refetchBoardLists,
    save,
    refCount: 0,
    stream: null,
    unsubscribe: null,
  };

  sharedByRepo.set(repo, instance);
  return instance;
}

/**
 * Test-only: drop every shared per-repo instance. Tests call this in
 * `beforeEach` so refcount / cached state / streams do not leak across
 * cases.
 */
export function __resetSharedTrelloListMappingForTesting(): void {
  for (const inst of sharedByRepo.values()) {
    inst.unsubscribe?.();
    inst.stream?.disconnect();
  }
  sharedByRepo.clear();
}

export function useTrelloListMapping(repo: string): UseTrelloListMappingReturn {
  const shared = getOrCreateShared(repo);
  // Each facade tracks whether IT called init() so destroy() decrements
  // exactly once even on double-destroy calls.
  let attached = false;

  function init(): void {
    if (attached) return; // idempotent per facade
    attached = true;
    shared.refCount++;
    if (shared.refCount === 1) {
      // First consumer for this repo — open the stream + fire initial hydrate.
      shared.stream = useStream();
      shared.unsubscribe = shared.stream.subscribe(
        "trello-list-map:updated",
        (event) => {
          if (!isMapUpdatedPayload(event.data)) {
            // eslint-disable-next-line no-console
            console.warn(
              "useTrelloListMapping: malformed trello-list-map:updated event",
              event,
            );
            return;
          }
          if (event.data.repoName !== repo) return;
          const prev = shared.mapping.value;
          if (!prev) return;
          shared.mapping.value = { ...prev, map: event.data.map };
        },
      );
      void shared.hydrate();
    }
  }

  function destroy(): void {
    if (!attached) return; // idempotent per facade
    attached = false;
    shared.refCount--;
    if (shared.refCount <= 0) {
      shared.refCount = 0;
      shared.unsubscribe?.();
      shared.unsubscribe = null;
      shared.stream?.disconnect();
      shared.stream = null;
    }
  }

  return {
    mapping: shared.mapping,
    boardLists: shared.boardLists,
    loading: shared.loading,
    saving: shared.saving,
    error: shared.error,
    init,
    destroy,
    refresh: shared.hydrate,
    refetchBoardLists: shared.refetchBoardLists,
    save: shared.save,
  };
}
