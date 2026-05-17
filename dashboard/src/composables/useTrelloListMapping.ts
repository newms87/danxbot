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
 * state for the Settings UI's Trello list-mapping panel. Mirrors the
 * `useListColors` shape: per-call instance, opt-in `init()` /
 * `destroy()`, SSE-driven re-render via the canonical `useStream`
 * helper. Per `.claude/rules/dashboard.md`, no `setInterval` — every
 * post-mount update arrives on the `trello-list-map:updated` topic
 * the worker publishes after a successful PATCH.
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
  /** Hydrate from REST + open the SSE subscription. Idempotent. */
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

export function useTrelloListMapping(repo: string): UseTrelloListMappingReturn {
  const mapping = ref<TrelloListMappingResponse | null>(null);
  const boardLists = ref<TrelloListSummary[]>([]);
  const loading = ref<boolean>(false);
  const saving = ref<boolean>(false);
  const error = ref<string | null>(null);

  let stream: UseStreamReturn | null = null;
  let unsubscribe: (() => void) | null = null;

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

  function init(): void {
    if (stream) return; // idempotent — matches useListColors
    stream = useStream();
    unsubscribe = stream.subscribe("trello-list-map:updated", (event) => {
      if (!isMapUpdatedPayload(event.data)) {
        // eslint-disable-next-line no-console
        console.warn(
          "useTrelloListMapping: malformed trello-list-map:updated event",
          event,
        );
        return;
      }
      if (event.data.repoName !== repo) return;
      const prev = mapping.value;
      if (!prev) return;
      mapping.value = { ...prev, map: event.data.map };
    });
    void hydrate();
  }

  function destroy(): void {
    unsubscribe?.();
    unsubscribe = null;
    stream?.disconnect();
    stream = null;
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

  return {
    mapping,
    boardLists,
    loading,
    saving,
    error,
    init,
    destroy,
    refresh: hydrate,
    refetchBoardLists,
    save,
  };
}
