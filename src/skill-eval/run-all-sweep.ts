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

import {
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { QueryVerdict, SideAccuracy } from "./aggregate.js";
import { aggregateSide } from "./aggregate.js";
import {
  isInvokedAsScript,
  parseCommonRunFlags,
  pickArg,
} from "./cli-args.js";
import { loadEvalSet, type EvalQuery } from "./eval-set.js";
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

export class RunAllSweepArgsError extends Error {}

export interface RunAllSweepArgs {
  readonly evalSetsDir: string;
  readonly repoRoot: string;
  readonly workspace: string;
  readonly workerPort: number;
  readonly repoName: string;
  readonly workspaceCwd: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly parallel: number;
  readonly seed: number;
  readonly runsPerQuery: number;
  readonly pricingModel: string;
}

export type SweepStatus = "GREEN" | "FAIL" | "ERROR";

export interface SweepEntryResult {
  readonly pluginSkill: string;
  readonly evalSetDir: string;
  readonly evalSetPath: string;
  readonly overallPass: boolean;
  readonly train: SideAccuracy;
  readonly test: SideAccuracy;
  readonly runsPerQuery: number;
  readonly costUsd: number;
  readonly elapsedMs: number;
  readonly status: SweepStatus;
  readonly errorMessage?: string;
  readonly reportPath?: string;
  readonly trainVerdicts?: readonly QueryVerdict[];
  readonly testVerdicts?: readonly QueryVerdict[];
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

export interface DiscoveredEvalSet {
  readonly pluginSkill: string;
  readonly evalSetDir: string;
  readonly evalSetPath: string;
}

/**
 * Walk a single level of `evalSetsDir`, return one entry per
 * subdirectory that contains an `eval-set.json` file. Directory name
 * `<plugin>-<skill>` is parsed by splitting on the FIRST hyphen so
 * skill names with hyphens (e.g. `issue-card-workflow`) round-trip
 * correctly. Plugin names with hyphens are out of scope for V1 — none
 * of the priority plugins have one; an operator naming a plugin with
 * an internal hyphen would have to supply a meta.json escape hatch
 * later.
 *
 * Entries are sorted lexicographically by directory name so the sweep
 * order is deterministic across hosts / filesystems.
 */
export function discoverEvalSets(
  evalSetsDir: string,
): DiscoveredEvalSet[] {
  if (!existsSync(evalSetsDir)) return [];
  const entries = readdirSync(evalSetsDir).sort();
  const out: DiscoveredEvalSet[] = [];
  for (const name of entries) {
    const dir = join(evalSetsDir, name);
    let dirStat;
    try {
      dirStat = statSync(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    const idx = name.indexOf("-");
    if (idx === -1) continue;
    const plugin = name.slice(0, idx);
    const skill = name.slice(idx + 1);
    if (plugin.length === 0 || skill.length === 0) continue;
    const evalSetPath = join(dir, "eval-set.json");
    if (!existsSync(evalSetPath)) continue;
    out.push({
      pluginSkill: `${plugin}:${skill}`,
      evalSetDir: dir,
      evalSetPath,
    });
  }
  return out;
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
    workerPort: args.workerPort,
    repoName: args.repoName,
    workspaceCwd: args.workspaceCwd,
    timeoutMs: args.timeoutMs,
    pollIntervalMs: args.pollIntervalMs,
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

function buildErrorEntry(
  d: DiscoveredEvalSet,
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
    errorMessage: errorToMessage(err),
  };
}

async function runOneEntry(
  d: DiscoveredEvalSet,
  args: RunAllSweepArgs,
  deps: RunAllSweepDeps,
): Promise<SweepEntryResult> {
  const entryStartMs = deps.now();
  try {
    const queries = loadEvalSet(d.evalSetPath);
    const result = await deps.runOne(buildRunEvalSetArgs(d, args), queries);
    const writeRes = deps.writeReport({
      evalSetPath: d.evalSetPath,
      markdown: result.markdown,
      runAt: new Date(),
    });
    return buildSuccessEntry(d, args, result, writeRes, deps.now() - entryStartMs);
  } catch (err) {
    return buildErrorEntry(d, err, deps.now() - entryStartMs);
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
 *   - A throw from `runOne` (or eval-set load failure) records the
 *     entry as `status: ERROR` with the message and DOES NOT abort the
 *     sweep — every other discoverable eval-set still runs.
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

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function formatCostUsd(usd: number): string {
  return `~$${usd.toFixed(4)}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

const ERROR_MESSAGE_MAX_CHARS = 80;

/**
 * Sanitize a free-form error message for inclusion in a single GFM
 * table cell. Newlines, carriage returns, and pipe characters all
 * break the table layout — replace them with single spaces. The
 * 80-char cap keeps the table row legible; longer error messages
 * stay available in REPORT.md / the raw `errorMessage` field on the
 * entry.
 */
function sanitizeErrorForGfm(raw: string): string {
  const trimmed = raw.length > ERROR_MESSAGE_MAX_CHARS
    ? raw.slice(0, ERROR_MESSAGE_MAX_CHARS)
    : raw;
  return trimmed.replace(/[|\r\n]+/g, " ");
}

function formatSweepRow(e: SweepEntryResult): string {
  const trainCell =
    e.train.total === 0
      ? "—"
      : `${formatPercent(e.train.accuracy)} (${e.train.correct}/${e.train.total})`;
  const testCell =
    e.test.total === 0
      ? "—"
      : `${formatPercent(e.test.accuracy)} (${e.test.correct}/${e.test.total})`;
  const runsCell = e.runsPerQuery === 0 ? "—" : `${e.runsPerQuery}`;
  const costCell = formatCostUsd(e.costUsd);
  const elapsedCell = formatElapsed(e.elapsedMs);
  const statusCell =
    e.status === "ERROR" && e.errorMessage
      ? `ERROR (${sanitizeErrorForGfm(e.errorMessage)})`
      : e.status;
  const reportLink = e.reportPath ? ` ([REPORT.md](${e.reportPath}))` : "";
  return `| \`${e.pluginSkill}\`${reportLink} | ${trainCell} | ${testCell} | ${runsCell} | ${costCell} | ${elapsedCell} | ${statusCell} |`;
}

export interface RenderSweepRollupInput {
  readonly entries: readonly SweepEntryResult[];
  readonly totalCostUsd: number;
  readonly totalElapsedMs: number;
  readonly overallPass: boolean;
  readonly runAt: Date;
}

/**
 * Pure markdown renderer for the sweep roll-up. Writes a GFM table
 * with one row per entry and a summary block.
 *
 * `ERROR` rows surface the error message in the same Status column so
 * the operator can see why an eval-set was skipped without diffing
 * REPORT.md files.
 */
export function renderSweepRollup(input: RenderSweepRollupInput): string {
  const lines: string[] = [];
  lines.push("# Skill-eval --all sweep");
  lines.push("");
  lines.push(`**Overall: ${input.overallPass ? "PASS" : "FAIL"}**`);
  lines.push("");
  lines.push(`- Last run: \`${input.runAt.toISOString()}\``);
  lines.push(`- Eval-sets: \`${input.entries.length}\``);
  lines.push(`- Total cost: \`${formatCostUsd(input.totalCostUsd)}\``);
  lines.push(`- Total elapsed: \`${formatElapsed(input.totalElapsedMs)}\``);
  lines.push("");
  lines.push("## Per-skill summary");
  lines.push("");
  lines.push("| Skill | Train | Test | Runs | Cost | Elapsed | Status |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const e of input.entries) {
    lines.push(formatSweepRow(e));
  }
  if (input.entries.length === 0) {
    lines.push("");
    lines.push("_No eval-sets discovered. Check `--eval-sets-dir`._");
  }
  return lines.join("\n");
}

/**
 * Parse argv into `RunAllSweepArgs`. Mirrors `parseEvalSetArgs` /
 * `parseIterateArgs` for the flags that apply to single-skill runs
 * (parallel, seed, runs-per-query, pricing-model, timeouts), plus a
 * single sweep-specific flag (`--eval-sets-dir`) defaulting to
 * `<repoRoot>/tests/skill-evals`.
 */
export function parseSweepArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RunAllSweepArgs {
  const common = parseCommonRunFlags(argv, env, RunAllSweepArgsError);
  const evalSetsDir =
    pickArg(argv, "eval-sets-dir") ??
    resolve(common.repoRoot, "tests", "skill-evals");

  return {
    evalSetsDir,
    repoRoot: common.repoRoot,
    workspace: common.workspace,
    workerPort: common.workerPort,
    repoName: common.repoName,
    workspaceCwd: common.workspaceCwd,
    timeoutMs: common.timeoutMs,
    pollIntervalMs: common.pollIntervalMs,
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
  process.stderr.write(
    `\nSwept ${result.entries.length} eval-sets — Exit ${result.exitCode} (${result.overallPass ? "PASS" : "FAIL"}) — total cost ~$${result.totalCostUsd.toFixed(4)} USD — elapsed ${formatElapsed(result.totalElapsedMs)}\n`,
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
      fail(`unexpected runner error: ${(err as Error).stack ?? err}`);
    });
}
