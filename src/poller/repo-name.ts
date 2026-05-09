/**
 * Phase 4 of the Issues DB Mirror epic (DX-151 / DX-155).
 *
 * The DB-backed YAML readers (`loadLocal`, `findByExternalId`,
 * `listDispatchableYamls`, etc. in `local-issues.ts`, `yaml-lifecycle.ts`,
 * `epic-status.ts`) keep their `repoLocalPath` first argument for caller
 * compatibility but query the `issues` table by `repo_name`. This module
 * maps `repoLocalPath -> repo_name`.
 *
 * Production: worker boot calls `setRepoName(ctx.localPath, ctx.name)`
 * once per `RepoContext`. Subsequent reads via `repoNameFromPath` resolve
 * to the registered name.
 *
 * Tests: register explicitly via `setRepoName` (or rely on the basename
 * fallback when the test repo's directory name happens to match the
 * intended `repo_name`).
 *
 * Fallback: `basename(repoLocalPath)`. Production never hits this path
 * because the worker boot registers every repo before the poller dispatches.
 * The fallback exists so unit tests of helpers that don't bother
 * registering still get a deterministic answer (matching tmpdir basename).
 */

import { basename, resolve } from "node:path";

const repoNamesByPath = new Map<string, string>();

/**
 * Register a repo's canonical name for a given local path. Idempotent —
 * calling twice with the same name is a no-op; calling with a different
 * name overwrites (caller's responsibility to pass a stable value).
 */
export function setRepoName(repoLocalPath: string, name: string): void {
  repoNamesByPath.set(resolve(repoLocalPath), name);
}

/**
 * Drop a registration. Used by tests + by the worker shutdown path.
 */
export function clearRepoName(repoLocalPath: string): void {
  repoNamesByPath.delete(resolve(repoLocalPath));
}

/**
 * Drop ALL registrations. Test-only — preserves isolation between
 * suites that register the same path with different names.
 */
export function clearAllRepoNames(): void {
  repoNamesByPath.clear();
}

/**
 * Resolve the repo name for a given local path. Falls back to the path's
 * basename when no registration exists (test path; production always
 * registers).
 */
export function repoNameFromPath(repoLocalPath: string): string {
  const resolved = resolve(repoLocalPath);
  const registered = repoNamesByPath.get(resolved);
  if (registered) return registered;
  return basename(resolved);
}
