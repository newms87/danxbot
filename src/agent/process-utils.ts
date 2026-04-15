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

/** Parsed stream event from Claude Code CLI --output-format stream-json. */
export interface AssistantMessage {
  content?: Array<{ type: string; text?: string }>;
}

/**
 * Extract the text from an assistant-type stream event.
 * Returns the last text block's content, or undefined if not an assistant event.
 */
export function extractAssistantText(event: Record<string, unknown>): string | undefined {
  if (event.type !== "assistant") return undefined;

  const message = event.message as AssistantMessage | undefined;
  if (!message?.content) return undefined;

  let lastText: string | undefined;
  for (const block of message.content) {
    if (block.type === "text" && block.text) {
      lastText = block.text;
    }
  }
  return lastText;
}

/**
 * Create a buffered stream-json line parser for a child process stdout.
 *
 * Attaches to `child.stdout` and calls `onEvent` for each valid JSON line.
 * Returns a getter for the last assistant text seen (used for job summaries).
 */
export function attachStreamParser(
  child: ChildProcess,
  onEvent?: (event: Record<string, unknown>) => void,
): { getLastAssistantText: () => string } {
  let stdoutBuffer = "";
  let lastAssistantText = "";

  child.stdout?.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();

    let newlineIdx: number;
    while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.substring(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.substring(newlineIdx + 1);

      if (!line) continue;

      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const text = extractAssistantText(event);
        if (text) {
          lastAssistantText = text;
        }
        onEvent?.(event);
      } catch {
        // Non-JSON line from CLI — not actionable, skip silently
      }
    }
  });

  return { getLastAssistantText: () => lastAssistantText };
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
 * Write stderr and stdout logs to disk for post-mortem debugging.
 * Non-fatal — errors are logged but don't stop execution.
 */
export function writeJobLogs(
  logsDir: string,
  jobId: string,
  stderr: string,
  stdout: string,
): void {
  const logDir = join(logsDir, jobId);
  try {
    mkdirSync(logDir, { recursive: true });
    if (stderr) writeFileSync(join(logDir, "stderr.log"), stderr);
    if (stdout) writeFileSync(join(logDir, "stdout.jsonl"), stdout);
  } catch (err) {
    console.error(`[Job ${jobId}] Failed to write job logs:`, err);
  }
}

/**
 * Create an inactivity timer that kills the child process after a period of no stdout.
 * Returns reset/clear functions. The timer auto-resets on every stdout data event.
 */
export function createInactivityTimer(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout: (job: AgentJob) => void,
  job: AgentJob,
): { clear: () => void } {
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

  // Reset on every stdout chunk
  child.stdout?.on("data", () => reset());
  // Start the initial timer
  reset();

  return {
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
