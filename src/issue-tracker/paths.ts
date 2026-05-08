/**
 * Pure path helpers for the per-issue YAML on-disk layout. Lives in
 * `src/issue-tracker/` (not `src/poller/`) so tracker-layer modules
 * (`sync.ts`, `retry-queue.ts`) can compute paths without an upward
 * dependency into the poller.
 *
 * `src/poller/yaml-lifecycle.ts` re-exports these for backwards-
 * compatibility — every existing caller continues to import from
 * yaml-lifecycle without churn, while new tracker-layer callers go
 * through this module directly.
 *
 * No filesystem state is read or written here; only path strings. Tests
 * import the module without paying any env-validation tax.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type IssueState = "open" | "closed";

/**
 * Absolute path to the YAML file for an issue in a given lifecycle state.
 * Filename basename is the internal `id` (`ISS-N`), not the external_id.
 */
export function issuePath(
  repoLocalPath: string,
  id: string,
  state: IssueState,
): string {
  return resolve(
    repoLocalPath,
    ".danxbot",
    "issues",
    state,
    `${id}.yml`,
  );
}

/**
 * Create the `<repo>/.danxbot/issues/{open,closed}/` dirs if missing.
 * Idempotent — silent no-op when both already exist.
 */
export function ensureIssuesDirs(repoLocalPath: string): void {
  mkdirSync(resolve(repoLocalPath, ".danxbot", "issues", "open"), {
    recursive: true,
  });
  mkdirSync(resolve(repoLocalPath, ".danxbot", "issues", "closed"), {
    recursive: true,
  });
}
