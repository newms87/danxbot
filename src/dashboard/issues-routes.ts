import type { ServerResponse } from "http";
import { json } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import {
  listIssues,
  readIssueDetail,
  readIssueHistory,
} from "./issues-reader.js";

const log = createLogger("issues-routes");

const HISTORY_DEFAULT_LIMIT = 200;
const HISTORY_MAX_LIMIT = 1000;

/**
 * GET /api/issues?repo=<name>&include_closed=<recent|all>
 *
 * Returns the list-card projection (`IssueListItem[]`) of every Issue
 * mirrored into the `issues` table for the named repo. Auth is handled
 * by the blanket `/api/*` `requireUser` gate in `server.ts`.
 */
export async function handleListIssues(
  res: ServerResponse,
  params: { repo: string | null; includeClosed: string | null },
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!params.repo) {
    json(res, 400, { error: "repo query param is required" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === params.repo);
  if (!repo) {
    json(res, 400, { error: `Unknown repo "${params.repo}"` });
    return;
  }
  const includeClosed: "recent" | "all" =
    params.includeClosed === "all" ? "all" : "recent";
  try {
    const items = await listIssues(repo.localPath, { includeClosed });
    json(res, 200, items);
  } catch (err) {
    log.error(`handleListIssues(${repo.name}) failed`, err);
    json(res, 500, { error: "Failed to list issues" });
  }
}

/**
 * GET /api/issues/:id?repo=<name>
 *
 * Returns the full Issue with `updated_at: number` (mirror timestamp,
 * ms epoch) and `raw_yaml` (canonical serialization of current state)
 * injected at the top level. 404 when no row exists for `(repo_name,
 * id)` in the mirror.
 */
export async function handleGetIssue(
  res: ServerResponse,
  id: string,
  params: { repo: string | null },
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!params.repo) {
    json(res, 400, { error: "repo query param is required" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === params.repo);
  if (!repo) {
    json(res, 400, { error: `Unknown repo "${params.repo}"` });
    return;
  }
  try {
    const detail = await readIssueDetail(repo.localPath, id);
    if (!detail) {
      json(res, 404, { error: `Issue "${id}" not found` });
      return;
    }
    json(res, 200, detail);
  } catch (err) {
    log.error(`handleGetIssue(${repo.name}, ${id}) failed`, err);
    json(res, 500, { error: "Failed to load issue" });
  }
}

/**
 * GET /api/issues/history/:id?repo=<name>&limit=<n>
 *
 * Returns the per-issue change history as ascending RFC 6902 patches.
 * Phase 5 of the Issues DB Mirror epic exposes the `issue_history`
 * table directly — the dashboard's timeline UI is a separate card.
 *
 *   200 { entries: [{ changed_at, source, prev_hash, next_hash, patch }] }
 *   400 — missing repo / unknown repo
 *
 * 200 with `entries: []` is returned both when the issue id is unknown
 * and when the issue exists but has zero recorded patches; either
 * outcome is "nothing to show on the timeline" and the SPA renders the
 * same empty state. Surfacing 404 for unknown ids would force the SPA
 * to discriminate two branches that render identically.
 *
 * `limit` query param: optional, integer in [1, 1000]; defaults to 200.
 */
export async function handleGetIssueHistory(
  res: ServerResponse,
  id: string,
  params: { repo: string | null; limit: string | null },
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!params.repo) {
    json(res, 400, { error: "repo query param is required" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === params.repo);
  if (!repo) {
    json(res, 400, { error: `Unknown repo "${params.repo}"` });
    return;
  }
  let limit = HISTORY_DEFAULT_LIMIT;
  if (params.limit !== null) {
    // `parseInt` accepts trailing garbage ("50abc" → 50). Reject the
    // input loudly when it isn't a clean unsigned integer string —
    // operator typos shouldn't be papered over silently.
    if (!/^\d+$/.test(params.limit)) {
      json(res, 400, { error: "limit must be a positive integer" });
      return;
    }
    const parsed = parseInt(params.limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      json(res, 400, { error: "limit must be a positive integer" });
      return;
    }
    limit = Math.min(parsed, HISTORY_MAX_LIMIT);
  }
  try {
    const entries = await readIssueHistory(repo.localPath, id, { limit });
    json(res, 200, { entries });
  } catch (err) {
    log.error(`handleGetIssueHistory(${repo.name}, ${id}) failed`, err);
    json(res, 500, { error: "Failed to load issue history" });
  }
}
