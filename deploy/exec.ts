/**
 * Shell execution helpers for the deploy CLI.
 * Wraps child_process with consistent error handling and output capture.
 */

import { execSync, type ExecSyncOptions } from "node:child_process";

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

/**
 * Run a shell command and return stdout. Throws on non-zero exit.
 */
export function run(cmd: string, options?: ExecSyncOptions): string {
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
 */
export function runStreaming(cmd: string, options?: ExecSyncOptions): void {
  console.log(`  $ ${cmd}`);
  execSync(cmd, {
    encoding: "utf-8",
    stdio: "inherit",
    ...options,
  });
}

/**
 * Run a shell command, returning stdout without throwing on failure.
 * Returns null if the command fails.
 */
export function tryRun(cmd: string, options?: ExecSyncOptions): string | null {
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
