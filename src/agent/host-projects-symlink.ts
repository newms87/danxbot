/**
 * Host-mode JSONL projects-dir symlink (DX-240) — share Claude Code session
 * logs across host + docker runtimes so `claude --resume <sessionId>` and
 * SessionLogWatcher attach work after a runtime swap.
 *
 * Background: docker workers bind `<repo>/claude-projects/` at
 * `/home/danxbot/.claude/projects/`, so docker-mode JSONL files materialize
 * under the per-repo dir. Host-mode dispatches default to
 * `${HOME}/.claude/projects/`, a different physical dir. DX-230 made the spawn
 * cwd portable across runtimes (mirror-bind), so the encoded-cwd subdir name
 * is identical in both runtimes — only the parent dir differs.
 *
 * Fix: on every host-mode dispatch, ensure
 * `${HOME}/.claude/projects/<encoded>` is a symlink pointing at
 * `<repo>/claude-projects/<encoded>`. Both runtimes then converge on the same
 * physical file. The docker bind is unchanged.
 *
 * Idempotent. Handles four preexisting states at the symlink path:
 *   1. Nothing → mkdir parents + symlink.
 *   2. Correct symlink → no-op.
 *   3. Wrong-target symlink → unlink + recreate.
 *   4. Real dir → migrate JSONL contents into per-repo dir, rmdir, then symlink.
 *
 * Failure modes are loud:
 *   - A regular file at the symlink path is rejected (claude only ever creates
 *     dirs/symlinks there; a file is unexpected and we won't clobber it).
 *   - A migration with same-named files in BOTH dirs is rejected pre-flight —
 *     same filename across runtimes implies divergent session state that needs
 *     human resolution. Pre-flight means the rejection happens BEFORE any
 *     `renameSync` runs, so the dirs never end up half-migrated.
 *   - The workspace cwd MUST live under the repo's local path; a mismatch
 *     throws (defends against future workspace path-shape drift in callers).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createLogger } from "../logger.js";
import { encodeClaudeProjectsCwd } from "./session-log-watcher.js";

const log = createLogger("host-projects-symlink");

/**
 * The per-repo dir that's bind-mounted into docker workers as
 * `/home/danxbot/.claude/projects/`. Single source of truth for the path
 * shape so docker compose, the dashboard path resolver, and this helper
 * stay in lockstep.
 */
export function perRepoProjectsBase(repoLocalPath: string): string {
  return join(repoLocalPath, "claude-projects");
}

export interface EnsureHostProjectsSymlinkOptions {
  /** Workspace cwd (e.g. `<repo>/.danxbot/workspaces/<name>`). */
  workspaceCwd: string;
  /** Per-repo local path — the same dir docker compose binds claude-projects from. */
  repoLocalPath: string;
  /** Override `homedir()` for tests. */
  homeDir?: string;
}

export function ensureHostProjectsSymlink(
  options: EnsureHostProjectsSymlinkOptions,
): void {
  const { workspaceCwd, repoLocalPath } = options;
  const home = options.homeDir ?? homedir();

  // Resolve workspaceCwd ONCE so encoding + invariant check use the same
  // string. realpath via the shared encoder also closes the drift-with-watcher
  // concern: SessionLogWatcher.deriveSessionDir runs the same encoder.
  const resolvedWorkspaceCwd = realpathIfExists(workspaceCwd);
  const resolvedRepoLocalPath = realpathIfExists(repoLocalPath);

  // Fail-loud invariant: the workspace MUST live under the repo's root the
  // caller passed. If a future workspace path shape (e.g. nested workspaces)
  // ever causes the caller's repoLocalPath derivation to miscount, this
  // catches the mismatch before clobbering host fs.
  if (
    !resolvedWorkspaceCwd.startsWith(resolvedRepoLocalPath + sep) &&
    resolvedWorkspaceCwd !== resolvedRepoLocalPath
  ) {
    throw new Error(
      `ensureHostProjectsSymlink: workspaceCwd (${resolvedWorkspaceCwd}) does not live under repoLocalPath (${resolvedRepoLocalPath}). ` +
        `The two arguments must be consistent — the workspace cwd is expected to be a descendant of the repo root the docker bind originates from.`,
    );
  }

  const encoded = encodeClaudeProjectsCwd(resolvedWorkspaceCwd);
  const perRepoDir = join(perRepoProjectsBase(repoLocalPath), encoded);
  const hostProjectsDir = join(home, ".claude", "projects");
  const hostLink = join(hostProjectsDir, encoded);

  mkdirSync(perRepoDir, { recursive: true });
  mkdirSync(hostProjectsDir, { recursive: true });

  const preexisting = lstatIfExists(hostLink);
  if (preexisting) {
    if (preexisting.isSymbolicLink()) {
      const currentTarget = readlinkSync(hostLink);
      if (currentTarget === perRepoDir) {
        return;
      }
      log.info(
        `ensureHostProjectsSymlink: replacing wrong-target symlink at ${hostLink} (was=${currentTarget}, want=${perRepoDir})`,
      );
      unlinkSync(hostLink);
    } else if (preexisting.isDirectory()) {
      const migratedCount = migrateDirContents(hostLink, perRepoDir);
      if (migratedCount > 0) {
        log.info(
          `ensureHostProjectsSymlink: migrated ${migratedCount} entries from ${hostLink} → ${perRepoDir}`,
        );
      }
      rmdirSync(hostLink);
    } else {
      throw new Error(
        `ensureHostProjectsSymlink: ${hostLink} exists but is neither a directory nor a symlink — refusing to clobber. ` +
          `claude only writes dirs/symlinks here; investigate the file manually before retrying.`,
      );
    }
  }

  symlinkSync(perRepoDir, hostLink);
  log.debug(`ensureHostProjectsSymlink: ${hostLink} → ${perRepoDir}`);
}

function realpathIfExists(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Move every entry from `srcDir` into `dstDir`. Pre-flight phase scans both
 * dirs, computes the conflict set, and throws with a single combined error
 * message before any `renameSync` runs — so a partial-migration state can
 * never appear on disk. Returns the count of moved entries.
 */
function migrateDirContents(srcDir: string, dstDir: string): number {
  const entries = readdirSync(srcDir);
  const conflicts = entries.filter((entry) =>
    existsSync(join(dstDir, entry)),
  );
  if (conflicts.length > 0) {
    throw new Error(
      `ensureHostProjectsSymlink: cannot migrate ${srcDir} → ${dstDir}: ${conflicts.length} ` +
        `destination entr${conflicts.length === 1 ? "y" : "ies"} already exist (${conflicts.join(", ")}). ` +
        `This is divergent session state across runtimes — inspect both dirs and resolve manually ` +
        `(typically: rm whichever copy is older) before retrying the dispatch.`,
    );
  }

  for (const entry of entries) {
    renameSync(join(srcDir, entry), join(dstDir, entry));
  }
  return entries.length;
}
