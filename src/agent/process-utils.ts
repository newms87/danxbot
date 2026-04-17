/**
 * Shared process utilities for spawning Claude Code CLI agents.
 *
 * Building blocks used by spawnAgent():
 *   - `buildCleanEnv`          env setup (strip CLAUDECODE vars)
 *   - `logPromptToDisk`        debug-log prompts + agent configs
 *   - `createInactivityTimer`  runtime-agnostic timer — takes a kill callback
 *                              so docker (ChildProcess.kill) and host
 *                              (process.kill(pid, sig)) can share the logic
 *   - `setupProcessHandlers`   docker-only close/error wiring (host mode
 *                              uses the PID liveness watcher in host-pid.ts)
 */

import { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import type { AgentJob } from "./launcher.js";

const log = createLogger("process-utils");

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
    log.info(`[Job ${jobId}] Prompt logged to ${logDir}`);
  } catch (err) {
    log.error(`[Job ${jobId}] Failed to write agent logs:`, err);
  }
}

/**
 * Create an inactivity timer that kills the agent process after a period of no
 * watcher activity. Returns reset/clear functions. Callers attach `reset()` to
 * `SessionLogWatcher.onEntry` — the single source of truth for agent activity
 * (see `.claude/rules/agent-dispatch.md`). Stdout is not a monitoring channel.
 *
 * `killProcess` abstracts the runtime difference: docker mode closes over a
 * `ChildProcess.kill`; host mode closes over a PID-based `process.kill(pid, signal)`.
 */
export function createInactivityTimer(
  killProcess: (signal: NodeJS.Signals) => void,
  timeoutMs: number,
  onTimeout: (job: AgentJob) => void,
  job: AgentJob,
): { reset: () => void; clear: () => void } {
  let handle: ReturnType<typeof setTimeout>;

  function reset(): void {
    clearTimeout(handle);
    handle = setTimeout(() => {
      if (job.status === "running") {
        log.info(
          `[Job ${job.id}] Inactivity timeout — no output for ${timeoutMs / 1000}s — killing process`,
        );
        killProcess("SIGTERM");
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
      // If cancelJob() set _canceling before sending SIGTERM, honor that intent
      const isCanceled = job._canceling === true;
      const isSuccess = !isCanceled && code === 0;
      job.status = isCanceled ? "canceled" : isSuccess ? "completed" : "failed";
      job.summary = isCanceled
        ? "Agent was canceled by user request"
        : isSuccess
          ? getLastAssistantText().trim() || "Agent completed successfully"
          : `Process exited with code ${code}: ${getStderr().trim() || getLastAssistantText().trim() || "No output"}`;
      job.completedAt = new Date();

      log.info(`[Job ${job.id}] ${job.status} (exit code: ${code})`);
      if (!isSuccess && job.summary) {
        log.error(`[Job ${job.id}] ${job.summary}`);
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

      log.error(`[Job ${job.id}] Process error:`, err);
      options.onComplete?.(job);
    }
  });
}
