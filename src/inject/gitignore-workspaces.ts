/**
 * DX-340: append danxbot-owned workspace paths to
 * `<repo>/.danxbot/.gitignore` on every inject tick so consumer repos
 * stop tracking files the inject pipeline rewrites every tick.
 *
 * Two writers (git for the committed snapshot, inject for the per-tick
 * render) racing on one filesystem path = guaranteed dirty working tree.
 * A dirty tree breaks `syncWorktree`'s strict `git pull --ff-only`
 * (DX-293), which `dispatchWithRecovery` then escalates to
 * `agents.<name>.broken` quarantine. The fix is on the gitignore side:
 * stop tracking the files inject writes; let inject continue writing
 * them; let git stop seeing them as modified.
 *
 * Universal patterns cover any workspace (templated OR repo-custom)
 * because the rendered scraps are written into every workspace.
 * Per-templated-workspace patterns are derived from
 * `readdirSync("src/inject/workspaces/")` so adding a new templated
 * workspace under that directory auto-grows the rule — no central list
 * to keep in sync.
 *
 * Note: gitignore entries live under `<repo>/.danxbot/.gitignore` which
 * is relative to the `.danxbot/` directory. Patterns use the
 * `workspaces/<name>/...` form (no leading `.danxbot/`).
 */

import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ensureGitignoreEntry } from "../poller/yaml-lifecycle.js";
import { injectDir } from "./_shared/inject-utils.js";

/**
 * Universal patterns — apply to every workspace in
 * `<repo>/.danxbot/workspaces/`, templated or repo-custom. Inject writes
 * these scraps into every workspace via `renderPerRepoFilesIntoWorkspaces`
 * and the shared `worktree-guard.mjs` hook.
 */
const UNIVERSAL_PATTERNS: readonly string[] = [
  "workspaces/*/.claude/rules/danx-*.md",
  "workspaces/*/.claude/hooks/worktree-guard.mjs",
  "workspaces/*/.claude/scheduled_tasks.lock",
  "workspaces/*/.claude/clad.json",
];

/**
 * Per-templated-workspace patterns — applied to each workspace name
 * under `src/inject/workspaces/`. Repo-custom workspaces (e.g.
 * gpt-manager's `schema-builder`) are NOT in this list because the repo
 * owns them end-to-end; inject never writes into a workspace that
 * doesn't have a matching template dir.
 */
const TEMPLATED_WORKSPACE_PATTERNS: readonly string[] = [
  "CLAUDE.md",
  "workspace.yml",
  "workspace-shape.test.ts",
  ".mcp.json",
  ".claude/settings.json",
  ".claude/skills/danx-prep/",
];

/**
 * List templated workspace names. Filters to directories only — the
 * `src/inject/workspaces/` root contains a `workspace-plugin-enablement.test.ts`
 * tombstone file that must NOT be treated as a workspace name.
 */
function listTemplatedWorkspaceNames(): string[] {
  const dir = resolve(injectDir, "workspaces");
  return readdirSync(dir).filter((entry) =>
    statSync(resolve(dir, entry)).isDirectory(),
  );
}

/**
 * Idempotently append danxbot-owned workspace patterns to
 * `<repo>/.danxbot/.gitignore`. Safe to call every inject tick; the
 * underlying `ensureGitignoreEntry` is a no-op on already-present lines.
 */
export function ensureWorkspaceGitignoreEntries(repoLocalPath: string): void {
  for (const pattern of UNIVERSAL_PATTERNS) {
    ensureGitignoreEntry(repoLocalPath, pattern);
  }
  for (const name of listTemplatedWorkspaceNames()) {
    for (const suffix of TEMPLATED_WORKSPACE_PATTERNS) {
      ensureGitignoreEntry(repoLocalPath, `workspaces/${name}/${suffix}`);
    }
  }
}
