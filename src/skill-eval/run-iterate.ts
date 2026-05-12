#!/usr/bin/env -S npx tsx
/**
 * `--iterate` CLI for the skill-eval harness.
 *
 *   npx tsx src/skill-eval/run-iterate.ts <plugin>:<skill> [flags]
 *
 * Wraps `iterate.ts` with real wiring:
 *   - `runEvalSet` callback → `runEvalSetCore` from run-eval-set.ts
 *   - `proposer` → `makeAnthropicProposer` from description-proposer.ts
 *   - `gitCommitPush` → `commitAndPushDescription` from plugin-git.ts
 *   - `reloadAndVerify` → `reloadAndVerify` from reload-propagation.ts
 *   - `gitExec` → `node:child_process` execFile
 *   - `readFile` / `writeFile` → `node:fs`
 *
 * Defaults match the card spec:
 *   - --max-iterations 5  (hard-max 8 enforced by `iterate.ts`)
 *   - --cost-cap-usd 2.55
 *   - --source-root ~/web/claude-plugins
 *   - --cache-root ~/.claude/plugins/marketplaces/newms-plugins
 *
 * Pure helpers `parseIterateArgs` + `formatIterateReport` are exported
 * so unit tests can exercise the CLI surface without spawning child
 * processes or hitting Anthropic.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { aggregateSide } from "./aggregate.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  parseNonNegativeInt as parseNonNegativeIntShared,
  parsePositiveInt as parsePositiveIntShared,
  pickArg,
} from "./cli-args.js";
import { loadEvalSet, resolveEvalSetPath } from "./eval-set.js";
import {
  HARD_MAX_ITERATIONS,
  iterate,
  type IterateArgs,
  type IterateResult,
  type IterationEvalSummary,
  type IterationRecord,
} from "./iterate.js";
import { makeAnthropicProposer } from "./description-proposer.js";
import { resolvePluginSkillPaths } from "./plugin-paths.js";
import {
  commitAndPushDescription,
  type GitExecResult,
} from "./plugin-git.js";
import { runProbe } from "./probe.js";
import { reloadAndVerify } from "./reload-propagation.js";
import { runEvalSetCore } from "./run-eval-set.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_COST_CAP_USD = 2.55;
const DEFAULT_PRICING_MODEL = "claude-sonnet-4-6";
const DEFAULT_PARALLEL = 3;
const DEFAULT_RUNS_PER_QUERY = 3;
const DEFAULT_SEED = 1;

export class RunIterateArgsError extends Error {}

function parsePositiveInt(name: string, raw: string): number {
  return parsePositiveIntShared(name, raw, RunIterateArgsError);
}

function parsePositiveFloat(name: string, raw: string): number {
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RunIterateArgsError(
      `invalid --${name}: must be a positive number (got "${raw}")`,
    );
  }
  return n;
}

export interface RunIterateArgs {
  readonly pluginSkill: string;
  readonly maxIterations: number;
  readonly costCapUsd: number;
  readonly sourceRoot: string;
  readonly cacheRoot: string;
  readonly workerPort: number;
  readonly repoRoot: string;
  readonly workspace: string;
  readonly repoName: string;
  readonly workspaceCwd: string;
  readonly evalSetPath: string;
  readonly seed: number;
  readonly runsPerQuery: number;
  readonly parallel: number;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly pricingModel: string;
  readonly proposerModel?: string;
}

export function parseIterateArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RunIterateArgs {
  let pluginSkill = pickArg(argv, "plugin-skill");
  if (!pluginSkill) {
    const positional = argv.find((a) => !a.startsWith("--"));
    if (positional) pluginSkill = positional;
  }
  if (!pluginSkill) {
    throw new RunIterateArgsError(
      "missing <plugin>:<skill> (e.g. dev:debugging) — pass positionally or as --plugin-skill",
    );
  }

  const portRaw =
    pickArg(argv, "worker-port") ?? env.DANXBOT_WORKER_PORT ?? null;
  if (!portRaw) {
    throw new RunIterateArgsError(
      "missing --worker-port (no DANXBOT_WORKER_PORT env either)",
    );
  }
  const workerPort = parsePositiveInt("worker-port", portRaw);

  const repoRoot = pickArg(argv, "repo-root") ?? env.DANXBOT_REPO_ROOT ?? null;
  if (!repoRoot) {
    throw new RunIterateArgsError(
      "missing --repo-root (no DANXBOT_REPO_ROOT env either)",
    );
  }

  const maxIterationsRaw = pickArg(argv, "max-iterations");
  const maxIterations = maxIterationsRaw
    ? parsePositiveInt("max-iterations", maxIterationsRaw)
    : DEFAULT_MAX_ITERATIONS;
  if (maxIterations > HARD_MAX_ITERATIONS) {
    throw new RunIterateArgsError(
      `--max-iterations=${maxIterations} exceeds HARD_MAX_ITERATIONS=${HARD_MAX_ITERATIONS} (anti-runaway cap)`,
    );
  }

  const costCapRaw = pickArg(argv, "cost-cap-usd");
  const costCapUsd = costCapRaw
    ? parsePositiveFloat("cost-cap-usd", costCapRaw)
    : DEFAULT_COST_CAP_USD;

  const home = env.HOME ?? homedir();
  const sourceRoot =
    pickArg(argv, "source-root") ?? join(home, "web", "claude-plugins");
  const cacheRoot =
    pickArg(argv, "cache-root") ??
    join(home, ".claude", "plugins", "marketplaces", "newms-plugins");

  const workspace = pickArg(argv, "workspace") ?? "skill-eval";
  const repoName = pickArg(argv, "repo") ?? "danxbot";
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
    RunIterateArgsError,
  );

  const pricingModel =
    pickArg(argv, "pricing-model") ?? DEFAULT_PRICING_MODEL;

  const proposerModel = pickArg(argv, "proposer-model") ?? undefined;

  return {
    pluginSkill,
    maxIterations,
    costCapUsd,
    sourceRoot,
    cacheRoot,
    workerPort,
    repoRoot,
    workspace,
    repoName,
    workspaceCwd,
    evalSetPath,
    seed,
    runsPerQuery,
    parallel,
    timeoutMs,
    pollIntervalMs,
    pricingModel,
    proposerModel,
  };
}

export interface FormatIterateReportInput {
  readonly pluginSkill: string;
  readonly result: IterateResult;
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatIterateReport(
  input: FormatIterateReportInput,
): string {
  const { pluginSkill, result } = input;
  const lines: string[] = [];
  lines.push(`# Skill-eval iterate report: ${pluginSkill}`);
  lines.push("");
  const verdictWord =
    result.status === "green"
      ? "GREEN"
      : result.status === "max-iterations"
        ? "MAX-ITERATIONS"
        : result.status === "cost-cap"
          ? "COST-CAP"
          : "FATAL-ERROR";
  lines.push(`**Status: ${result.status}** (${verdictWord})`);
  lines.push("");
  lines.push(
    `Best test accuracy: ${formatPct(result.bestTestAccuracy)} at iteration ${result.bestIteration}.`,
  );
  lines.push(
    `Total cost: ~$${result.totalCostUsd.toFixed(2)} (estimated, see per-iteration breakdown).`,
  );
  if (result.rolledBackTo !== undefined) {
    lines.push(
      `Rolled back to best (iteration ${result.rolledBackTo}) — last proposal regressed below the prior best.`,
    );
  }
  lines.push("");
  lines.push("## Iterations");
  lines.push("");
  lines.push("| # | Train | Test | Cost (~$) | Sha | Status |");
  lines.push("|---|---|---|---|---|---|");
  for (const it of result.iterations) {
    lines.push(
      `| ${it.iteration} | ${formatPct(it.trainAccuracy)} | ${formatPct(it.testAccuracy)} | ~$${it.costUsd.toFixed(2)} | ${it.commitSha ?? "—"} | ${it.status} |`,
    );
  }

  const errored = result.iterations.filter(
    (it) => it.proposerError ?? it.reloadError ?? it.editError,
  );
  if (errored.length > 0) {
    lines.push("");
    lines.push("## Errors");
    lines.push("");
    for (const it of errored) {
      lines.push(`### Iteration ${it.iteration}`);
      if (it.proposerError) lines.push(`- proposerError: ${it.proposerError}`);
      if (it.reloadError) lines.push(`- reloadError: ${it.reloadError}`);
      if (it.editError) lines.push(`- editError: ${it.editError}`);
    }
  }

  return lines.join("\n");
}

async function defaultGitExec(
  cmd: string,
  args: readonly string[],
): Promise<GitExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, [...args]);
    return { stdout, stderr, exitCode: 0, cmd, args: [...args] };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? (e as Error).message,
      exitCode: typeof err.code === "number" ? err.code : 1,
      cmd,
      args: [...args],
    };
  }
}

interface BuildEvalSetCallbackArgs {
  readonly cliArgs: RunIterateArgs;
  readonly pricingModel: string;
}

function buildRunEvalSetCallback(args: BuildEvalSetCallbackArgs) {
  return async (): Promise<IterationEvalSummary> => {
    const queries = loadEvalSet(args.cliArgs.evalSetPath);
    const result = await runEvalSetCore(
      {
        pluginSkill: args.cliArgs.pluginSkill,
        evalSetPath: args.cliArgs.evalSetPath,
        workspace: args.cliArgs.workspace,
        workerPort: args.cliArgs.workerPort,
        repoName: args.cliArgs.repoName,
        workspaceCwd: args.cliArgs.workspaceCwd,
        timeoutMs: args.cliArgs.timeoutMs,
        pollIntervalMs: args.cliArgs.pollIntervalMs,
        parallel: args.cliArgs.parallel,
        seed: args.cliArgs.seed,
        runsPerQuery: args.cliArgs.runsPerQuery,
        pricingModel: args.pricingModel,
      },
      queries,
      runProbe,
    );
    const trainAcc = aggregateSide("train", result.trainVerdicts).accuracy;
    const testAcc = aggregateSide("test", result.testVerdicts).accuracy;
    return {
      trainAccuracy: trainAcc,
      testAccuracy: testAcc,
      trainVerdicts: result.trainVerdicts,
      testVerdicts: result.testVerdicts,
      totalCostUsd: result.totalCostUsd,
      reportMarkdown: result.markdown,
    };
  };
}

function fail(msg: string): never {
  process.stderr.write(`FAIL ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<number> {
  let args: RunIterateArgs;
  try {
    args = parseIterateArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof RunIterateArgsError) fail(e.message);
    throw e;
  }

  const paths = resolvePluginSkillPaths({
    pluginSkill: args.pluginSkill,
    sourceRoot: args.sourceRoot,
    cacheRoot: args.cacheRoot,
  });

  if (!existsSync(args.workspaceCwd)) {
    fail(
      `workspace cwd does not exist: ${args.workspaceCwd} — check --workspace / --repo-root`,
    );
  }
  if (!existsSync(args.evalSetPath)) {
    fail(
      `eval-set not found at ${args.evalSetPath} — run /skill-eval <plugin>:<skill> first to confirm the eval-set is in place`,
    );
  }

  const apiKey = config.anthropic.apiKey;
  if (!apiKey) {
    fail(
      "ANTHROPIC_API_KEY is not configured — the proposer cannot run without it",
    );
  }
  const anthropic = new Anthropic({ apiKey });
  const proposer = makeAnthropicProposer({
    client: anthropic,
    model: args.proposerModel,
  });

  const relativeSkillPath = relative(args.sourceRoot, paths.sourceSkillPath);

  const iterateArgs: IterateArgs = {
    pluginSkill: args.pluginSkill,
    sourceSkillPath: paths.sourceSkillPath,
    cacheSkillPath: paths.cacheSkillPath,
    sourceRepoRoot: args.sourceRoot,
    cacheRepoRoot: args.cacheRoot,
    relativeSkillPath,
    maxIterations: args.maxIterations,
    costCapUsd: args.costCapUsd,
  };

  process.stderr.write(
    `Iterating ${args.pluginSkill} (max ${args.maxIterations}, cost cap ~$${args.costCapUsd.toFixed(2)})\n`,
  );
  process.stderr.write(`Source: ${paths.sourceSkillPath}\n`);
  process.stderr.write(`Cache:  ${paths.cacheSkillPath}\n`);

  const result = await iterate(iterateArgs, {
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
    runEvalSet: buildRunEvalSetCallback({
      cliArgs: args,
      pricingModel: args.pricingModel,
    }),
    proposer,
    gitCommitPush: commitAndPushDescription,
    reloadAndVerify,
    gitExec: defaultGitExec,
  });

  const md = formatIterateReport({ pluginSkill: args.pluginSkill, result });
  process.stdout.write(md);
  process.stdout.write("\n");

  return result.status === "green" ? 0 : 1;
}

const invokedAsScript =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /run-iterate\.ts$|run-iterate\.js$/.test(process.argv[1]);
if (invokedAsScript) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      fail(`unexpected runner error: ${(err as Error).stack ?? err}`);
    });
}

// `IterationRecord` is referenced by the CLI's report formatter input
// shape — re-export so callers do not have to dual-import iterate.js.
export type { IterationRecord };
