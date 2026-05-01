/**
 * Shell execution helpers for the deploy CLI.
 * Wraps child_process with consistent error handling and output capture.
 *
 * Dry-run mode: when `setDryRun(true)` is in effect, run/runStreaming/tryRun
 * print the command they would have executed and return a placeholder result
 * (empty string for run, null for tryRun, void for runStreaming) instead of
 * shelling out. Callers that need different behavior in dry-run (e.g. return
 * synthetic Terraform outputs, skip a writeFileSync, swap a real GitHub token
 * for a placeholder) consult `isDryRun()` directly. The module-level flag is
 * scoped to `cli.ts main()` for the deploy command — tests must reset it via
 * `setDryRun(false)` in afterEach to avoid leaking state across cases.
 */

import {
  exec as execCb,
  execSync,
  type ExecSyncOptions,
} from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

let dryRunEnabled = false;

export function setDryRun(value: boolean): void {
  dryRunEnabled = value;
}

export function isDryRun(): boolean {
  return dryRunEnabled;
}

/**
 * Run a shell command and return stdout. Throws on non-zero exit.
 *
 * In dry-run, prints `[dry-run] $ <cmd>` and returns "" without executing.
 * Returning empty matches the contract of "command produced no output" —
 * callers that parse stdout (e.g. terraform output -json) MUST consult
 * `isDryRun()` and short-circuit before this point, since "" won't parse.
 */
export function run(cmd: string, options?: ExecSyncOptions): string {
  if (dryRunEnabled) {
    console.log(`  [dry-run] $ ${cmd}`);
    return "";
  }
  console.log(`  $ ${cmd}`);
  const result = execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
  return String(result).trim();
}

/**
 * Run a shell command, streaming stdout/stderr to the terminal.
 * Throws on non-zero exit.
 *
 * `logLabel`, when provided, replaces the echoed command in the log line so
 * callers invoking commands with secrets in argv (e.g. `aws ssm put-parameter
 * --value '<SECRET>'`) can show a non-sensitive label instead.
 *
 * In dry-run, prints `[dry-run] $ <logLabel ?? cmd>` and returns without
 * executing. The same `logLabel` redaction applies — secrets in argv are
 * never echoed even in dry-run output.
 */
export function runStreaming(
  cmd: string,
  options?: ExecSyncOptions & { logLabel?: string },
): void {
  const { logLabel, ...execOptions } = options ?? {};
  if (dryRunEnabled) {
    console.log(`  [dry-run] $ ${logLabel ?? cmd}`);
    return;
  }
  console.log(`  $ ${logLabel ?? cmd}`);
  execSync(cmd, {
    encoding: "utf-8",
    stdio: "inherit",
    ...execOptions,
  });
}

/**
 * Run multiple shell commands concurrently, capturing their output.
 * Throws if ANY command fails (after all in-flight commands settle).
 *
 * Used for parallel `aws ssm put-parameter` calls during deploy. Each
 * command runs in its own subprocess; concurrency is capped by `limit` so
 * we don't overrun AWS's PutParameter throttle (~40 TPS default) or the
 * local fork limit. Output is captured (not streamed) so the per-command
 * log line stays on its own row instead of interleaving with other
 * commands' stdout.
 *
 * In dry-run, prints `[dry-run] $ <logLabel ?? cmd>` for each command and
 * returns without executing.
 */
export async function runStreamingParallel(
  cmds: { cmd: string; logLabel?: string }[],
  limit: number,
): Promise<void> {
  if (dryRunEnabled) {
    for (const { cmd, logLabel } of cmds) {
      console.log(`  [dry-run] $ ${logLabel ?? cmd}`);
    }
    return;
  }
  if (cmds.length === 0) return;

  let nextIndex = 0;
  const failures: Error[] = [];
  const workerCount = Math.max(1, Math.min(limit, cmds.length));

  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= cmds.length) return;
      const { cmd, logLabel } = cmds[i];
      console.log(`  $ ${logLabel ?? cmd}`);
      try {
        await execAsync(cmd, {
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        });
      } catch (err) {
        failures.push(err as Error);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failures.length > 0) {
    const first = failures[0];
    throw new Error(
      `${failures.length}/${cmds.length} command(s) failed during parallel run. First error: ${first.message}`,
    );
  }
}

/**
 * Run a shell command, returning stdout without throwing on failure.
 * Returns null if the command fails.
 *
 * In dry-run, prints `[dry-run] $ <cmd>` and returns null without executing.
 * Returning null mirrors "command failed" — useful for `bootstrapBackend`'s
 * head-bucket / describe-table probes, where null fall-through into the
 * create-bucket / create-table branch lets dry-run print the full would-run
 * pipeline (head-bucket then create-bucket then put-versioning, etc.) instead
 * of stopping at the first probe.
 */
export function tryRun(cmd: string, options?: ExecSyncOptions): string | null {
  if (dryRunEnabled) {
    console.log(`  [dry-run] $ ${cmd}`);
    return null;
  }
  try {
    return run(cmd, options);
  } catch {
    return null;
  }
}

/**
 * Build an AWS CLI command with the given profile.
 */
export function awsCmd(profile: string, cmd: string): string {
  const profileFlag = profile ? `--profile ${profile}` : "";
  return `aws ${profileFlag} ${cmd}`.replace(/\s+/g, " ").trim();
}
