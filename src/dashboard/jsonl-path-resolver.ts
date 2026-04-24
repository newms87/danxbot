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

import { stat } from "node:fs/promises";
import { workspacePath } from "../workspace/generate.js";
import type { Dispatch } from "./dispatches.js";

/**
 * Base directory under which per-repo claude-projects dirs are mounted.
 * Must match `CONTAINER_CLAUDE_PROJECTS_BASE` in `src/cli/dev-compose-override.ts`
 * and the prod compose entries in `deploy/templates/docker-compose.prod.yml`.
 */
export const DASHBOARD_CLAUDE_PROJECTS_BASE = "/danxbot/app/claude-projects";

/** Prefix of native worker JSONL paths (worker-internal view). */
const WORKER_PROJECTS_PREFIX = "/home/danxbot/.claude/projects/";

/**
 * Encode a dispatched agent's CWD to the directory-name form Claude Code uses.
 * Claude Code stores sessions at `~/.claude/projects/<encoded-cwd>/`, where
 * the encoded form replaces BOTH `/` and `.` with `-`. Verified empirically
 * against on-disk entries like `-danxbot-app-repos-danxbot--danxbot-workspace`
 * — the leading `.` of the `.danxbot` segment becomes the second dash of
 * the `--danxbot` run. Must stay in lockstep with `deriveSessionDir` in
 * `src/agent/session-log-watcher.ts`.
 *
 * Deriving from `workspacePath` rather than hardcoding the literal means a
 * future change to `WORKSPACE_SUBDIR` or the `.danxbot/` segment updates
 * every consumer (launcher spawn, resume lookup, this encoder) in lockstep.
 *
 * NOTE: In the dashboard container `getReposBase()` resolves to
 * `/danxbot/app/repos` (either via `DANXBOT_REPOS_BASE` or the project-root
 * fallback) so the encoded dir comes out as
 * `-danxbot-app-repos-<name>--danxbot-workspace` — the exact name claude
 * writes to under `~/.claude/projects/` in the worker container.
 *
 * Host-mode workers dispatch from `<real-checkout>/.danxbot/workspace`, so
 * their encoded dir differs. `resolveJsonlPath` strategies 1+2 handle
 * host-mode dispatches via the stored absolute path; strategy 3 (this path)
 * may compute a dir that doesn't exist on disk for host-mode and returns
 * null — that is acceptable because strategy 3 is only a fallback.
 */
export function encodeRepoCwd(repoName: string): string {
  return workspacePath(repoName).replace(/[/.]/g, "-");
}

/**
 * Compute the deterministic dashboard path for a JSONL file given the repo
 * name and the Claude session UUID (the JSONL filename stem).
 */
export function computeDashboardJsonlPath(
  repoName: string,
  sessionUuid: string,
): string {
  return `${DASHBOARD_CLAUDE_PROJECTS_BASE}/${repoName}/${encodeRepoCwd(repoName)}/${sessionUuid}.jsonl`;
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
 * Derive the expected JSONL path without checking filesystem existence.
 * Used by `handleStream` in `stream-routes.ts` to pre-validate
 * `dispatch:jsonl:<id>` topics even before the agent has created the file
 * (the per-topic watcher retries until the file appears).
 *
 * Resolution order:
 *  1. If `jsonlPath` is a worker-internal path → translate it.
 *  2. If `jsonlPath` is some other path (host-mode) → return as-is.
 *  3. If only `sessionUuid` is known → compute deterministically.
 *  4. Otherwise → null.
 */
export function expectedJsonlPath(
  dispatch: Pick<Dispatch, "jsonlPath" | "sessionUuid" | "repoName">,
): string | null {
  if (dispatch.jsonlPath) {
    const translated = translateWorkerPath(dispatch.jsonlPath, dispatch.repoName);
    return translated ?? dispatch.jsonlPath;
  }
  if (dispatch.sessionUuid) {
    return computeDashboardJsonlPath(dispatch.repoName, dispatch.sessionUuid);
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
    // Strategy 1: stored path directly (host-mode)
    if (await existsFn(dispatch.jsonlPath)) return dispatch.jsonlPath;

    // Strategy 2: translate worker path to per-repo dashboard mount
    const translated = translateWorkerPath(dispatch.jsonlPath, dispatch.repoName);
    if (translated && (await existsFn(translated))) return translated;
  }

  // Strategy 3: deterministic computation from sessionUuid
  if (dispatch.sessionUuid) {
    const computed = computeDashboardJsonlPath(dispatch.repoName, dispatch.sessionUuid);
    if (await existsFn(computed)) return computed;
  }

  return null;
}
