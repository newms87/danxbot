#!/usr/bin/env -S npx tsx
/**
 * Eval-set CLI for the skill-eval harness.
 *
 *   npx tsx src/skill-eval/run-eval-set.ts <plugin>:<skill> [--parallel N] [--seed N] ...
 *
 * Runs every query in `<repo>/tests/skill-evals/<plugin>-<skill>/eval-set.json`
 * 3× (by default) through the host-mode dispatch path, computes per-side
 * accuracy on a deterministic 60/40 train/test split, renders a markdown
 * report, and exits 0 if BOTH sides ≥ 95% accuracy / 1 otherwise.
 *
 * Architecture (one orchestrator, three pure primitives):
 *   - `loadEvalSet` (./eval-set.ts)        — read + validate JSON file
 *   - `splitEvalSet` (./split.ts)          — deterministic 60/40 shuffle
 *   - `runEvalSetCore` (this file)         — bounded-parallel dispatch + aggregation
 *   - `runProbe` (./probe.ts)              — single dispatch + JSONL verdict
 *   - `aggregateQueryRuns` / `aggregateSide` / `decideOverallPass` (./aggregate.ts)
 *   - `renderReport` (./report.ts)         — markdown formatter
 *
 * `runEvalSetCore` accepts an injected `probe` function so the unit tests
 * can exercise the orchestrator (concurrency, error-handling, aggregation,
 * splitting) without hitting the worker or filesystem.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { calculateApiCost } from "../agent/pricing.js";
import {
  aggregateQueryRuns,
  aggregateSide,
  decideOverallPass,
  type QueryRunRecord,
  type QueryVerdict,
} from "./aggregate.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  parseNonNegativeInt as parseNonNegativeIntShared,
  parsePositiveInt as parsePositiveIntShared,
  pickArg,
} from "./cli-args.js";
import {
  loadEvalSet,
  resolveEvalSetPath,
  type EvalQuery,
} from "./eval-set.js";
import { ProbeError, runProbe, type ProbeArgs, type ProbeResult } from "./probe.js";
import { renderReport } from "./report.js";
import { splitEvalSet } from "./split.js";

export class RunEvalSetArgsError extends Error {}

function parsePositiveInt(name: string, raw: string): number {
  return parsePositiveIntShared(name, raw, RunEvalSetArgsError);
}

export interface RunEvalSetArgs {
  readonly pluginSkill: string;
  readonly evalSetPath: string;
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

export interface RunEvalSetResult {
  readonly overallPass: boolean;
  readonly exitCode: 0 | 1;
  readonly markdown: string;
  readonly totalCostUsd: number;
  /**
   * Per-query verdicts split into the train/test halves. Exposed so the
   * iteration orchestrator (`iterate.ts`) can extract train failures
   * for the proposer without re-running the sweep — the held-out test
   * verdicts are tracked separately for the best-iteration selection.
   */
  readonly trainVerdicts: readonly QueryVerdict[];
  readonly testVerdicts: readonly QueryVerdict[];
}

export type ProbeFn = (args: ProbeArgs) => Promise<ProbeResult>;

const DEFAULT_PARALLEL = 3;
const DEFAULT_RUNS_PER_QUERY = 3;
const DEFAULT_SEED = 1;
const DEFAULT_PRICING_MODEL = "claude-sonnet-4-6";

function fail(msg: string): never {
  process.stderr.write(`FAIL ${msg}\n`);
  process.exit(2);
}

export function parseEvalSetArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RunEvalSetArgs {
  // Positional arg OR --plugin-skill flag.
  let pluginSkill = pickArg(argv, "plugin-skill");
  if (!pluginSkill) {
    const positional = argv.find((a) => !a.startsWith("--"));
    if (positional) pluginSkill = positional;
  }
  if (!pluginSkill) {
    throw new RunEvalSetArgsError(
      "missing <plugin>:<skill> (e.g. dev:debugging) — pass positionally or as --plugin-skill",
    );
  }

  const workspace = pickArg(argv, "workspace") ?? "skill-eval";
  const repoName = pickArg(argv, "repo") ?? "danxbot";

  const portRaw =
    pickArg(argv, "worker-port") ?? env.DANXBOT_WORKER_PORT ?? null;
  if (!portRaw) {
    throw new RunEvalSetArgsError(
      "missing --worker-port (no DANXBOT_WORKER_PORT env either)",
    );
  }
  const workerPort = parsePositiveInt("worker-port", portRaw);

  const repoRoot = pickArg(argv, "repo-root") ?? env.DANXBOT_REPO_ROOT ?? null;
  if (!repoRoot) {
    throw new RunEvalSetArgsError(
      "missing --repo-root (no DANXBOT_REPO_ROOT env either) — supply the danxbot install dir",
    );
  }

  const evalSetPath =
    pickArg(argv, "eval-set") ?? resolveEvalSetPath(repoRoot, pluginSkill);
  const workspaceCwd =
    pickArg(argv, "workspace-cwd") ??
    resolve(repoRoot, ".danxbot", "workspaces", workspace);

  const timeoutMs = parsePositiveInt(
    "timeout-ms",
    pickArg(argv, "timeout-ms") ?? `${DEFAULT_TIMEOUT_MS}`,
  );
  const pollIntervalMs = parsePositiveInt(
    "poll-interval-ms",
    pickArg(argv, "poll-interval-ms") ?? `${DEFAULT_POLL_INTERVAL_MS}`,
  );
  const parallel = parsePositiveInt(
    "parallel",
    pickArg(argv, "parallel") ?? `${DEFAULT_PARALLEL}`,
  );
  const runsPerQuery = parsePositiveInt(
    "runs-per-query",
    pickArg(argv, "runs-per-query") ?? `${DEFAULT_RUNS_PER_QUERY}`,
  );
  const seed = parseNonNegativeIntShared(
    "seed",
    pickArg(argv, "seed") ?? `${DEFAULT_SEED}`,
    RunEvalSetArgsError,
  );

  const pricingModel =
    pickArg(argv, "pricing-model") ?? DEFAULT_PRICING_MODEL;

  return {
    pluginSkill,
    evalSetPath,
    workspace,
    workerPort,
    repoName,
    workspaceCwd,
    timeoutMs,
    pollIntervalMs,
    parallel,
    seed,
    runsPerQuery,
    pricingModel,
  };
}

/**
 * Bounded-parallel map. Workers pull items off a shared cursor; at most
 * `parallel` worker promises are alive at any moment. Returns results
 * in input order. Errors thrown by the worker propagate, killing the
 * whole map — `runEvalSetCore` catches `ProbeError` at the worker level
 * so a single transient probe failure does NOT abort the sweep.
 */
async function boundedParallelMap<T, R>(
  items: readonly T[],
  parallel: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(parallel, items.length));
  const lanes = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Convert a `ProbeResult` to a `QueryRunRecord` for aggregation. The
 * QueryRunRecord shape is the lingua franca between the orchestrator and
 * the aggregate / report modules — having a single conversion site keeps
 * the field-name plumbing in one place.
 */
function probeResultToRecord(
  runIndex: number,
  result: ProbeResult,
): QueryRunRecord {
  return {
    runIndex,
    triggered: result.verdict.pass,
    jobId: result.jobId,
    jsonlPath: result.jsonlPath,
    reason: result.verdict.reason,
    skillCalls: result.verdict.skillCalls,
    firstAssistantText: result.verdict.firstAssistantText,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
  };
}

/**
 * Convert any thrown error in a probe lane to a "did not trigger"
 * record. The eval-set runner cannot afford to abort a 60-probe sweep
 * over a single transient failure — every error becomes a no-fire run
 * with the underlying message surfaced in the report's per-failure
 * forensics. ProbeError carries a category for distinct messages;
 * anything else falls through to a generic shape with the error name.
 *
 * Concurrency note: a single lane catching an error keeps that lane
 * alive (pulling the next item from the cursor). Other lanes' in-flight
 * dispatches are NOT touched — they run to completion as normal. The
 * worker's per-dispatch slot is freed when each individual probe
 * returns or its `danxbot_complete` MCP callback fires.
 */
function thrownToRecord(runIndex: number, err: unknown): QueryRunRecord {
  if (err instanceof ProbeError) {
    return {
      runIndex,
      triggered: false,
      jobId: `error-${err.category}-${runIndex}`,
      jsonlPath: null,
      reason: `probe error (${err.category}): ${err.message}`,
      skillCalls: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }
  const e = err as Error;
  return {
    runIndex,
    triggered: false,
    jobId: `error-unexpected-${runIndex}`,
    jsonlPath: null,
    reason: `unexpected runner error (${e?.name ?? "Error"}): ${e?.message ?? String(err)}`,
    skillCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

interface WorkItem {
  readonly query: EvalQuery;
  readonly queryIdx: number;
  readonly runIdx: number;
}

/**
 * Core orchestrator. Accepts an injected `probe` so unit tests can
 * exercise the full bounded-parallel + aggregation + reporting path
 * without touching the network or filesystem. The CLI entry point
 * (below) wires `runProbe` as the default.
 */
export async function runEvalSetCore(
  args: RunEvalSetArgs,
  queries: readonly EvalQuery[],
  probe: ProbeFn,
): Promise<RunEvalSetResult> {
  const startMs = Date.now();
  const { train, test } = splitEvalSet(queries, args.seed);

  // Build the flat work list: (query, runIdx) for every (query, run).
  const items: WorkItem[] = [];
  queries.forEach((query, queryIdx) => {
    for (let runIdx = 0; runIdx < args.runsPerQuery; runIdx++) {
      items.push({ query, queryIdx, runIdx });
    }
  });

  // Bounded-parallel dispatch. Every thrown error becomes a no-fire
  // record so one transient failure cannot kill the sweep — see
  // `thrownToRecord`. The lane stays alive and pulls the next item.
  const records = await boundedParallelMap(items, args.parallel, async (item) => {
    try {
      const result = await probe({
        query: item.query.query,
        expectSkill: args.pluginSkill,
        workspace: args.workspace,
        workerPort: args.workerPort,
        repoName: args.repoName,
        workspaceCwd: args.workspaceCwd,
        timeoutMs: args.timeoutMs,
        pollIntervalMs: args.pollIntervalMs,
      });
      return { item, record: probeResultToRecord(item.runIdx, result) };
    } catch (err) {
      return { item, record: thrownToRecord(item.runIdx, err) };
    }
  });

  // Bucket records by query index.
  const perQueryRecords = new Map<number, QueryRunRecord[]>();
  for (const { item, record } of records) {
    const bucket = perQueryRecords.get(item.queryIdx) ?? [];
    bucket.push(record);
    perQueryRecords.set(item.queryIdx, bucket);
  }

  // Aggregate per-query verdicts. Key by `queryIdx` (a deterministic
  // integer per input position) rather than the `EvalQuery` object
  // reference — the object-identity key would silently drop entries
  // if any downstream code path ever introduced duplicate references,
  // and the resulting `Map.get(q)!` non-null bang would mask the bug.
  // Index keying makes the lookup contract obvious.
  const verdictByIdx = new Map<number, QueryVerdict>();
  queries.forEach((query, idx) => {
    const runs = perQueryRecords.get(idx) ?? [];
    verdictByIdx.set(idx, aggregateQueryRuns(query, runs));
  });

  function verdictFor(query: EvalQuery): QueryVerdict {
    const idx = queries.indexOf(query);
    const verdict = verdictByIdx.get(idx);
    if (!verdict) {
      throw new Error(
        `runEvalSetCore: missing verdict for query at index ${idx} — sweep is corrupt`,
      );
    }
    return verdict;
  }

  const trainVerdicts = train.map(verdictFor);
  const testVerdicts = test.map(verdictFor);
  const trainSide = aggregateSide("train", trainVerdicts);
  const testSide = aggregateSide("test", testVerdicts);
  const overallPass = decideOverallPass(trainSide, testSide);

  // Total cost across every run, derived from real token counts using
  // the configured pricing model. Sums every aggregated query exactly
  // once — the union of train + test covers every query, with no
  // overlap, so this is equivalent to summing trainVerdicts + testVerdicts
  // but avoids a double-walk of the data.
  const totalCostUsd = Array.from(verdictByIdx.values()).reduce(
    (acc, v) =>
      acc +
      calculateApiCost(
        args.pricingModel,
        v.totalInputTokens,
        v.totalOutputTokens,
        v.totalCacheCreationTokens,
        v.totalCacheReadTokens,
      ),
    0,
  );

  const markdown = renderReport({
    pluginSkill: args.pluginSkill,
    evalSetPath: args.evalSetPath,
    seed: args.seed,
    runsPerQuery: args.runsPerQuery,
    trainVerdicts,
    testVerdicts,
    train: trainSide,
    test: testSide,
    overallPass,
    totalCostUsd,
    pricingModel: args.pricingModel,
    elapsedMs: Date.now() - startMs,
  });

  return {
    overallPass,
    exitCode: overallPass ? 0 : 1,
    markdown,
    totalCostUsd,
    trainVerdicts,
    testVerdicts,
  };
}

async function main(): Promise<number> {
  let args: RunEvalSetArgs;
  try {
    args = parseEvalSetArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof RunEvalSetArgsError) fail(err.message);
    throw err;
  }

  if (!existsSync(args.workspaceCwd)) {
    fail(
      `workspace cwd does not exist: ${args.workspaceCwd} — check --workspace / --repo-root`,
    );
  }

  let queries: readonly EvalQuery[];
  try {
    queries = loadEvalSet(args.evalSetPath);
  } catch (err) {
    fail((err as Error).message);
  }

  process.stderr.write(
    `Running ${queries.length} queries × ${args.runsPerQuery} runs (parallel=${args.parallel}, seed=${args.seed}) against ${args.pluginSkill}\n`,
  );
  process.stderr.write(`Eval-set: ${args.evalSetPath}\n`);

  const result = await runEvalSetCore(args, queries, runProbe);
  process.stdout.write(result.markdown);
  process.stdout.write("\n");
  process.stderr.write(
    `\nExit ${result.exitCode} (${result.overallPass ? "PASS" : "FAIL"}) — total cost ~$${result.totalCostUsd.toFixed(4)} USD (model=${args.pricingModel}, estimated)\n`,
  );
  return result.exitCode;
}

const invokedAsScript =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /run-eval-set\.ts$|run-eval-set\.js$/.test(process.argv[1]);
if (invokedAsScript) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      fail(`unexpected runner error: ${(err as Error).stack ?? err}`);
    });
}
