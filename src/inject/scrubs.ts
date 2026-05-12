/**
 * Inject pipeline — `danx-*` artifact scrubs.
 *
 * Split out of `src/inject/sync.ts` in DX-319 (which itself extracted
 * the inject pipeline from the pre-DX-220 poller). The scrubs enforce
 * the agent-isolation contract by removing stale `danx-*` files
 * sitting in places that should not retain them:
 *
 *   - Per-workspace `.claude/{rules,skills}/` — handled by the workspace
 *     prune in `./workspaces.ts`, which calls the shared
 *     `scrubDanxArtifacts` helper below.
 *   - Repo-root `.claude/{rules,skills,tools}/` — the developer-owned
 *     territory contract forbids any danxbot-authored `danx-*` file
 *     there.
 *   - Legacy singular `<repo>/.danxbot/workspace/` directory — retired
 *     by the workspace-dispatch epic; remove on every tick.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export const EMPTY_NAME_SET: ReadonlySet<string> = new Set<string>();

/**
 * Shared `danx-*`-artifact scrubber for a `.claude/` root. Used by
 * both the workspace prune (`pruneStaleDanxArtifactsInWorkspace`,
 * scoped to a workspace's target `.claude/`) and the repo-root scrub
 * (`scrubRepoRootDanxArtifacts`, scoped to the developer-owned
 * `<repo>/.claude/`). Centralizing the logic prevents the two from
 * drifting apart on prefix conventions, subdir scope, or failure
 * semantics.
 *
 * For each subdir in `opts.subdirs`:
 *   - Walks `<claudeRootDir>/<sub>/`
 *   - For every direct child whose name starts with `danx-`:
 *     - Keeps it if `opts.keepIfShippedFrom?.(sub)` returns a Set
 *       containing the entry (caller-supplied source-of-truth for
 *       "this name still ships from the inject tree").
 *     - Keeps it if `opts.keepNames?.(sub)` returns a Set containing
 *       the entry (caller-supplied per-name allowlist, e.g. the
 *       per-repo render outputs that this scrubber runs BEFORE the
 *       renderer writes them).
 *     - Otherwise rm-r's it.
 *
 * Fail-loud per CLAUDE.md "Fail loudly" rule: an `rm` failure on a
 * stale `danx-*` artifact means the dispatched agent will load dead
 * config on the next dispatch — exactly the bug this scrubber exists
 * to prevent. Do not swallow the error.
 */
export interface ScrubDanxArtifactsOptions {
  readonly subdirs: readonly string[];
  readonly keepIfShippedFrom?: (sub: string) => ReadonlySet<string>;
  readonly keepNames?: (sub: string) => ReadonlySet<string>;
}

export function scrubDanxArtifacts(
  claudeRootDir: string,
  opts: ScrubDanxArtifactsOptions,
): void {
  for (const sub of opts.subdirs) {
    const dir = resolve(claudeRootDir, sub);
    if (!existsSync(dir)) continue;

    const keepShipped = opts.keepIfShippedFrom?.(sub) ?? EMPTY_NAME_SET;
    const keepWhitelist = opts.keepNames?.(sub) ?? EMPTY_NAME_SET;

    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith("danx-")) continue;
      if (keepShipped.has(entry)) continue;
      if (keepWhitelist.has(entry)) continue;
      rmSync(resolve(dir, entry), { recursive: true, force: true });
    }
  }
}

/**
 * Remove the legacy singular `<repo>/.danxbot/workspace/` dir created
 * by the retired `generateWorkspace` helper. Pre-refactor this dir was
 * the dispatched-agent cwd; post-refactor every dispatch resolves a
 * plural workspace under `<repo>/.danxbot/workspaces/<name>/` and the
 * singular dir is dead weight that shadows nothing but still confuses
 * humans grepping the tree. Idempotent — absent dir is a no-op.
 */
export function scrubLegacySingularWorkspace(repoLocalPath: string): void {
  const dir = resolve(repoLocalPath, ".danxbot/workspace");
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Remove any `danx-*` files at `<repo>/.claude/{rules,skills,tools}/`.
 * The repo-root `.claude/` is strictly developer-owned per the
 * agent-isolation contract; any `danx-*` file there is either (a) a
 * leftover from a pre-isolation poller version, or (b) someone's
 * misguided attempt to override workspace config. Both cause the
 * exact bug this scrub exists to prevent: claude's ancestor walk
 * finds the repo-root copy, loads stale data, and the agent dispatches
 * with wrong board IDs / repo config.
 *
 * Scope is intentionally narrow — only the `danx-*` prefix, only the
 * three subdirs (`rules/`, `skills/`, `tools/`). Nothing else under
 * `<repo>/.claude/` is touched.
 *
 * Fail-loud per CLAUDE.md "Fail loudly" rule: a swallowed `rm` error
 * here would leave stale `danx-*` config in repo-root, which is the
 * exact bug this scrubber exists to prevent.
 */
export function scrubRepoRootDanxArtifacts(repoLocalPath: string): void {
  scrubDanxArtifacts(resolve(repoLocalPath, ".claude"), {
    subdirs: ["rules", "skills", "tools"],
  });
}
