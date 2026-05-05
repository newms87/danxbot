import type { ServerResponse } from "http";
import { json } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import { listIssues, readIssueDetail } from "./issues-reader.js";

const log = createLogger("issues-routes");

/**
 * GET /api/issues?repo=<name>&include_closed=<recent|all>
 *
 * Returns the list-card projection (`IssueListItem[]`) of every parseable
 * issue YAML under the named repo's `.danxbot/issues/{open,closed}/` dirs.
 * Auth is handled by the blanket `/api/*` `requireUser` gate in `server.ts`.
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
 * Returns the full Issue with `updated_at: number` (file mtime) injected at
 * the top level. 404 when neither `open/<id>.yml` nor `closed/<id>.yml`
 * exists for the named repo.
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
