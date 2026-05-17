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
import { getDefaultListForType, readLists } from "../lists-file.js";
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
  createList,
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
  options: { refresh?: boolean } = {},
): Promise<void> {
  if (!(await requireAuth(req, res))) return;
  const repo = resolveRepo(res, repoQuery, deps);
  if (!repo) return;
  const outcome = await fetchBoardListsForRepo(repo.name, repo.localPath, {
    bypassCache: options.refresh === true,
  });
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
    // SPA reads this to hide the Settings panel entirely when no board
    // is wired up for the repo (Phase 8b.3). `trello_available` collapses
    // both "no board" and "creds missing / Trello down" into one signal;
    // operators with a configured board still want the panel visible
    // when Trello is transiently unreachable.
    board_configured: outcome.kind !== "no-board",
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

/**
 * DX-620 — POST /api/trello/list-mapping/bootstrap-backlog?repo=<name>.
 *
 * One-click affordance for the Settings UI when the operator's Trello
 * board has no list paired with the danxbot `archived`-type default
 * (seeded as "Backlog"). Creates a "Backlog" list on the board at
 * position `bottom`, persists the mapping, publishes the SSE topic.
 *
 * Three terminal outcomes the SPA branches on (all 200):
 *  - `{status: "created", trello_list_id, trello_list_name}` — new list
 *    materialized + mapping written.
 *  - `{status: "already-mapped", trello_list_id}` — the archived default
 *    already had a non-empty entry in the map. Idempotent against
 *    operator double-clicks.
 *  - `{status: "name-conflict", trello_list_id, trello_list_name, message}`
 *    — a list already exists on the board with the danxbot list's name
 *    (case-insensitive). The route deliberately does NOT auto-pair —
 *    the operator may have meant a different list. Surfaces a "use the
 *    dropdown to map the existing list" message instead.
 *
 * Failure cases:
 *  - 503 when no Trello board configured / dashboard creds missing
 *    (matches the GET routes' shape).
 *  - 502 when Trello upstream rejects the create (carries the upstream
 *    status when available).
 */
export async function handlePostBootstrapBacklog(
  req: IncomingMessage,
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!(await requireAuth(req, res))) return;
  const repo = resolveRepo(res, repoQuery, deps);
  if (!repo) return;

  // Resolve the danxbot archived-type default list. `readLists` throws
  // on a broken lists.yaml; let it bubble — the dashboard global error
  // handler renders a 500 rather than papering over a corrupt file.
  let archived;
  try {
    archived = getDefaultListForType(repo.localPath, "archived");
  } catch (err) {
    log.error(`bootstrap-backlog: no archived default in lists.yaml`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Idempotent guard — operator double-click / SPA stale-state. Read
  // BEFORE touching Trello so a transient creds outage doesn't surface
  // 503 when the work is already done.
  const map = readTrelloListMap(repo.localPath);
  const existing = map.list_id_to_trello_list_id[archived.id];
  if (typeof existing === "string" && existing.length > 0) {
    json(res, 200, { status: "already-mapped", trello_list_id: existing });
    return;
  }

  // Board + creds gates. Mirror the GET routes' shape so the SPA's
  // error rendering is consistent.
  const boardId = readBoardId(repo.localPath);
  if (!boardId) {
    json(res, 503, { error: "Trello board is not configured for this repo" });
    return;
  }
  const creds = getTrelloCreds();
  if (!creds) {
    json(res, 503, {
      error:
        "Dashboard Trello credentials are not configured (set DASHBOARD_TRELLO_API_KEY + DASHBOARD_TRELLO_API_TOKEN)",
    });
    return;
  }

  // Name-conflict probe. Force a fresh fetch (bypass the 30s cache) so
  // operators rotating board state see the live shape — the SPA is
  // about to mutate the board, so up-to-date inputs matter.
  let boardLists: TrelloListSummary[];
  try {
    boardLists = await fetchBoardLists(boardId, creds);
    boardListCache.set(repo.name, { fetchedAt: Date.now(), lists: boardLists });
  } catch (err) {
    if (err instanceof TrelloApiError) {
      json(res, 502, { error: err.message, trello_status: err.trelloStatus });
      return;
    }
    json(res, 502, {
      error: err instanceof Error ? err.message : String(err),
      trello_status: null,
    });
    return;
  }
  const want = archived.name.trim().toLowerCase();
  const conflict = boardLists.find((l) => l.name.trim().toLowerCase() === want);
  if (conflict) {
    json(res, 200, {
      status: "name-conflict",
      trello_list_id: conflict.id,
      trello_list_name: conflict.name,
      message:
        `A Trello list named "${conflict.name}" already exists on this board. ` +
        `Use the list-mapping dropdown to pair it with the danxbot "${archived.name}" list — ` +
        `bootstrap will not duplicate the name.`,
    });
    return;
  }

  // Create on Trello, then persist the mapping.
  let created: TrelloListSummary;
  try {
    created = await createList(boardId, archived.name, creds, { pos: "bottom" });
  } catch (err) {
    if (err instanceof TrelloApiError) {
      json(res, 502, { error: err.message, trello_status: err.trelloStatus });
      return;
    }
    json(res, 502, {
      error: err instanceof Error ? err.message : String(err),
      trello_status: null,
    });
    return;
  }

  // Read-then-merge with the same last-writer-wins semantics PATCH has:
  // the on-disk map is the source of truth; the read at this point may
  // race a concurrent PATCH between the read and `writeTrelloListMap`'s
  // lock acquisition (PATCH has the same window). The window is narrow
  // and operator-level concurrent edits are vanishingly rare in practice;
  // a future tightening would move the read+merge inside the write lock.
  const fresh = readTrelloListMap(repo.localPath);
  const merged: TrelloListMap = {
    list_id_to_trello_list_id: {
      ...fresh.list_id_to_trello_list_id,
      [archived.id]: created.id,
    },
  };
  const knownDanxbotListIds = new Set(
    readLists(repo.localPath).lists.map((l) => l.id),
  );
  let written: TrelloListMap;
  try {
    written = await writeTrelloListMap(repo.localPath, merged, knownDanxbotListIds);
  } catch (err) {
    if (err instanceof TrelloListMapValidationError) {
      // Defensive — would only fire if lists.yaml mutated between the
      // archived lookup and the validator (operator deleted the list
      // mid-request). The Trello list was created but cannot be persisted;
      // surface the validation errors so the operator can re-pair via
      // the dropdown.
      json(res, 409, { errors: err.errors, trello_list_id: created.id });
      return;
    }
    log.error(
      `bootstrap-backlog(${repo.name}): write failed after Trello list created`,
      err,
    );
    json(res, 500, {
      error: err instanceof Error ? err.message : "Write failed",
      trello_list_id: created.id,
    });
    return;
  }

  // Invalidate the cache so the next GET reflects the new list without
  // waiting 30s, and notify SSE subscribers (Settings panel's
  // `useTrelloListMapping` re-renders the badges).
  boardListCache.delete(repo.name);
  eventBus.publish({
    topic: "trello-list-map:updated",
    data: { repoName: repo.name, map: written },
  });
  json(res, 200, {
    status: "created",
    trello_list_id: created.id,
    trello_list_name: created.name,
  });
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
