/**
 * Shared process utilities for spawning Claude Code CLI agents.
 *
 * Extracted from launchAgent and spawnHeadlessAgent to eliminate duplication.
 * Both functions compose from these building blocks.
 */

import { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentJob } from "./launcher.js";

/**
 * Build a clean environment by stripping CLAUDECODE vars from process.env.
 * Optionally merges additional vars on top.
 */
export function buildCleanEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CLAUDECODE")) continue;
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

/**
 * Log a prompt (and optionally agents config) to disk for debugging.
 * Non-fatal — errors are logged but don't stop the agent.
 */
export function logPromptToDisk(
  logsDir: string,
  jobId: string,
  prompt: string,
  agents?: Array<Record<string, unknown>>,
): void {
  const logDir = join(logsDir, jobId);
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "prompt.md"), prompt);
    if (agents && agents.length > 0) {
      writeFileSync(join(logDir, "agents.json"), JSON.stringify(agents, null, 2));
    }
    console.log(`[Job ${jobId}] Prompt logged to ${logDir}`);
  } catch (err) {
    console.error(`[Job ${jobId}] Failed to write agent logs:`, err);
  }
}

/**
 * Create an inactivity timer that kills the child process after a period of no stdout.
 * Returns reset/clear functions. Callers should attach reset() to child.stdout "data" events.
 */
export function createInactivityTimer(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout: (job: AgentJob) => void,
  job: AgentJob,
): { reset: () => void; clear: () => void } {
  let handle: ReturnType<typeof setTimeout>;

  function reset(): void {
    clearTimeout(handle);
    handle = setTimeout(() => {
      if (job.status === "running") {
        console.log(
          `[Job ${job.id}] Inactivity timeout — no output for ${timeoutMs / 1000}s — killing process`,
        );
        child.kill("SIGTERM");
        job.status = "timeout";
        job.summary = `Agent timed out after ${Math.round(timeoutMs / 1000)} seconds of inactivity`;
        job.completedAt = new Date();
        onTimeout(job);
      }
    }, timeoutMs);
  }

  // Start the initial timer
  reset();

  return {
    reset,
    clear: () => clearTimeout(handle),
  };
}

export interface ProcessHandlerOptions {
  /** Called after job transitions to a terminal state */
  onComplete?: (job: AgentJob) => void;
  /** Additional cleanup to run on close/error (e.g. clear timers, remove temp dirs) */
  cleanup?: () => void;
}

/**
 * Set up close and error handlers on a child process that update the AgentJob.
 *
 * On clean exit (code 0): status = "completed", summary = last assistant text.
 * On error exit: status = "failed", summary includes stderr or exit code.
 * On spawn error: status = "failed", summary includes error message.
 */
export function setupProcessHandlers(
  child: ChildProcess,
  job: AgentJob,
  getLastAssistantText: () => string,
  getStderr: () => string,
  options: ProcessHandlerOptions,
): void {
  child.on("close", (code: number | null) => {
    options.cleanup?.();
    if (job.status === "running") {
      const isSuccess = code === 0;
      job.status = isSuccess ? "completed" : "failed";
      job.summary = isSuccess
        ? getLastAssistantText().trim() || "Agent completed successfully"
        : `Process exited with code ${code}: ${getStderr().trim() || getLastAssistantText().trim() || "No output"}`;
      job.completedAt = new Date();

      console.log(`[Job ${job.id}] ${job.status} (exit code: ${code})`);
      if (!isSuccess && job.summary) {
        console.error(`[Job ${job.id}] ${job.summary}`);
      }
      options.onComplete?.(job);
    }
  });

  child.on("error", (err: Error) => {
    options.cleanup?.();
    if (job.status === "running") {
      job.status = "failed";
      job.summary = `Process error: ${err.message}`;
      job.completedAt = new Date();

      console.error(`[Job ${job.id}] Process error:`, err);
      options.onComplete?.(job);
    }
  });
}
