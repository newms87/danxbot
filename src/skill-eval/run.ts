#!/usr/bin/env -S npx tsx
/**
 * Single-query CLI for the skill-eval harness.
 *
 *   npx tsx src/skill-eval/run.ts \
 *     --query "<prompt>" \
 *     --expect-skill <plugin>:<skill>
 *
 * Thin wrapper over `runProbe` in `./probe.ts`. Owns:
 *   - CLI argv parsing (--query, --expect-skill, env-aware defaults)
 *   - PASS/FAIL exit code translation
 *   - stdout/stderr formatting of the single probe verdict
 *
 * For eval-set runs (a JSON file of queries instead of a single
 * --query) use `run-eval-set.ts`. Both CLIs share `runProbe`.
 *
 * Exit codes:
 *   0 — PASS
 *   1 — FAIL (skill not triggered)
 *   2 — runner error (worker unreachable, dispatch failure, JSONL missing)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  parsePositiveInt as parsePositiveIntShared,
  pickArg,
} from "./cli-args.js";
import { dispatchTagFor, runProbe, ProbeError } from "./probe.js";
import type { SkillTriggerVerdict } from "./jsonl-parser.js";

export interface RunnerArgs {
  query: string;
  expectSkill: string;
  workspace: string;
  workerPort: number;
  repoName: string;
  workspaceCwd: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS, pickArg };

export class RunnerArgsError extends Error {}

function fail(msg: string): never {
  process.stderr.write(`FAIL ${msg}\n`);
  process.exit(2);
}

/** Re-exported with this CLI's error class baked in for direct call-sites. */
export function parsePositiveInt(name: string, raw: string): number {
  return parsePositiveIntShared(name, raw, RunnerArgsError);
}

/**
 * Parse CLI argv into `RunnerArgs`. Throws `RunnerArgsError` on any
 * invalid value so callers can choose to fail-loud (CLI) or surface the
 * message (tests). Caller is responsible for converting to exit code.
 *
 * Repo root resolution order:
 *   1. `--repo-root` flag (explicit operator override)
 *   2. `DANXBOT_REPO_ROOT` env (the same var the danxbot MCP server reads)
 *   3. Throw — refusing to fall back to a workstation-specific default
 *      keeps the harness portable across operators.
 */
export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RunnerArgs {
  const query = pickArg(argv, "query");
  const expectSkill = pickArg(argv, "expect-skill");
  if (!query) throw new RunnerArgsError("missing --query");
  if (!expectSkill) {
    throw new RunnerArgsError("missing --expect-skill (e.g. dev:debugging)");
  }

  const workspace = pickArg(argv, "workspace") ?? "skill-eval";
  const repoName = pickArg(argv, "repo") ?? "danxbot";
  const portRaw =
    pickArg(argv, "worker-port") ?? env.DANXBOT_WORKER_PORT ?? null;
  if (!portRaw) {
    throw new RunnerArgsError(
      "missing --worker-port (no DANXBOT_WORKER_PORT env either)",
    );
  }
  const workerPort = parsePositiveInt("worker-port", portRaw);

  const repoRoot = pickArg(argv, "repo-root") ?? env.DANXBOT_REPO_ROOT ?? null;
  if (!repoRoot) {
    throw new RunnerArgsError(
      "missing --repo-root (no DANXBOT_REPO_ROOT env either) — supply the danxbot install dir",
    );
  }
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

  return {
    query,
    expectSkill,
    workspace,
    workerPort,
    repoName,
    workspaceCwd,
    timeoutMs,
    pollIntervalMs,
  };
}

function emitVerdict(
  verdict: SkillTriggerVerdict,
  jsonlPath: string,
  jobId: string,
): void {
  const line = verdict.pass ? "PASS" : "FAIL";
  process.stdout.write(`${line} ${verdict.reason}\n`);
  process.stdout.write(`jsonl: ${jsonlPath}\n`);
  process.stdout.write(`dispatch_tag: ${dispatchTagFor(jobId)}\n`);
  if (verdict.droppedLines > 0) {
    process.stdout.write(
      `WARN: ${verdict.droppedLines} unparseable JSONL line(s) skipped — verdict may be unreliable\n`,
    );
  }
  if (!verdict.pass) {
    if (verdict.skillCalls.length > 0) {
      process.stdout.write(`observed_skills: ${verdict.skillCalls.join(", ")}\n`);
    }
    if (verdict.firstAssistantText) {
      process.stdout.write(
        `first_assistant_text: ${verdict.firstAssistantText}\n`,
      );
    }
  }
}

async function main(): Promise<number> {
  let args: RunnerArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof RunnerArgsError) fail(err.message);
    throw err;
  }

  if (!existsSync(args.workspaceCwd)) {
    fail(
      `workspace cwd does not exist: ${args.workspaceCwd} — check --workspace / --repo-root`,
    );
  }

  process.stderr.write(
    `Launching skill-eval probe (query=${args.query.slice(0, 60)}${args.query.length > 60 ? "..." : ""}, expect=${args.expectSkill})\n`,
  );

  let result;
  try {
    result = await runProbe(args);
  } catch (err) {
    if (err instanceof ProbeError) fail(err.message);
    throw err;
  }

  process.stderr.write(`Dispatch jobId=${result.jobId}; status=${result.finalStatus}\n`);
  // result.jsonlPath is guaranteed non-null when runProbe returns
  // successfully (it throws ProbeError otherwise).
  emitVerdict(result.verdict, result.jsonlPath as string, result.jobId);
  return result.verdict.pass ? 0 : 1;
}

// Only run when invoked as a script — keeps the file importable by tests.
const invokedAsScript =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /run\.ts$|run\.js$/.test(process.argv[1]);
if (invokedAsScript) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      fail(`unexpected runner error: ${(err as Error).stack ?? err}`);
    });
}
