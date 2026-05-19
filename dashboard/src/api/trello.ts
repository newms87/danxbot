import type {
  ClassifiedTrelloMapping,
  TrelloListMap,
  TrelloListSummary,
} from "../types";
import { jsonRequest } from "./_request";

// DX-611 (Phase 8b.3) — Trello list mapping.

/**
 * `map` seeds dropdowns, `classification` drives per-row badges,
 * `trello_available` toggles the "Trello unreachable" banner,
 * `board_configured` hides the panel when no board id is wired in
 * `trello.yml`.
 */
export interface TrelloListMappingResponse {
  map: TrelloListMap;
  classification: Record<string, ClassifiedTrelloMapping>;
  trello_available: boolean;
  board_configured: boolean;
}

export interface TrelloBoardListsResponse {
  lists: TrelloListSummary[];
}

export async function fetchTrelloListMapping(
  repo: string,
): Promise<TrelloListMappingResponse> {
  return jsonRequest(
    "GET",
    `/api/trello/list-mapping?repo=${encodeURIComponent(repo)}`,
  );
}

/**
 * `refresh: true` appends `refresh=1` so the route bypasses the 30s
 * server-side cache. Trello-unreachable / no-creds surfaces as 502/503
 * carrying `{error, trello_status?}` (rendered inline via ToggleError).
 */
export async function fetchTrelloBoardLists(
  repo: string,
  options: { refresh?: boolean } = {},
): Promise<TrelloListSummary[]> {
  const params = new URLSearchParams({ repo });
  if (options.refresh) params.set("refresh", "1");
  const body = await jsonRequest<TrelloBoardListsResponse>(
    "GET",
    `/api/trello/board-lists?${params.toString()}`,
  );
  return body.lists;
}

/**
 * Server validates against known danxbot list ids + atomically writes
 * under the per-repo lock + publishes `trello-list-map:updated` on SSE.
 * Returns the post-write map so the writing tab reconciles without
 * waiting for SSE.
 */
export async function patchTrelloListMapping(
  repo: string,
  map: TrelloListMap,
): Promise<TrelloListMap> {
  const body = await jsonRequest<{ map: TrelloListMap }>(
    "PATCH",
    `/api/trello/list-mapping?repo=${encodeURIComponent(repo)}`,
    { map },
  );
  return body.map;
}

/**
 * DX-620 — one-click bootstrap when the archived-type danxbot list
 * (default "Backlog") is unmapped. Idempotent + non-destructive:
 *  - `created`         → new Trello list materialized + mapping persisted
 *  - `already-mapped`  → archived default already has a non-empty entry
 *  - `name-conflict`   → list exists with that name; surface dropdown hint
 *
 * 503 = no board configured / dashboard creds missing. 502 = Trello
 * upstream rejected the probe or create call.
 */
export type BootstrapBacklogResponse =
  | { status: "created"; trello_list_id: string; trello_list_name: string }
  | { status: "already-mapped"; trello_list_id: string }
  | {
      status: "name-conflict";
      trello_list_id: string;
      trello_list_name: string;
      message: string;
    };

export async function bootstrapBacklogTrelloList(
  repo: string,
): Promise<BootstrapBacklogResponse> {
  return jsonRequest(
    "POST",
    `/api/trello/list-mapping/bootstrap-backlog?repo=${encodeURIComponent(repo)}`,
  );
}
