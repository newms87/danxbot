/**
 * Projects-dir preflight — Trello cjAyJpgr-followup.
 *
 * Sister of `claude-auth-preflight.ts`. Same failure shape (silent dispatch
 * timeout) caused by a different broken-bind class:
 *
 *   `~/.claude/projects/` (the dir claude writes session JSONL into) is
 *   bound from `<repo>/claude-projects/` on the host. When Docker
 *   auto-creates the host source as `root:root` (e.g. when the OLD
 *   `${CLAUDE_PROJECTS_DIR:?...}` env-var-driven mount resolved to a
 *   non-existent path on first compose-up), the container `danxbot` user
 *   (UID 1000) cannot write to it. claude `-p` silently fails to write
 *   JSONL → SessionLogWatcher never attaches → `session_uuid` and
 *   `jsonl_path` stay NULL in MySQL → dashboard returns empty timelines.
 *
 * Verified empirically against gpt-manager + platform workers on 2026-04-26:
 *
 *   docker exec -u danxbot danxbot-worker-<repo> \
 *     touch /home/danxbot/.claude/projects/probe
 *   # → Permission denied
 *
 * After `chown -R 1000:1000 <bind-source>` the same probe succeeds and a
 * real `/api/launch` populates the DB row + writes JSONL + the dashboard
 * endpoint returns the timeline.
 *
 * This preflight runs alongside `preflightClaudeAuth` in `spawnAgent` so
 * the dispatch fails LOUD at launch with an actionable summary instead of
 * silently waiting out the inactivity timeout. Cost: one `access(W_OK)`
 * call — well under 1ms.
 */

import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProjectsDirFailureReason = "missing" | "readonly" | "unreachable";

export type ProjectsDirResult =
  | { ok: true }
  | { ok: false; reason: ProjectsDirFailureReason; summary: string };

export interface ProjectsDirOptions {
  /**
   * Path to the projects directory. Defaults to
   * `${homedir()}/.claude/projects`. Tests inject a temp path; the worker
   * runs claude as the `danxbot` user whose `$HOME` is `/home/danxbot`,
   * so the default resolves to `/home/danxbot/.claude/projects` inside
   * the container — exactly the path bound from
   * `<repo>/claude-projects/` on the host.
   */
  projectsDir?: string;
}

function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * Verify the dir exists AND is writable by the current user. Symlinks are
 * followed: `fs.access(W_OK)` checks the target's permissions, which is
 * exactly what we need — the bind source on the host is the writable
 * inode that claude actually mutates.
 *
 * Distinguishes ENOENT (the dir was never created at all — different
 * problem from the perms class) from EACCES/EPERM (the dir exists but is
 * not writable — the original cjAyJpgr-followup class). Anything else is
 * reported as "unreachable" with the underlying error message.
 */
export async function preflightProjectsDir(
  opts: ProjectsDirOptions = {},
): Promise<ProjectsDirResult> {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  try {
    await access(projectsDir, fsConstants.W_OK);
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        reason: "missing",
        summary: `Projects dir ${projectsDir} does not exist — check that <repo>/claude-projects is mounted at /home/danxbot/.claude/projects in compose.yml`,
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        ok: false,
        reason: "readonly",
        summary: `Projects dir ${projectsDir} is not writable by the worker — chown the bind source on the host to UID 1000 (e.g. \`docker exec -u root <worker> chown -R 1000:1000 /home/danxbot/.claude/projects\`)`,
      };
    }
    return {
      ok: false,
      reason: "unreachable",
      summary: `Projects dir ${projectsDir} is unreachable: ${(err as Error).message}`,
    };
  }
}

/**
 * Throw-shaped wrapper for callers that prefer typed errors over union
 * results. Used by `spawnAgent` so `dispatch.ts` can `catch
 * (ProjectsDirError)` and map to a 503 response — same shape as
 * `ClaudeAuthError`. External dispatchers see a single concise reason
 * instead of "Agent timed out after N seconds of inactivity".
 */
export class ProjectsDirError extends Error {
  readonly reason: ProjectsDirFailureReason;
  constructor(result: Extract<ProjectsDirResult, { ok: false }>) {
    super(result.summary);
    this.name = "ProjectsDirError";
    this.reason = result.reason;
  }
}
