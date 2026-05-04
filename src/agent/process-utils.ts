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
 *
 * Forces ENABLE_TOOL_SEARCH=0 for dispatched agents. Claude Code's default
 * deferred-tool-loading system lists MCP tool NAMES but hides their schemas
 * until the agent calls ToolSearch. Dispatched prompts (schema-builder,
 * gpt-manager orchestrator, etc.) expect mcp__* tools to be directly callable
 * without ToolSearch discovery — they assume eager loading and forbid
 * ToolSearch to keep the prompt tight. Setting ENABLE_TOOL_SEARCH=0 makes all
 * MCP tools eager at session start, matching those prompts' assumptions.
 * Callers can override via extras when they want deferred behavior.
 */
export function buildCleanEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CLAUDECODE")) continue;
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.ENABLE_TOOL_SEARCH = "0";

  // When CLAUDE_AUTH_MODE=subscription, the dispatched claude CLI
  // authenticates via ~/.claude/.credentials.json OAuth. Claude Code's
  // precedence is ANTHROPIC_API_KEY > OAuth, so we must strip the env var
  // here — otherwise an invalid/stale key silently blocks the subscription
  // fallback and every dispatch fails with "Invalid API key". The router
  // and heartbeat still need ANTHROPIC_API_KEY (they use the Anthropic SDK
  // via config.anthropic.apiKey); they read process.env directly and never
  // go through buildCleanEnv, so they're unaffected.
  if (process.env.CLAUDE_AUTH_MODE === "subscription") {
    delete env.ANTHROPIC_API_KEY;
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
  agents?: Record<string, Record<string, unknown>>,
): void {
  const logDir = join(logsDir, jobId);
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "prompt.md"), prompt);
    if (agents && Object.keys(agents).length > 0) {
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
  /**
   * Additional cleanup to run on close/error. Returns a promise — the
   * launcher's wrapper caches the in-flight promise and returns it on
   * subsequent calls so concurrent invokers (close handler racing
   * cancelJob, defensive re-runs, etc.) all observe the SAME drain +
   * finalize chain. Fire-and-forget here is acceptable because onComplete
   * callers depend on the in-memory `job` state, not on the DB row's
   * eventual finalize commit.
   */
  cleanup?: () => Promise<void>;
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
  child.on("close", async (code: number | null) => {
    // Order matters: transition job.status BEFORE invoking cleanup. Cleanup
    // observers (DispatchTracker.finalize, Laravel forwarder flush) read
    // job.status to decide what to write — running cleanup first leaves the
    // dispatch row stuck at "running" forever. Mirrors job.stop()'s ordering.
    if (job.status === "running") {
      // Drain the watcher BEFORE reading lastAssistantText. The watcher
      // polls JSONL on a 5s cadence, so the agent's final assistant turn
      // can land on disk between the last scheduled poll and process
      // exit — capturing summary without draining left job.summary
      // stuck on the previous assistant text (e.g. "I'll help you with
      // that task." instead of the final "Task completed successfully").
      // Same race the dispatch-tracker's finalize already fixed for
      // usage totals; this closes it for the in-memory summary that
      // onComplete callers consume synchronously.
      //
      // Catch rather than rethrow: an unhandled rejection inside a Node
      // 'close' listener strands the job mid-transition (status stays
      // "running" forever, cleanup never fires, dispatch row never
      // finalizes). Logging + falling through to the synchronous summary
      // capture is strictly better — at worst job.summary carries the
      // pre-drain lastAssistantText, which is what behaviour was before
      // the drain was added; at best the partial drain still updated it.
      try {
        await job.watcher?.drain();
      } catch (err) {
        log.error(`[Job ${job.id}] watcher.drain() failed during close handler — falling back to last observed assistant text`, err);
      }

      const isSuccess = code === 0;
      job.status = isSuccess ? "completed" : "failed";
      job.summary = isSuccess
        ? getLastAssistantText().trim() || "Agent completed successfully"
        : `Process exited with code ${code}: ${getStderr().trim() || getLastAssistantText().trim() || "No output"}`;
      job.completedAt = new Date();

      log.info(`[Job ${job.id}] ${job.status} (exit code: ${code})`);
      if (!isSuccess && job.summary) {
        log.error(`[Job ${job.id}] ${job.summary}`);
      }
      // Fire-and-forget: cleanup awaits drain + finalize internally so the
      // dispatch row converges to the right totals on its own. We do NOT
      // await here — onComplete callers (poller card-progress check, etc.)
      // depend on the in-memory `job` state which is set above, not on the
      // DB row, so blocking onComplete on the DB write would only add
      // latency without changing observable behavior.
      void options.cleanup?.();
      options.onComplete?.(job);
    } else {
      // Status was set by cancelJob/job.stop/inactivity/max-runtime — those
      // paths invoke cleanup directly. Calling it again here is intentional:
      // the launcher's `cleanupRan` flag makes the redundant call a no-op,
      // and this branch ensures cleanup STILL runs if the pre-set path
      // forgot to invoke it (defensive — fail loud, not silent).
      void options.cleanup?.();
    }
  });

  child.on("error", (err: Error) => {
    if (job.status === "running") {
      job.status = "failed";
      job.summary = `Process error: ${err.message}`;
      job.completedAt = new Date();

      log.error(`[Job ${job.id}] Process error:`, err);
      void options.cleanup?.();
      options.onComplete?.(job);
    } else {
      // See close-handler else branch above — same idempotency guarantee.
      void options.cleanup?.();
    }
  });
}
