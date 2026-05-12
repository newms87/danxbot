#!/usr/bin/env -S npx tsx
/**
 * `--all` sweep CLI for the skill-eval harness.
 *
 *   npx tsx src/skill-eval/run-all-sweep.ts [--seed N] [--runs-per-query N] ...
 *
 * Discovers every `<plugin>-<skill>/eval-set.json` under
 * `<repoRoot>/tests/skill-evals/`, runs each one sequentially via the
 * existing `runEvalSetCore` orchestrator, and aggregates a single
 * roll-up table. Sequential — NOT parallel — is intentional:
 *
 *   - JSONL workspace contention. Every probe writes to the same
 *     `~/.claude/projects/<workspace-cwd>/<uuid>.jsonl` tree; parallel
 *     eval-sets dramatically increase the cost of the watcher's
 *     dispatch-tag scan and make per-skill REPORT.md emission
 *     race-prone.
 *   - Cost ceiling. Each eval-set already runs internal probes
 *     bounded-parallel; cross-eval parallelism multiplies cost
 *     unpredictably and exceeds the 30-minute / $25 sweep budget from
 *     DX-279 ACs.
 *
 * Module split (DX-332):
 *   - `sweep-discovery.ts` — discoverEvalSets + DiscoveredEvalSet
 *   - `sweep-rollup.ts`    — renderSweepRollup + sanitizeErrorForGfm + SweepEntryResult/SweepStatus
 *   - `run-all-sweep.ts`   — CLI main + orchestrator (this file)
 *
 * Side effects:
 *   - One `REPORT.md` written next to each eval-set (auto-regenerated
 *     every run; same writer as Modes 2 + 3 use, so a single source
 *     of truth for the on-disk report).
 *   - One `SWEEP.md` written next to the `tests/skill-evals/` directory
 *     summarizing every entry + linking to each `REPORT.md`.
 *
 * Pure orchestrator `runAllSweepCore` accepts injected `runOne` +
 * `writeReport` + `writeSweepMarkdown` deps so unit tests can exercise
 * sequential ordering, error-handling, and aggregation without the
 * dispatch pipeline, the filesystem, or the network.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SideAccuracy } from "./aggregate.js";
import { aggregateSide } from "./aggregate.js";
import {
  COMMON_KNOWN_FLAGS,
  isInvokedAsScript,
  parseCommonRunFlags,
  pickArg,
  validateKnownFlags,
} from "./cli-args.js";
import { loadEvalSet, type EvalQuery } from "./eval-set.js";
import { formatCostUsd, formatElapsed } from "./markdown-format.js";
import { runProbe } from "./probe.js";
import {
  persistEvalSetReport,
  type WriteEvalSetReportFileResult,
} from "./report-file.js";
import {
  runEvalSetCore,
  type RunEvalSetArgs,
  type RunEvalSetResult,
} from "./run-eval-set.js";
import {
  discoverEvalSets,
  type DiscoveredEvalSet,
} from "./sweep-discovery.js";
import {
  renderSweepRollup,
  type SweepEntryResult,
} from "./sweep-rollup.js";

// Re-export the split-module surface area existing consumers reach for
// (only `discoverEvalSets`, `renderSweepRollup`, and `SweepEntryResult`
// have callers outside this file as of DX-332). New consumers should
// import directly from sweep-discovery.ts / sweep-rollup.ts.
export type { SweepEntryResult };
export { discoverEvalSets, renderSweepRollup };

export class RunAllSweepArgsError extends Error {}

export interface RunAllSweepArgs {
  readonly evalSetsDir: string;
  readonly repoRoot: string;
  readonly workspace: string;
  readonly workspaceCwd: string;
  readonly timeoutMs: number;
  readonly parallel: number;
  readonly seed: number;
  readonly runsPerQuery: number;
  readonly pricingModel: string;
}

export interface RunAllSweepResult {
  readonly entries: readonly SweepEntryResult[];
  readonly totalCostUsd: number;
  readonly totalElapsedMs: number;
  readonly overallPass: boolean;
  readonly exitCode: 0 | 1 | 2;
  readonly rollupMarkdown: string;
  readonly sweepReportPath?: string;
}

export type SweepRunOneFn = (
  args: RunEvalSetArgs,
  queries: readonly EvalQuery[],
) => Promise<RunEvalSetResult>;

export type SweepWriteReportFn = (
  args: {
    readonly evalSetPath: string;
    readonly markdown: string;
    readonly runAt: Date;
  },
) => WriteEvalSetReportFileResult;

export type SweepWriteMarkdownFn = (
  path: string,
  markdown: string,
) => string;

export interface RunAllSweepDeps {
  readonly runOne: SweepRunOneFn;
  readonly writeReport: SweepWriteReportFn;
  readonly writeSweepMarkdown: SweepWriteMarkdownFn;
  readonly now: () => number;
}

function emptySideAccuracy(label: "train" | "test"): SideAccuracy {
  return { label, total: 0, correct: 0, accuracy: 0 };
}

function errorToMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildRunEvalSetArgs(
  d: DiscoveredEvalSet,
  args: RunAllSweepArgs,
): RunEvalSetArgs {
  return {
    pluginSkill: d.pluginSkill,
    evalSetPath: d.evalSetPath,
    workspace: args.workspace,
    workspaceCwd: args.workspaceCwd,
    timeoutMs: args.timeoutMs,
    parallel: args.parallel,
    seed: args.seed,
    runsPerQuery: args.runsPerQuery,
    pricingModel: args.pricingModel,
  };
}

function buildSuccessEntry(
  d: DiscoveredEvalSet,
  args: RunAllSweepArgs,
  result: RunEvalSetResult,
  writeRes: WriteEvalSetReportFileResult,
  elapsedMs: number,
): SweepEntryResult {
  return {
    pluginSkill: d.pluginSkill,
    evalSetDir: d.evalSetDir,
    evalSetPath: d.evalSetPath,
    overallPass: result.overallPass,
    train: aggregateSide("train", result.trainVerdicts),
    test: aggregateSide("test", result.testVerdicts),
    runsPerQuery: args.runsPerQuery,
    costUsd: result.totalCostUsd,
    elapsedMs,
    status: result.overallPass ? "GREEN" : "FAIL",
    reportPath: writeRes.path,
    trainVerdicts: result.trainVerdicts,
    testVerdicts: result.testVerdicts,
  };
}

export type SweepErrorCategory = "schema" | "dispatch";

function buildErrorEntry(
  d: DiscoveredEvalSet,
  category: SweepErrorCategory,
  err: unknown,
  elapsedMs: number,
): SweepEntryResult {
  return {
    pluginSkill: d.pluginSkill,
    evalSetDir: d.evalSetDir,
    evalSetPath: d.evalSetPath,
    overallPass: false,
    train: emptySideAccuracy("train"),
    test: emptySideAccuracy("test"),
    runsPerQuery: 0,
    costUsd: 0,
    elapsedMs,
    status: "ERROR",
    // Category prefix lets operators triage in the rollup table without
    // opening REPORT.md: `schema:` = eval-set didn't load (fix the JSON);
    // `dispatch:` = sweep loop reached this entry but probe orchestration
    // threw (worker / Anthropic / harness bug).
    errorMessage: `${category}: ${errorToMessage(err)}`,
  };
}

async function runOneEntry(
  d: DiscoveredEvalSet,
  args: RunAllSweepArgs,
  deps: RunAllSweepDeps,
): Promise<SweepEntryResult> {
  const entryStartMs = deps.now();
  let queries: readonly EvalQuery[];
  try {
    queries = loadEvalSet(d.evalSetPath);
  } catch (err) {
    return buildErrorEntry(d, "schema", err, deps.now() - entryStartMs);
  }
  try {
    const result = await deps.runOne(buildRunEvalSetArgs(d, args), queries);
    const writeRes = deps.writeReport({
      evalSetPath: d.evalSetPath,
      markdown: result.markdown,
      runAt: new Date(),
    });
    return buildSuccessEntry(d, args, result, writeRes, deps.now() - entryStartMs);
  } catch (err) {
    return buildErrorEntry(d, "dispatch", err, deps.now() - entryStartMs);
  }
}

function buildEmptyDiscoveryResult(
  sweepStartedAtMs: number,
  deps: RunAllSweepDeps,
): RunAllSweepResult {
  return {
    entries: [],
    totalCostUsd: 0,
    totalElapsedMs: deps.now() - sweepStartedAtMs,
    overallPass: false,
    exitCode: 2,
    rollupMarkdown: renderSweepRollup({
      entries: [],
      totalCostUsd: 0,
      totalElapsedMs: 0,
      overallPass: false,
      runAt: new Date(),
    }),
  };
}

/**
 * Core sweep orchestrator. Pure of network/filesystem when its
 * dependencies are mocked; the production wiring lives in `main()`.
 *
 * Behavior:
 *   - Discover eval-sets under `args.evalSetsDir` (single-level walk).
 *   - For each, in directory-name order, sequentially:
 *       1. Load the eval-set (loadEvalSet — throws on bad JSON / schema).
 *       2. Call `runOne` with a full `RunEvalSetArgs` derived from
 *          the sweep-level flags.
 *       3. Write per-skill REPORT.md via `writeReport`.
 *       4. Capture train + test SideAccuracy via `aggregateSide`.
 *   - A throw from `loadEvalSet` records the entry as `status: ERROR`
 *     with `errorMessage: "schema: ..."` and DOES NOT abort the sweep.
 *   - A throw from `runOne` records the entry as `status: ERROR`
 *     with `errorMessage: "dispatch: ..."`.
 *   - After every entry, render the roll-up via `renderSweepRollup`
 *     and write SWEEP.md via `writeSweepMarkdown`.
 *
 * Exit code:
 *   - `2` if no eval-sets were discovered (operator likely pointed at
 *     the wrong directory; nothing to sweep).
 *   - `1` if any entry FAIL or ERROR.
 *   - `0` otherwise.
 */
export async function runAllSweepCore(
  args: RunAllSweepArgs,
  deps: RunAllSweepDeps,
): Promise<RunAllSweepResult> {
  const sweepStartedAtMs = deps.now();
  const discovered = discoverEvalSets(args.evalSetsDir);
  if (discovered.length === 0) {
    return buildEmptyDiscoveryResult(sweepStartedAtMs, deps);
  }

  const entries: SweepEntryResult[] = [];
  for (const d of discovered) {
    entries.push(await runOneEntry(d, args, deps));
  }

  const totalCostUsd = entries.reduce((acc, e) => acc + e.costUsd, 0);
  const overallPass = entries.every((e) => e.status === "GREEN");
  const runAt = new Date();
  const rollupMarkdown = renderSweepRollup({
    entries,
    totalCostUsd,
    totalElapsedMs: deps.now() - sweepStartedAtMs,
    overallPass,
    runAt,
  });
  const sweepReportPath = deps.writeSweepMarkdown(
    join(args.evalSetsDir, "SWEEP.md"),
    rollupMarkdown,
  );

  const exitCode: 0 | 1 = overallPass ? 0 : 1;

  return {
    entries,
    totalCostUsd,
    totalElapsedMs: deps.now() - sweepStartedAtMs,
    overallPass,
    exitCode,
    rollupMarkdown,
    sweepReportPath,
  };
}

const SWEEP_OWN_FLAGS = ["eval-sets-dir"] as const;
export const SWEEP_KNOWN_FLAGS = [
  ...COMMON_KNOWN_FLAGS,
  ...SWEEP_OWN_FLAGS,
] as const;

/**
 * Parse argv into `RunAllSweepArgs`. Mirrors `parseEvalSetArgs` /
 * `parseIterateArgs` for the flags that apply to single-skill runs
 * (parallel, seed, runs-per-query, pricing-model, timeouts), plus a
 * single sweep-specific flag (`--eval-sets-dir`) defaulting to
 * `<repoRoot>/tests/skill-evals`. Rejects unknown `--flag` tokens via
 * `validateKnownFlags`.
 */
export function parseSweepArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RunAllSweepArgs {
  validateKnownFlags(argv, SWEEP_KNOWN_FLAGS, RunAllSweepArgsError);
  const common = parseCommonRunFlags(argv, env, RunAllSweepArgsError);
  const evalSetsDir =
    pickArg(argv, "eval-sets-dir") ??
    resolve(common.repoRoot, "tests", "skill-evals");

  return {
    evalSetsDir,
    repoRoot: common.repoRoot,
    workspace: common.workspace,
    workspaceCwd: common.workspaceCwd,
    timeoutMs: common.timeoutMs,
    parallel: common.parallel,
    seed: common.seed,
    runsPerQuery: common.runsPerQuery,
    pricingModel: common.pricingModel,
  };
}

function fail(msg: string): never {
  process.stderr.write(`FAIL ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<number> {
  let args: RunAllSweepArgs;
  try {
    args = parseSweepArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof RunAllSweepArgsError) fail(err.message);
    throw err;
  }

  if (!existsSync(args.workspaceCwd)) {
    fail(
      `workspace cwd does not exist: ${args.workspaceCwd} — check --workspace / --repo-root`,
    );
  }

  process.stderr.write(
    `Sweeping ${args.evalSetsDir} (parallel=${args.parallel}, seed=${args.seed}, runs=${args.runsPerQuery})\n`,
  );

  const result = await runAllSweepCore(args, {
    runOne: (a, queries) => runEvalSetCore(a, queries, runProbe),
    writeReport: persistEvalSetReport,
    writeSweepMarkdown: (path, md) => {
      writeFileSync(path, md, "utf8");
      return path;
    },
    now: () => Date.now(),
  });

  process.stdout.write(result.rollupMarkdown);
  process.stdout.write("\n");
  // Sweep banner: cost + elapsed via the shared formatters so the line
  // shape matches REPORT.md's parameters block exactly.
  process.stderr.write(
    `\nSwept ${result.entries.length} eval-sets — Exit ${result.exitCode} (${result.overallPass ? "PASS" : "FAIL"}) — total cost ${formatCostUsd(result.totalCostUsd)} USD — elapsed ${formatElapsed(result.totalElapsedMs)}\n`,
  );
  if (result.sweepReportPath) {
    process.stderr.write(`SWEEP.md written: ${result.sweepReportPath}\n`);
  }
  return result.exitCode;
}

if (isInvokedAsScript("run-all-sweep")) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      fail(`unexpected runner error: ${e.stack ?? e.message}`);
    });
}
