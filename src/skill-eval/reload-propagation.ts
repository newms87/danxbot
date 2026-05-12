/**
 * Reload-propagation sanity check.
 *
 * After committing + pushing the new description to the plugin source
 * repo, the dispatched workspaces still read SKILL.md from the
 * marketplace CACHE at `~/.claude/plugins/marketplaces/<name>/`. That
 * cache is a separate git checkout of the same upstream — it does not
 * auto-update.
 *
 * `reloadAndVerify` is the iteration loop's sanity-check probe: it
 * `git pull --ff-only`s the cache repo, then re-reads the cached
 * SKILL.md and asserts the description on disk matches what we just
 * pushed. If they drift (because the push hasn't propagated to the
 * upstream the cache is tracking, or because the cache repo has
 * diverging local commits), the next iteration's eval-set would
 * measure the OLD description — silently invalidating every verdict.
 * We bail loudly instead.
 *
 * No `/reload-plugins` slash command is invoked here — that command is
 * a CC session affordance, not a CLI primitive. Pulling the cache repo
 * is the equivalent operation and works from any process.
 */

import { existsSync, readFileSync } from "node:fs";
import { getDescription } from "./description-editor.js";

export type ReloadStage = "pull" | "read" | "verify";

export class ReloadPropagationError extends Error {
  constructor(
    message: string,
    public readonly stage: ReloadStage,
  ) {
    super(message);
    this.name = "ReloadPropagationError";
  }
}

export interface GitExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly cmd: string;
  readonly args: readonly string[];
}

export type GitExecFn = (
  cmd: string,
  args: readonly string[],
) => Promise<GitExecResult>;

export interface ReloadVerifyArgs {
  readonly cacheRepoRoot: string;
  readonly cacheSkillPath: string;
  readonly expectedDescription: string;
}

export interface ReloadVerifyResult {
  readonly cacheDescription: string;
}

export async function reloadAndVerify(
  args: ReloadVerifyArgs,
  exec: GitExecFn,
): Promise<ReloadVerifyResult> {
  const pull = await exec("git", [
    "-C",
    args.cacheRepoRoot,
    "pull",
    "--ff-only",
  ]);
  if (pull.exitCode !== 0) {
    throw new ReloadPropagationError(
      `git pull --ff-only in ${args.cacheRepoRoot} failed (exit ${pull.exitCode}): ${pull.stderr.trim() || pull.stdout.trim() || "<no output>"}`,
      "pull",
    );
  }

  if (!existsSync(args.cacheSkillPath)) {
    throw new ReloadPropagationError(
      `cache SKILL.md missing after pull: ${args.cacheSkillPath} — marketplace layout drift`,
      "read",
    );
  }

  let content: string;
  try {
    content = readFileSync(args.cacheSkillPath, "utf8");
  } catch (e) {
    throw new ReloadPropagationError(
      `could not read cache SKILL.md ${args.cacheSkillPath}: ${(e as Error).message}`,
      "read",
    );
  }

  let cacheDescription: string;
  try {
    cacheDescription = getDescription(content);
  } catch (e) {
    throw new ReloadPropagationError(
      `cache SKILL.md ${args.cacheSkillPath} did not parse: ${(e as Error).message}`,
      "read",
    );
  }

  if (cacheDescription !== args.expectedDescription) {
    throw new ReloadPropagationError(
      `reload propagation drift: cache SKILL.md description does NOT match pushed value — got ${JSON.stringify(cacheDescription.slice(0, 120))}, expected ${JSON.stringify(args.expectedDescription.slice(0, 120))}. The pushed commit has not reached the marketplace cache; re-run after the cache catches up.`,
      "verify",
    );
  }

  return { cacheDescription };
}
