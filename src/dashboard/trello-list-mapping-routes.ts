/**
 * DX-610 (Phase 8b.2 of DX-575) — Dashboard REST surface for the
 * operator-configured Trello list mapping. Reads + writes the per-repo
 * `<repo>/.danxbot/trello-list-map.yaml` shipped by 8b.1, and proxies
 * the Trello "list this board's lists" call so the Settings UI in
 * Phase 8b.3 can render the pair-with picker.
 *
 * Routes:
 *   GET   /api/trello/board-lists?repo=<name>     — proxy Trello board lists (cached 30s/repo)
 *   GET   /api/trello/list-mapping?repo=<name>    — combined {map, classification}
 *   PATCH /api/trello/list-mapping?repo=<name>    — write a new map
 *
 * Auth-gated by the operator bearer like the Lists routes (DX-583).
 * Successful PATCH publishes `trello-list-map:updated` on the SSE bus.
 *
 * Cred source: dashboard-side `DASHBOARD_TRELLO_API_KEY` /
 * `DASHBOARD_TRELLO_API_TOKEN`. The per-repo `DANX_TRELLO_API_*` pair
 * stays inside the worker container; the dashboard process never
 * reads it. See `.claude/rules/docker-runtime.md`.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { requireUser } from "./auth-middleware.js";
import { eventBus } from "./event-bus.js";
import { readLists } from "../lists-file.js";
import { loadTrelloIds } from "../poller/constants.js";
import {
  TrelloListMapValidationError,
  classifyTrelloListMapping,
  readTrelloListMap,
  writeTrelloListMap,
  type ClassifiedTrelloMapping,
  type TrelloListMap,
} from "../trello-list-map.js";
import {
  TrelloApiError,
  fetchBoardLists,
  getTrelloCreds,
  type TrelloListSummary,
} from "./trello-api.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

const log = createLogger("trello-list-mapping-routes");

const BOARD_LIST_CACHE_TTL_MS = 30_000;

interface BoardListCacheEntry {
  fetchedAt: number;
  lists: TrelloListSummary[];
}

const boardListCache = new Map<string, BoardListCacheEntry>();

/** Visible for tests — bypass the cache between cases. */
export function _resetBoardListCache(): void {
  boardListCache.clear();
}

function resolveRepo(
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): { name: string; localPath: string } | null {
  if (!repoQuery) {
    json(res, 400, { error: "Missing required query param: repo" });
    return null;
  }
  const match = deps.repos.find((r) => r.name === repoQuery);
  if (!match) {
    json(res, 404, { error: `Repo "${repoQuery}" is not configured` });
    return null;
  }
  return { name: match.name, localPath: match.localPath };
}

async function requireAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function readBoardId(repoLocalPath: string): string | null {
  try {
    const ids = loadTrelloIds(repoLocalPath);
    return ids.boardId || null;
  } catch (err) {
    log.warn(`readBoardId(${repoLocalPath}) failed`, err);
    return null;
  }
}

interface FetchOptions {
  /** Bypass the 30s cache (Settings UI refresh button). */
  bypassCache?: boolean;
}

/**
 * Internal helper — read Trello board lists with the 30s per-repo
 * cache in front. Returns one of three shapes the route layer can
 * branch on directly without re-running the cred / config checks.
 */
type FetchBoardListsRouteOutcome =
  | { kind: "ok"; lists: TrelloListSummary[] }
  | { kind: "no-board" }
  | { kind: "no-creds" }
  | { kind: "trello-error"; status: number | null; message: string };

async function fetchBoardListsForRepo(
  repoName: string,
  repoLocalPath: string,
  opts: FetchOptions = {},
): Promise<FetchBoardListsRouteOutcome> {
  const boardId = readBoardId(repoLocalPath);
  if (!boardId) return { kind: "no-board" };
  const creds = getTrelloCreds();
  if (!creds) return { kind: "no-creds" };
  if (!opts.bypassCache) {
    const cached = boardListCache.get(repoName);
    if (cached && Date.now() - cached.fetchedAt < BOARD_LIST_CACHE_TTL_MS) {
      return { kind: "ok", lists: cached.lists };
    }
  }
  try {
    const lists = await fetchBoardLists(boardId, creds);
    boardListCache.set(repoName, { fetchedAt: Date.now(), lists });
    return { kind: "ok", lists };
  } catch (err) {
    // Stale-cache fallback: a transient Trello outage flipping every
    // previously-mapped list to "orphaned" in the SPA is worse than
    // serving the last-known board snapshot (operator's view of
    // classification stays stable; the next successful tick or
    // operator refresh refreshes the cache). The board-lists route
    // still surfaces the upstream error directly so the operator's
    // refresh button gets honest feedback.
    const cached = boardListCache.get(repoName);
    if (cached) return { kind: "ok", lists: cached.lists };
    if (err instanceof TrelloApiError) {
      return { kind: "trello-error", status: err.trelloStatus, message: err.message };
    }
    return {
      kind: "trello-error",
      status: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleGetBoardLists(
  req: IncomingMessage,
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!(await requireAuth(req, res))) return;
  const repo = resolveRepo(res, repoQuery, deps);
  if (!repo) return;
  const outcome = await fetchBoardListsForRepo(repo.name, repo.localPath);
  switch (outcome.kind) {
    case "ok":
      json(res, 200, { lists: outcome.lists });
      return;
    case "no-board":
      json(res, 503, { error: "Trello board is not configured for this repo" });
      return;
    case "no-creds":
      json(res, 503, {
        error:
          "Dashboard Trello credentials are not configured (set DASHBOARD_TRELLO_API_KEY + DASHBOARD_TRELLO_API_TOKEN)",
      });
      return;
    case "trello-error":
      json(res, 502, { error: outcome.message, trello_status: outcome.status });
      return;
  }
}

export async function handleGetListMapping(
  req: IncomingMessage,
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!(await requireAuth(req, res))) return;
  const repo = resolveRepo(res, repoQuery, deps);
  if (!repo) return;
  const map = readTrelloListMap(repo.localPath);
  const danxbotLists = readLists(repo.localPath).lists.map((l) => ({ id: l.id }));
  // Best-effort: if Trello creds / board absent, fall back to an empty
  // trello list so classification still returns `unmapped` /
  // `orphaned` correctly (everything mapped becomes orphaned since no
  // Trello list is present, which matches the operator's view that
  // their mapping cannot resolve yet). The route is read-only so we
  // do NOT 503 here; the SPA only blocks on PATCH.
  const outcome = await fetchBoardListsForRepo(repo.name, repo.localPath);
  const trelloLists: TrelloListSummary[] = outcome.kind === "ok" ? outcome.lists : [];
  const classification: Record<string, ClassifiedTrelloMapping> =
    classifyTrelloListMapping(danxbotLists, trelloLists, map);
  json(res, 200, {
    map,
    classification,
    trello_available: outcome.kind === "ok",
  });
}

export async function handlePatchListMapping(
  req: IncomingMessage,
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!(await requireAuth(req, res))) return;
  const repo = resolveRepo(res, repoQuery, deps);
  if (!repo) return;
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  let map: TrelloListMap;
  try {
    map = parseMap(body);
  } catch (err) {
    if (err instanceof TrelloListMapValidationError) {
      json(res, 400, { errors: err.errors });
      return;
    }
    throw err;
  }
  const knownDanxbotListIds = new Set(
    readLists(repo.localPath).lists.map((l) => l.id),
  );
  try {
    const written = await writeTrelloListMap(repo.localPath, map, knownDanxbotListIds);
    eventBus.publish({
      topic: "trello-list-map:updated",
      data: { repoName: repo.name, map: written },
    });
    json(res, 200, { map: written });
  } catch (err) {
    if (err instanceof TrelloListMapValidationError) {
      json(res, 400, { errors: err.errors });
      return;
    }
    log.error(`handlePatchListMapping(${repo.name}) failed`, err);
    json(res, 500, { error: err instanceof Error ? err.message : "Write failed" });
  }
}

function parseMap(body: Record<string, unknown>): TrelloListMap {
  const raw = (body as { map?: unknown }).map;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TrelloListMapValidationError(["map must be an object"]);
  }
  const inner = (raw as { list_id_to_trello_list_id?: unknown }).list_id_to_trello_list_id;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    throw new TrelloListMapValidationError([
      "map.list_id_to_trello_list_id must be an object",
    ]);
  }
  const errors: string[] = [];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inner as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) {
      errors.push(`key ${JSON.stringify(k)} must be a non-empty string`);
      continue;
    }
    if (typeof v !== "string" || v.length === 0) {
      errors.push(
        `list_id_to_trello_list_id[${JSON.stringify(k)}] must be a non-empty string`,
      );
      continue;
    }
    out[k] = v;
  }
  if (errors.length > 0) throw new TrelloListMapValidationError(errors);
  return { list_id_to_trello_list_id: out };
}
