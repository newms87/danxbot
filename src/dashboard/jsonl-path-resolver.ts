/**
 * Resolve the filesystem path where a dispatch's JSONL file is accessible
 * inside the dashboard container.
 *
 * Context
 * -------
 * Each connected repo's worker container writes Claude Code session logs to
 * `/home/danxbot/.claude/projects/` (the worker-internal path). The path that
 * `dispatch-tracker.ts` stores in the DB reflects this worker-internal path.
 *
 * The dashboard container can NOT reach `/home/danxbot/.claude/projects/`
 * because each repo's worker has its own isolated container. Instead, the
 * per-repo override in `docker-compose.override.yml` mounts each repo's
 * `claude-projects/` directory into the dashboard at a namespaced path:
 *
 *   ./repos/<name>/claude-projects  →  /danxbot/app/claude-projects/<name>  (RO)
 *
 * This module translates stored worker paths to dashboard-accessible paths
 * and falls back to deterministic path computation when the stored path is
 * null or unreachable.
 */

import { readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { Dispatch } from "./dispatches.js";

/**
 * Base directory under which per-repo claude-projects dirs are mounted.
 * Must match `CONTAINER_CLAUDE_PROJECTS_BASE` in `src/cli/dev-compose-override.ts`
 * and the prod compose entries in `deploy/templates/docker-compose.prod.yml`.
 */
export const DASHBOARD_CLAUDE_PROJECTS_BASE = "/danxbot/app/claude-projects";

/**
 * Dashboard-internal mount point for host-mode dispatches' JSONL logs.
 *
 * Host-mode workers run on the developer's host (not in a container) and
 * write to the developer's own `~/.claude/projects/` — under encoded
 * subdirs reflecting the host filesystem layout (e.g.
 * `-home-newms-web-gpt-manager--danxbot-workspaces-issue-worker/`). Those
 * subdirs are NOT inside any per-repo `claude-projects/` symlink and are
 * therefore invisible through `DASHBOARD_CLAUDE_PROJECTS_BASE`.
 *
 * `dev-compose-override.ts` mounts the developer's `${HOME}/.claude/projects`
 * here so `translateHostPath` can rewrite stored host paths into
 * dashboard-accessible paths.
 *
 * Must match `CONTAINER_HOST_CLAUDE_PROJECTS_BASE` in
 * `src/cli/dev-compose-override.ts`.
 */
export const DASHBOARD_HOST_CLAUDE_PROJECTS_BASE =
  "/danxbot/app/host-claude-projects";

/** Prefix of native worker JSONL paths (worker-internal view). */
const WORKER_PROJECTS_PREFIX = "/home/danxbot/.claude/projects/";

/**
 * Match `<anything>/.claude/projects/<rest>` and capture `<rest>`. Used to
 * translate host-mode JSONL paths regardless of which user `~` resolves to
 * — the dashboard container does NOT know the developer's host username,
 * so we anchor on the structural `/.claude/projects/` segment instead.
 */
const HOST_PROJECTS_RE = /\/\.claude\/projects\/(.+)$/;

/**
 * Enumerate plausible dashboard JSONL paths for a dispatch by scanning
 * the per-repo claude-projects mount. Each dispatched agent cwds into
 * `<repo>/.danxbot/workspaces/<name>/`, so claude writes JSONL under
 * `~/.claude/projects/<encoded-workspace-cwd>/<sessionUuid>.jsonl` —
 * with one subdirectory per distinct cwd. Strategy 3 used to compute
 * a single deterministic path from the singular workspace literal;
 * post-workspace-dispatch there is no longer a single canonical
 * encoded dir per repo, so we walk the per-repo mount and return one
 * candidate per subdirectory.
 *
 * Only used as a fallback when the stored `jsonlPath` is null/stale —
 * normal hits go through strategies 1 + 2 in `resolveJsonlPath`.
 */
export function dashboardJsonlCandidates(
  repoName: string,
  sessionUuid: string,
): string[] {
  const repoBase = `${DASHBOARD_CLAUDE_PROJECTS_BASE}/${repoName}`;
  let entries: string[];
  try {
    entries = readdirSync(repoBase);
  } catch {
    return [];
  }
  return entries.map((entry) =>
    resolvePath(repoBase, entry, `${sessionUuid}.jsonl`),
  );
}

/**
 * Translate a worker-internal path to the dashboard-accessible equivalent.
 * Returns `null` when the path does not start with the known worker prefix
 * (e.g. host-mode paths or already-translated paths pass through unchanged).
 */
export function translateWorkerPath(
  workerPath: string,
  repoName: string,
): string | null {
  if (!workerPath.startsWith(WORKER_PROJECTS_PREFIX)) return null;
  const rest = workerPath.slice(WORKER_PROJECTS_PREFIX.length);
  return `${DASHBOARD_CLAUDE_PROJECTS_BASE}/${repoName}/${rest}`;
}

/**
 * Translate a host-mode JSONL path (anywhere under `<some-home>/.claude/projects/`)
 * to the dashboard-accessible mount at `DASHBOARD_HOST_CLAUDE_PROJECTS_BASE`.
 *
 * Returns `null` when the path does not contain the structural
 * `/.claude/projects/` segment (e.g. malformed paths). The dashboard
 * container does NOT know the developer's host username, so we anchor
 * on the literal segment rather than `${HOME}`.
 *
 * **Order-dependence (CRITICAL):** the regex `HOST_PROJECTS_RE` ALSO
 * matches the worker-internal prefix `/home/danxbot/.claude/projects/…`
 * because both layouts share the same `/.claude/projects/<rest>` shape.
 * Callers MUST try `translateWorkerPath` BEFORE this function — both
 * `expectedJsonlPath` and `resolveJsonlPath` enforce that order. A
 * future caller that flips the order silently routes worker paths to
 * the host-claude-projects mount (where they don't exist) and breaks
 * the docker-mode dashboard timeline.
 */
export function translateHostPath(hostPath: string): string | null {
  const m = HOST_PROJECTS_RE.exec(hostPath);
  if (!m) return null;
  return `${DASHBOARD_HOST_CLAUDE_PROJECTS_BASE}/${m[1]}`;
}

/**
 * Derive the expected JSONL path without checking filesystem existence.
 * Used by `handleStream` in `stream-routes.ts` to pre-validate
 * `dispatch:jsonl:<id>` topics even before the agent has created the file
 * (the per-topic watcher retries until the file appears).
 *
 * Resolution order:
 *  1. If `jsonlPath` is a worker-internal path → translate it to the
 *     per-repo dashboard mount.
 *  2. If `jsonlPath` is a host-mode path (`<host_home>/.claude/projects/...`)
 *     → translate it to the host-claude-projects dashboard mount.
 *  3. If `jsonlPath` is some other path → return as-is. Note this
 *     return is only statable when the dashboard runs on the host
 *     (e.g. `make launch-dashboard-host`); a containerized dashboard
 *     receiving an arbitrary host absolute path will fail to read it.
 *  4. If only `sessionUuid` is known → compute deterministically from
 *     the per-workspace candidate scan.
 *  5. Otherwise → null.
 *
 * Lockstep with `resolveJsonlPath`: both functions try worker-translate
 * before host-translate (see `translateHostPath` order-dependence note).
 * A divergence in branch order would silently break the SSE pre-validation
 * path that consumes `expectedJsonlPath`.
 */
export function expectedJsonlPath(
  dispatch: Pick<Dispatch, "jsonlPath" | "sessionUuid" | "repoName">,
): string | null {
  if (dispatch.jsonlPath) {
    const workerTranslated = translateWorkerPath(
      dispatch.jsonlPath,
      dispatch.repoName,
    );
    if (workerTranslated) return workerTranslated;
    const hostTranslated = translateHostPath(dispatch.jsonlPath);
    if (hostTranslated) return hostTranslated;
    return dispatch.jsonlPath;
  }
  if (dispatch.sessionUuid) {
    const [first] = dashboardJsonlCandidates(
      dispatch.repoName,
      dispatch.sessionUuid,
    );
    return first ?? null;
  }
  return null;
}

/** Default filesystem existence check — real `stat` call. */
async function defaultExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the first EXISTING JSONL path for a dispatch.
 * Tries strategies in order, performing an existence check for each candidate:
 *
 *  1. Stored `jsonlPath` directly (covers host-mode dispatches where the path
 *     is directly accessible via the host-projects mount).
 *  2. `translateWorkerPath` result (covers docker-worker dispatches — the
 *     stored path `/home/danxbot/.claude/projects/...` maps to the per-repo
 *     dashboard mount at `/danxbot/app/claude-projects/<repoName>/...`).
 *  3. `computeDashboardJsonlPath` from `sessionUuid` (covers rows where
 *     `jsonlPath` is null or stale but `sessionUuid` was recorded).
 *
 * Returns `null` when no accessible file is found.
 *
 * The optional `existsFn` parameter lets callers substitute a mock for testing
 * without relying on the real filesystem or module-level spying.
 */
export async function resolveJsonlPath(
  dispatch: Pick<Dispatch, "jsonlPath" | "sessionUuid" | "repoName">,
  existsFn: (p: string) => Promise<boolean> = defaultExists,
): Promise<string | null> {
  if (dispatch.jsonlPath) {
    // Strategy 1: stored path directly (host-mode dashboard hits this when
    // the dashboard runs on the host alongside the worker — the path the
    // worker recorded is identical to the path the dashboard can `stat`).
    // Lockstep with `expectedJsonlPath` step 3: both functions return the
    // raw path when neither translator matches and the path is reachable.
    if (await existsFn(dispatch.jsonlPath)) return dispatch.jsonlPath;

    // Strategy 2: translate worker path to per-repo dashboard mount
    // (docker-mode worker, dashboard reads via per-repo claude-projects bind).
    const workerTranslated = translateWorkerPath(
      dispatch.jsonlPath,
      dispatch.repoName,
    );
    if (workerTranslated && (await existsFn(workerTranslated))) {
      return workerTranslated;
    }

    // Strategy 2b: translate host-mode path to host-claude-projects mount
    // (host-mode worker writes to the developer's `~/.claude/projects/`,
    // docker-mode dashboard reads via the single `${HOME}/.claude/projects`
    // bind installed by `dev-compose-override.ts`).
    const hostTranslated = translateHostPath(dispatch.jsonlPath);
    if (hostTranslated && (await existsFn(hostTranslated))) {
      return hostTranslated;
    }
  }

  // Strategy 3: enumerate plausible per-workspace paths from sessionUuid
  if (dispatch.sessionUuid) {
    for (const candidate of dashboardJsonlCandidates(
      dispatch.repoName,
      dispatch.sessionUuid,
    )) {
      if (await existsFn(candidate)) return candidate;
    }
  }

  return null;
}
