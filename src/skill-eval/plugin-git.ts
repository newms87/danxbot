/**
 * Plugin-repo git driver.
 *
 * Commits + pushes a single SKILL.md description edit at the plugin
 * source repo (default `~/web/claude-plugins/`). One commit per
 * iteration, with a deterministic message shape so the operator can
 * `git log --grep "skill-eval iter"` and walk every proposal made by
 * the harness.
 *
 * Side effects are confined to the four `git` invocations sequenced
 * below. The caller injects `exec` so unit tests can assert the exact
 * argv + sequence WITHOUT touching a real git repo.
 *
 * Failure handling is intentionally fail-loud: any non-zero git exit
 * aborts the iteration with the stderr text wrapped in
 * `PluginGitError`. The orchestrator surfaces the error in the
 * iteration report and exits non-zero — we never paper over a failed
 * push because the next iteration would silently measure the OLD
 * description.
 */

export class PluginGitError extends Error {
  constructor(
    message: string,
    public readonly stage: "add" | "commit" | "rev-parse" | "push" | "args",
  ) {
    super(message);
    this.name = "PluginGitError";
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

export interface CommitDescriptionArgs {
  readonly sourceRepoRoot: string;
  readonly relativeSkillPath: string;
  readonly pluginSkill: string;
  readonly iteration: number;
  /**
   * When set, this commit is the orchestrator's rollback to a prior best
   * iteration — the commit message reflects "rollback to iter N" instead
   * of the propose-and-tighten shape. Validation is otherwise identical.
   */
  readonly rollbackToIteration?: number;
}

export interface CommitDescriptionResult {
  readonly sha: string;
}

function buildCommitMessage(args: CommitDescriptionArgs): string {
  if (args.rollbackToIteration !== undefined) {
    return `skill-eval rollback to iter ${args.rollbackToIteration}: restore best ${args.pluginSkill} description`;
  }
  return `skill-eval iter ${args.iteration}: tighten ${args.pluginSkill} description`;
}

async function runStage(
  exec: GitExecFn,
  stage: PluginGitError["stage"],
  cmdArgs: readonly string[],
): Promise<GitExecResult> {
  const result = await exec("git", cmdArgs);
  if (result.exitCode !== 0) {
    throw new PluginGitError(
      `git ${stage} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "<no output>"}`,
      stage,
    );
  }
  return result;
}

export async function commitAndPushDescription(
  args: CommitDescriptionArgs,
  exec: GitExecFn,
): Promise<CommitDescriptionResult> {
  if (!args.sourceRepoRoot) {
    throw new PluginGitError("sourceRepoRoot is required", "args");
  }
  if (!args.relativeSkillPath) {
    throw new PluginGitError("relativeSkillPath is required", "args");
  }
  if (!Number.isInteger(args.iteration) || args.iteration < 0) {
    throw new PluginGitError(
      `iteration must be a non-negative integer (got ${args.iteration})`,
      "args",
    );
  }
  if (
    args.rollbackToIteration !== undefined &&
    (!Number.isInteger(args.rollbackToIteration) ||
      args.rollbackToIteration < 0)
  ) {
    throw new PluginGitError(
      `rollbackToIteration must be a non-negative integer (got ${args.rollbackToIteration})`,
      "args",
    );
  }

  await runStage(exec, "add", [
    "-C",
    args.sourceRepoRoot,
    "add",
    "--",
    args.relativeSkillPath,
  ]);

  await runStage(exec, "commit", [
    "-C",
    args.sourceRepoRoot,
    "commit",
    "-m",
    buildCommitMessage(args),
  ]);

  const revParse = await runStage(exec, "rev-parse", [
    "-C",
    args.sourceRepoRoot,
    "rev-parse",
    "HEAD",
  ]);
  const sha = revParse.stdout.trim();
  if (!sha) {
    throw new PluginGitError(
      "git rev-parse returned empty output — cannot identify the commit just made",
      "rev-parse",
    );
  }

  // `git push origin HEAD` is the safer canonical form vs. bare
  // `git push` — bare push relies on `push.default` config in the
  // source repo, which on a detached HEAD (or `push.default = nothing`)
  // exits opaquely. Explicit `origin HEAD` always pushes the current
  // branch's tip to the same-named branch on origin.
  await runStage(exec, "push", [
    "-C",
    args.sourceRepoRoot,
    "push",
    "origin",
    "HEAD",
  ]);

  return { sha };
}
