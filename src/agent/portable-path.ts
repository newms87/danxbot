/**
 * Portable repo path assertion (DX-230) — runtime guard for the
 * canonical absolute path that git worktree metadata + spawn cwds bake
 * into the filesystem.
 *
 * Background: `git worktree add` runs `realpath()` on its cwd before
 * writing worktree metadata files (`<repo>/.git/worktrees/<name>/gitdir`
 * and `<worktree>/.git`). The container sees the bind-mounted repo at
 * `/danxbot/app/repos/<name>`; the host sees the same dir at e.g.
 * `/home/newms/web/danxbot/repos/<name>`. Worktrees baked in one
 * runtime fatal in the other (`fatal: not a git repository`), so
 * halting an agent in docker and resuming on host (or vice versa)
 * loses access to the agent's branch + uncommitted state.
 *
 * Fix: pick ONE canonical absolute path — the host abs path. On the
 * host the path is real. In the container the per-repo compose.yml
 * adds a SECOND bind mount at the host's abs path (mirror-bind, same
 * source), so both `/danxbot/app/repos/<name>` and the host abs path
 * are real directories pointing at the same files. WorktreeManager +
 * the workspace resolver use the host abs path; git's `realpath()`
 * canonicalizes to that path because no symlinks are involved.
 *
 * A symlink alternative was tried first (DX-230 first iteration) and
 * failed because `realpath()` follows the symlink and writes the
 * underlying real path into worktree metadata, defeating portability.
 *
 * This module asserts that the canonical path exists at runtime so a
 * compose-side mount drift fails loud at worker boot rather than
 * producing broken worktree metadata at first dispatch.
 */

import { statSync } from "node:fs";
import { createLogger } from "../logger.js";

const log = createLogger("portable-path");

/**
 * Single source of truth for the env-var name that carries the
 * canonical repo path from the host into the container. Referenced by
 * `repo-context.ts` (TS), and by mirror in `scripts/worker-env.sh` +
 * each per-repo `compose.yml` (shell/yaml — kept in sync by hand).
 */
export const DANXBOT_REPO_HOST_PATH_ENV = "DANXBOT_REPO_HOST_PATH";

export class PortableRepoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableRepoPathError";
  }
}

/**
 * Assert that the canonical `hostPath` resolves to a real directory in
 * the current runtime. Two cases:
 *
 *   1. `localPath === hostPath` (host runtime): nothing to check —
 *      `localPath` is the canonical path and the worker would have
 *      already failed earlier if it were missing.
 *   2. `localPath !== hostPath` (docker runtime): the per-repo compose
 *      file MUST mirror-bind the host source at `hostPath`. If the
 *      bind is missing, throw `PortableRepoPathError` so the worker
 *      exits non-zero before any dispatch can bake broken metadata.
 *
 * The check is statSync-only; never mutates the filesystem.
 */
export function ensurePortableRepoPath(
  localPath: string,
  hostPath: string,
): void {
  if (localPath === hostPath) {
    return;
  }

  const stat = statIfExists(hostPath);
  if (!stat) {
    throw new PortableRepoPathError(
      `ensurePortableRepoPath: ${hostPath} does not exist inside the container. ` +
        `DANXBOT_REPO_HOST_PATH is set to ${hostPath} but the per-repo compose.yml has no matching mirror-bind volume. ` +
        `Add \`- \${DANXBOT_REPO_ROOT:-../..}:${hostPath}\` to <repo>/.danxbot/config/compose.yml volumes; ` +
        `the helper scripts/worker-env.sh exports DANXBOT_REPO_HOST_PATH=DANXBOT_REPO_ROOT for host-mode launches. ` +
        `See src/agent/portable-path.ts.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new PortableRepoPathError(
      `ensurePortableRepoPath: ${hostPath} exists but is not a directory. Expected a bind-mount source for the repo (host abs path = ${hostPath}, container abs path = ${localPath}).`,
    );
  }
  log.debug(
    `ensurePortableRepoPath: canonical path ${hostPath} OK (mirrored from ${localPath})`,
  );
}

function statIfExists(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
