/**
 * Iteration orchestrator — the propose-fix-retest loop.
 *
 * Mirrors Anthropic's skill-creator `run_loop` algorithm but routes the
 * description-proposal step through this repo's Haiku call and the
 * eval-set step through `runEvalSetCore` (host-mode dispatch via the
 * local danxbot worker — bypasses Anthropic bugs #36570 and #556 the
 * skill-creator's `claude -p` runner trips on).
 *
 * Algorithm:
 *
 *   1. Run eval-set against current description.
 *   2. If train + test both ≥ 95%: GREEN.
 *   3. If iteration count ≥ maxIterations: stop with MAX_ITERATIONS.
 *   4. If accumulated cost + estimated next-iter cost > costCapUsd: stop with COST_CAP.
 *   5. Track best test score across iterations (overfitting defense:
 *      proposer sees train failures only; "best" is held-out test).
 *   6. Ask proposer for a new description from train failures.
 *   7. Validate the diff is description-only.
 *   8. Write source SKILL.md, commit + push, reload-verify cache.
 *   9. Loop.
 *
 *   On stop, if the FINAL iteration's test score regressed below the best
 *   seen, restore the best description (one extra commit + push).
 *
 * Every dependency is injected — `runEvalSet` (for the eval-set sweep),
 * `proposer` (for the Haiku call), `gitCommitPush`, `reloadAndVerify`,
 * `readFile` / `writeFile` — so the orchestrator's iteration logic is
 * tested without touching the network, the filesystem, or git.
 */

import type { QueryVerdict } from "./aggregate.js";
import {
  DescriptionEditError,
  getDescription,
  replaceDescription,
  validateDiff,
} from "./description-editor.js";
import type {
  ProposerFn,
  TrainFailure,
} from "./description-proposer.js";
import type {
  CommitDescriptionArgs,
  CommitDescriptionResult,
  GitExecFn,
  GitExecResult,
} from "./plugin-git.js";
import type {
  ReloadVerifyArgs,
  ReloadVerifyResult,
} from "./reload-propagation.js";

export const HARD_MAX_ITERATIONS = 8;
const PASS_THRESHOLD = 0.95;

export class IterateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IterateError";
  }
}

export interface IterationEvalSummary {
  readonly trainAccuracy: number;
  readonly testAccuracy: number;
  readonly trainVerdicts: readonly QueryVerdict[];
  readonly testVerdicts: readonly QueryVerdict[];
  readonly totalCostUsd: number;
  readonly reportMarkdown: string;
}

export type RunEvalSetCallback = () => Promise<IterationEvalSummary>;

export interface IterateArgs {
  readonly pluginSkill: string;
  readonly sourceSkillPath: string;
  readonly cacheSkillPath: string;
  readonly sourceRepoRoot: string;
  readonly cacheRepoRoot: string;
  readonly relativeSkillPath: string;
  readonly maxIterations: number;
  readonly costCapUsd: number;
}

export interface IterateDeps {
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  runEvalSet: RunEvalSetCallback;
  proposer: ProposerFn;
  gitCommitPush: (
    args: CommitDescriptionArgs,
    exec: GitExecFn,
  ) => Promise<CommitDescriptionResult>;
  reloadAndVerify: (
    args: ReloadVerifyArgs,
    exec: GitExecFn,
  ) => Promise<ReloadVerifyResult>;
  gitExec: GitExecFn;
}

export type IterationStatus =
  | "initial"
  | "propose-applied"
  | "stop-green"
  | "stop-max-iterations"
  | "stop-cost-cap"
  | "stop-fatal";

export interface IterationRecord {
  readonly iteration: number;
  readonly trainAccuracy: number;
  readonly testAccuracy: number;
  readonly costUsd: number;
  readonly description: string;
  readonly status: IterationStatus;
  readonly commitSha?: string;
  readonly proposerError?: string;
  readonly reloadError?: string;
  readonly editError?: string;
}

export interface IterateResult {
  readonly status:
    | "green"
    | "max-iterations"
    | "cost-cap"
    | "fatal-error";
  readonly iterations: readonly IterationRecord[];
  readonly bestIteration: number;
  readonly bestTestAccuracy: number;
  readonly finalDescription: string;
  readonly totalCostUsd: number;
  readonly rolledBackTo?: number;
  /**
   * Populated when the orchestrator attempted a best-iteration rollback
   * but the rollback commit/push/reload sequence threw. The regressed
   * description from the loop body is still on the branch — operator
   * must restore manually. Surfaces in `formatIterateReport` so the
   * markdown output is loud about the partial state.
   */
  readonly rollbackError?: string;
}

function extractTrainFailures(
  trainVerdicts: readonly QueryVerdict[],
): TrainFailure[] {
  const out: TrainFailure[] = [];
  for (const v of trainVerdicts) {
    if (v.correct) continue;
    out.push({
      query: v.query.query,
      expected: v.query.shouldTrigger ? "trigger" : "no-trigger",
      observed: v.triggered ? "trigger" : "no-trigger",
    });
  }
  return out;
}

function isPass(summary: IterationEvalSummary): boolean {
  return (
    summary.trainAccuracy >= PASS_THRESHOLD &&
    summary.testAccuracy >= PASS_THRESHOLD
  );
}

async function commitDescriptionUpdate(
  args: IterateArgs,
  iteration: number,
  newSourceContent: string,
  newDescription: string,
  deps: IterateDeps,
): Promise<{ sha: string }> {
  deps.writeFile(args.sourceSkillPath, newSourceContent);
  const commit = await deps.gitCommitPush(
    {
      sourceRepoRoot: args.sourceRepoRoot,
      relativeSkillPath: args.relativeSkillPath,
      pluginSkill: args.pluginSkill,
      iteration,
    },
    deps.gitExec,
  );
  await deps.reloadAndVerify(
    {
      cacheRepoRoot: args.cacheRepoRoot,
      cacheSkillPath: args.cacheSkillPath,
      expectedDescription: newDescription,
    },
    deps.gitExec,
  );
  return { sha: commit.sha };
}

export async function iterate(
  args: IterateArgs,
  deps: IterateDeps,
): Promise<IterateResult> {
  if (!Number.isInteger(args.maxIterations) || args.maxIterations < 1) {
    throw new IterateError(
      `maxIterations must be a positive integer (got ${args.maxIterations})`,
    );
  }
  if (args.maxIterations > HARD_MAX_ITERATIONS) {
    throw new IterateError(
      `maxIterations=${args.maxIterations} exceeds HARD_MAX_ITERATIONS=${HARD_MAX_ITERATIONS} (anti-runaway cap)`,
    );
  }

  const iterations: IterationRecord[] = [];
  let totalCostUsd = 0;

  // Iteration 0 — initial measurement against unchanged description.
  let currentSourceContent = deps.readFile(args.sourceSkillPath);
  let currentDescription = getDescription(currentSourceContent);
  const initial = await deps.runEvalSet();
  totalCostUsd += initial.totalCostUsd;
  iterations.push({
    iteration: 0,
    trainAccuracy: initial.trainAccuracy,
    testAccuracy: initial.testAccuracy,
    costUsd: initial.totalCostUsd,
    description: currentDescription,
    status: isPass(initial) ? "stop-green" : "initial",
  });

  if (isPass(initial)) {
    return finalize("green", iterations, totalCostUsd, currentDescription, args, deps);
  }

  let bestIteration = 0;
  let bestTestAccuracy = initial.testAccuracy;
  let bestDescription = currentDescription;
  let bestSourceContent = currentSourceContent;
  let lastSummary = initial;

  for (let i = 1; i <= args.maxIterations; i++) {
    // Cost-cap check BEFORE issuing the next eval-set sweep. Estimate
    // the next iteration's cost as the running average of every
    // completed iteration (initial + applied proposals). When all
    // observed costs are zero, the average is zero and the cap never
    // trips — that is intentional: a 0-cost run signals nothing was
    // spent (e.g. local stub) so there is no budget to enforce, and
    // the loop is still bounded by `maxIterations`.
    const avgIterCost = totalCostUsd / iterations.length;
    if (totalCostUsd + avgIterCost > args.costCapUsd) {
      return finalize(
        "cost-cap",
        iterations,
        totalCostUsd,
        currentDescription,
        args,
        deps,
        bestIteration,
        bestDescription,
        bestSourceContent,
        bestTestAccuracy,
      );
    }

    // ---- Propose ----
    let proposed: string;
    try {
      const trainFailures = extractTrainFailures(lastSummary.trainVerdicts);
      const result = await deps.proposer({
        pluginSkill: args.pluginSkill,
        currentDescription,
        trainFailures,
        attempt: i,
      });
      proposed = result.newDescription;
      if (proposed === currentDescription) {
        iterations.push({
          iteration: i,
          trainAccuracy: lastSummary.trainAccuracy,
          testAccuracy: lastSummary.testAccuracy,
          costUsd: 0,
          description: currentDescription,
          status: "stop-fatal",
          proposerError:
            "proposer returned a description identical to the current one (no change to commit)",
        });
        return finalize(
          "fatal-error",
          iterations,
          totalCostUsd,
          currentDescription,
          args,
          deps,
          bestIteration,
          bestDescription,
          bestSourceContent,
          bestTestAccuracy,
        );
      }
    } catch (e) {
      iterations.push({
        iteration: i,
        trainAccuracy: lastSummary.trainAccuracy,
        testAccuracy: lastSummary.testAccuracy,
        costUsd: 0,
        description: currentDescription,
        status: "stop-fatal",
        proposerError: (e as Error).message,
      });
      return finalize(
        "fatal-error",
        iterations,
        totalCostUsd,
        currentDescription,
        args,
        deps,
        bestIteration,
        bestDescription,
        bestSourceContent,
        bestTestAccuracy,
      );
    }

    // ---- Apply (description-only diff enforcement) ----
    let newSourceContent: string;
    try {
      newSourceContent = replaceDescription(currentSourceContent, proposed);
      validateDiff(currentSourceContent, newSourceContent);
    } catch (e) {
      const msg =
        e instanceof DescriptionEditError
          ? `${e.category}: ${e.message}`
          : (e as Error).message;
      iterations.push({
        iteration: i,
        trainAccuracy: lastSummary.trainAccuracy,
        testAccuracy: lastSummary.testAccuracy,
        costUsd: 0,
        description: currentDescription,
        status: "stop-fatal",
        editError: msg,
      });
      return finalize(
        "fatal-error",
        iterations,
        totalCostUsd,
        currentDescription,
        args,
        deps,
        bestIteration,
        bestDescription,
        bestSourceContent,
        bestTestAccuracy,
      );
    }

    // ---- Commit + push + reload-verify ----
    let sha: string;
    try {
      const commit = await commitDescriptionUpdate(
        args,
        i,
        newSourceContent,
        proposed,
        deps,
      );
      sha = commit.sha;
    } catch (e) {
      iterations.push({
        iteration: i,
        trainAccuracy: lastSummary.trainAccuracy,
        testAccuracy: lastSummary.testAccuracy,
        costUsd: 0,
        description: proposed,
        status: "stop-fatal",
        reloadError: (e as Error).message,
      });
      return finalize(
        "fatal-error",
        iterations,
        totalCostUsd,
        currentDescription,
        args,
        deps,
        bestIteration,
        bestDescription,
        bestSourceContent,
        bestTestAccuracy,
      );
    }

    // ---- Re-eval ----
    currentDescription = proposed;
    currentSourceContent = newSourceContent;
    const summary = await deps.runEvalSet();
    totalCostUsd += summary.totalCostUsd;
    lastSummary = summary;

    iterations.push({
      iteration: i,
      trainAccuracy: summary.trainAccuracy,
      testAccuracy: summary.testAccuracy,
      costUsd: summary.totalCostUsd,
      description: proposed,
      status: isPass(summary) ? "stop-green" : "propose-applied",
      commitSha: sha,
    });

    if (summary.testAccuracy > bestTestAccuracy) {
      bestTestAccuracy = summary.testAccuracy;
      bestIteration = i;
      bestDescription = proposed;
      bestSourceContent = newSourceContent;
    }

    if (isPass(summary)) {
      return finalize(
        "green",
        iterations,
        totalCostUsd,
        currentDescription,
        args,
        deps,
        bestIteration,
        bestDescription,
        bestSourceContent,
        bestTestAccuracy,
      );
    }
  }

  // Reached maxIterations without hitting green — stop normally.
  return finalize(
    "max-iterations",
    iterations,
    totalCostUsd,
    currentDescription,
    args,
    deps,
    bestIteration,
    bestDescription,
    bestSourceContent,
    bestTestAccuracy,
  );
}

async function finalize(
  status: IterateResult["status"],
  iterations: IterationRecord[],
  totalCostUsd: number,
  finalDescription: string,
  args: IterateArgs,
  deps: IterateDeps,
  bestIteration = 0,
  bestDescription: string = finalDescription,
  bestSourceContent?: string,
  bestTestAccuracy?: number,
): Promise<IterateResult> {
  // Rollback only when:
  //   - status is "max-iterations" or "cost-cap" (we stopped without
  //     hitting green — there is something to potentially restore)
  //   - the last iteration is NOT the best (final regressed below
  //     some earlier best)
  //   - we have the best source content captured (defensive)
  const lastIdx = iterations.length - 1;
  const shouldRollBack =
    (status === "max-iterations" || status === "cost-cap") &&
    bestIteration !== lastIdx &&
    bestSourceContent !== undefined &&
    bestDescription !== finalDescription;

  let rolledBackTo: number | undefined;
  let rollbackError: string | undefined;
  if (shouldRollBack && bestSourceContent) {
    try {
      deps.writeFile(args.sourceSkillPath, bestSourceContent);
      await deps.gitCommitPush(
        {
          sourceRepoRoot: args.sourceRepoRoot,
          relativeSkillPath: args.relativeSkillPath,
          pluginSkill: args.pluginSkill,
          iteration: 0,                              // valid integer (gates require ≥ 0)
          rollbackToIteration: bestIteration,       // distinguishes the commit shape
        },
        deps.gitExec,
      );
      await deps.reloadAndVerify(
        {
          cacheRepoRoot: args.cacheRepoRoot,
          cacheSkillPath: args.cacheSkillPath,
          expectedDescription: bestDescription,
        },
        deps.gitExec,
      );
      rolledBackTo = bestIteration;
      finalDescription = bestDescription;
    } catch (e) {
      // The propose / commit / reload chain ALREADY pushed the regressed
      // description in the loop body. The rollback is a best-effort
      // restore — if it fails (push rejected, marketplace pull conflict),
      // the operator must intervene manually. We surface the failure in
      // the result's rollbackError field rather than rejecting the whole
      // run; the per-iteration history is still useful even when the
      // restore failed.
      rollbackError = (e as Error).message;
    }
  }

  return {
    status,
    iterations,
    bestIteration,
    bestTestAccuracy: bestTestAccuracy ?? iterations[0]?.testAccuracy ?? 0,
    finalDescription,
    totalCostUsd,
    rolledBackTo,
    rollbackError,
  };
}

// Type-only re-export — keeps the public type signature clean for callers
// that import `iterate` without needing the internal git-exec types.
export type { GitExecResult };
