#!/usr/bin/env -S npx tsx
/**
 * One-shot CLI for the skill-eval harness.
 *
 *   npx tsx src/skill-eval/run.ts \
 *     --query "<prompt>" \
 *     --expect-skill <plugin>:<skill>
 *
 * Flow:
 *   1. POST `/api/launch` against the local danxbot worker, targeting the
 *      `skill-eval` workspace (full plugin set, isolated JSONL dir).
 *   2. Poll `/api/status/<jobId>` until the dispatch reaches a terminal
 *      status. We never call `claude -p` — host-mode dispatch is the only
 *      spawn shape so the probe bypasses Claude Code bugs #36570 and #556
 *      that affect `-p`-mode skill loading.
 *   3. Find the resulting session JSONL by scanning the workspace's
 *      encoded-cwd projects directory for the dispatch tag.
 *   4. Hand the JSONL to `evaluateSkillTrigger` and emit a single PASS/FAIL
 *      line followed by the absolute JSONL path.
 *
 * Exit codes:
 *   0 — PASS
 *   1 — FAIL (skill not triggered)
 *   2 — runner error (worker unreachable, dispatch failure, JSONL missing)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { deriveSessionDir } from "../agent/session-log-watcher.js";
import {
  evaluateSkillTrigger,
  type SkillTriggerVerdict,
} from "./jsonl-parser.js";

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

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "timeout",
  "recovered",
  "critical_failure",
  "api_error_recover",
  "api_error_failed",
]);

export class RunnerArgsError extends Error {}

function fail(msg: string): never {
  process.stderr.write(`FAIL ${msg}\n`);
  process.exit(2);
}

export function pickArg(argv: readonly string[], name: string): string | null {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return null;
}

/**
 * Validate that `raw` is a base-10 positive integer with no trailing
 * non-digits. `Number.parseInt("5563abc")` returns `5563` — fine for
 * lenient input, dangerous for a config value the operator typed. The
 * `Number()` cast is intentionally strict.
 */
export function parsePositiveInt(name: string, raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new RunnerArgsError(
      `invalid --${name}: must be a positive integer (got "${raw}")`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RunnerArgsError(
      `invalid --${name}: must be a positive integer (got "${raw}")`,
    );
  }
  return n;
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

async function postLaunch(args: RunnerArgs): Promise<string> {
  const url = `http://localhost:${args.workerPort}/api/launch`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: args.repoName,
        workspace: args.workspace,
        task: args.query,
        title: `skill-eval ${args.expectSkill}`,
      }),
    });
  } catch (err) {
    fail(`worker unreachable at ${url}: ${(err as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    fail(`launch returned ${response.status}: ${text}`);
  }
  let body: { job_id?: string };
  try {
    body = JSON.parse(text);
  } catch {
    fail(`launch returned non-JSON body: ${text}`);
  }
  if (!body.job_id) fail(`launch response missing job_id: ${text}`);
  return body.job_id;
}

async function pollUntilTerminal(
  args: RunnerArgs,
  jobId: string,
): Promise<string> {
  const url = `http://localhost:${args.workerPort}/api/status/${jobId}`;
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      fail(`status poll failed: ${(err as Error).message}`);
    }
    if (response.status === 404) {
      // job evicted from activeJobs after TTL — treat as terminal.
      return "completed";
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable>");
      fail(`status returned ${response.status}: ${text}`);
    }
    const body = (await response.json()) as { status?: string };
    if (body.status && TERMINAL_STATUSES.has(body.status)) {
      return body.status;
    }
    await new Promise((r) => setTimeout(r, args.pollIntervalMs));
  }
  fail(
    `dispatch did not reach terminal status within ${args.timeoutMs}ms — jobId=${jobId}`,
  );
}

/**
 * Diagnostic returned by JSONL discovery so the runner can map each
 * failure mode to a distinct operator-readable message. Three failure
 * modes the operator must distinguish: (a) the session dir was never
 * created (claude never attached — usually broken auth, see
 * `agent-dispatch.md` "silent dispatch failures"); (b) the dir exists
 * but no JSONL contained the tag (wrong workspace cwd, or claude wrote
 * to a different cwd); (c) one or more files were unreadable
 * (permissions). Collapsing them into one "JSONL not found" string is
 * a fail-quiet anti-pattern.
 */
export interface JsonlDiscovery {
  path: string | null;
  dir: string;
  reason:
    | "found"
    | "dir-missing"
    | "no-files"
    | "tag-not-in-any-file"
    | "unreadable-files";
  scannedFiles: number;
  unreadableFiles: readonly string[];
}

export function findJsonlByTag(
  workspaceCwd: string,
  dispatchTag: string,
): JsonlDiscovery {
  const dir = deriveSessionDir(workspaceCwd);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return {
      path: null,
      dir,
      reason: "dir-missing",
      scannedFiles: 0,
      unreadableFiles: [],
    };
  }
  const candidates = entries
    .filter((e) => e.endsWith(".jsonl"))
    .map((name) => {
      const path = resolve(dir, name);
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { path: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime);

  if (candidates.length === 0) {
    return {
      path: null,
      dir,
      reason: "no-files",
      scannedFiles: 0,
      unreadableFiles: [],
    };
  }

  const unreadable: string[] = [];
  let scanned = 0;
  for (const { path } of candidates) {
    scanned++;
    let contents: string;
    try {
      contents = readFileSync(path, "utf-8");
    } catch {
      unreadable.push(path);
      continue;
    }
    if (contents.includes(dispatchTag)) {
      return {
        path,
        dir,
        reason: "found",
        scannedFiles: scanned,
        unreadableFiles: unreadable,
      };
    }
  }
  return {
    path: null,
    dir,
    reason: unreadable.length > 0 ? "unreadable-files" : "tag-not-in-any-file",
    scannedFiles: scanned,
    unreadableFiles: unreadable,
  };
}

export function dispatchTagFor(jobId: string): string {
  return `<!-- danxbot-dispatch:${jobId} -->`;
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

function failDiscovery(disc: JsonlDiscovery, jobId: string): never {
  const tag = dispatchTagFor(jobId);
  switch (disc.reason) {
    case "dir-missing":
      fail(
        `session dir does not exist — claude never attached. Usually means broken claude-auth or wrong workspace cwd. Expected ${disc.dir}`,
      );
    case "no-files":
      fail(
        `session dir is empty (${disc.dir}) — dispatch ${jobId} may have failed before writing any JSONL`,
      );
    case "tag-not-in-any-file":
      fail(
        `scanned ${disc.scannedFiles} JSONL file(s) in ${disc.dir}; none contained dispatch tag ${tag}`,
      );
    case "unreadable-files":
      fail(
        `scanned ${disc.scannedFiles} JSONL file(s); ${disc.unreadableFiles.length} unreadable (permissions?). No file contained dispatch tag ${tag}. Unreadable: ${disc.unreadableFiles.join(", ")}`,
      );
    case "found":
      throw new Error(
        "findJsonlByTag returned reason=found but path was null — runner bug",
      );
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
  const jobId = await postLaunch(args);
  process.stderr.write(`Dispatch jobId=${jobId}; polling...\n`);
  const finalStatus = await pollUntilTerminal(args, jobId);
  process.stderr.write(`Dispatch terminal status=${finalStatus}\n`);

  const tag = dispatchTagFor(jobId);
  const disc = findJsonlByTag(args.workspaceCwd, tag);
  if (disc.reason !== "found" || !disc.path) {
    failDiscovery(disc, jobId);
  }

  const jsonl = readFileSync(disc.path, "utf-8");
  const verdict = evaluateSkillTrigger(jsonl, tag, args.expectSkill);
  emitVerdict(verdict, disc.path, jobId);
  return verdict.pass ? 0 : 1;
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
