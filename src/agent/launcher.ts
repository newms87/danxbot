/**
 * Agent Launcher — Spawns Claude Code agents via a single spawnAgent() entrypoint.
 *
 * Every agent process is monitored by a SessionLogWatcher that reads Claude Code's
 * native JSONL session files from disk. This works identically for piped mode
 * (headless) and terminal mode (interactive) because Claude Code writes JSONL
 * regardless of how it's invoked.
 *
 * Callers opt into features via SpawnAgentOptions:
 * - eventForwarding: batched event POSTs to Laravel API
 * - heartbeat: periodic status PUTs (dispatch API)
 * - openTerminal: also opens an interactive Windows Terminal tab
 * - mcpConfigPath: MCP server config for dispatch agents
 * - maxRuntimeMs: hard runtime cap
 */

import { join } from "node:path";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { createInactivityTimer } from "./process-utils.js";
import { SessionLogWatcher } from "./session-log-watcher.js";
import {
  createLaravelForwarder,
  deriveQueuePath,
} from "./laravel-forwarder.js";
import { EventQueue } from "./event-queue.js";
import { getDanxbotCommit } from "./danxbot-commit.js";
import {
  startDispatchTracking,
  type DispatchTracker,
} from "../dashboard/dispatch-tracker.js";
import {
  putStatus,
  startHeartbeat,
  notifyTerminalStatus,
} from "./agent-status.js";
import { runHostModeFork } from "./spawn-host-mode.js";
import { spawnDockerMode } from "./spawn-docker-mode.js";
import { attachUsageAccumulator } from "./usage-accumulator.js";
import { buildCleanup } from "./agent-cleanup.js";
import { buildJobStopHandler } from "./agent-stop.js";
import { runSpawnPreflight } from "./spawn-preflight.js";
import {
  type AgentJob,
  type SpawnAgentOptions,
  terminateWithGrace,
} from "./agent-types.js";

// Re-exported so the historical import surface
// (`import { putStatus, startHeartbeat, AgentJob, ... } from "../agent/launcher.js"`)
// keeps working — these symbols moved to sibling modules during the
// launcher.ts split (Trello g8NF9oat) but still belong to the launcher's
// public contract.
export { putStatus, startHeartbeat, stopHeartbeat } from "./agent-status.js";
export { buildCompletionInstruction } from "./completion-instruction.js";
export {
  type AgentJob,
  type AgentUsage,
  type SpawnAgentOptions,
  terminateWithGrace,
} from "./agent-types.js";

const log = createLogger("launcher");

/**
 * Spawn a Claude Code agent process.
 *
 * Always starts a SessionLogWatcher to monitor Claude's native JSONL session
 * files from disk. The watcher provides: inactivity timeout reset, job summary
 * extraction (last assistant text), and optional event forwarding.
 *
 * The dispatch tag (`<!-- danxbot-dispatch:jobId -->`) is prepended to the prompt
 * so the watcher can deterministically find the correct JSONL file.
 */
export async function spawnAgent(
  options: SpawnAgentOptions,
): Promise<AgentJob> {
  // Validate inputs, run auth + projects-dir + MCP-probe preflights, allocate
  // jobId, build the AgentJob skeleton, and resolve the claude invocation.
  // All failure modes throw loudly with no cleanup needed by the caller —
  // `runSpawnPreflight` self-cleans the prompt temp dir on MCP probe failure.
  const { jobId, job, env, flags, firstMessage, promptDir, agentCwd } =
    await runSpawnPreflight(options);

  // --- SessionLogWatcher: the single monitoring mechanism, runs identically in
  //     both docker and host modes (see `.claude/rules/agent-dispatch.md`). ---
  const watcher = new SessionLogWatcher({
    cwd: agentCwd,
    pollIntervalMs: 5_000,
    dispatchId: jobId,
  });
  job.watcher = watcher;

  // Watcher subscriber: tracks last assistant text for job summary,
  // accumulates per-turn usage (with multi-block dedup), and resets the
  // inactivity timer on every entry. See `usage-accumulator.ts` for the
  // dedup contract.
  const usageAccumulator = attachUsageAccumulator({
    job,
    watcher,
    onActivity: () => inactivityTimer.reset(),
  });

  // --- Optional event forwarding ---
  let forwarderFlush: (() => Promise<void>) | undefined;
  if (options.eventForwarding) {
    const queue = new EventQueue(
      deriveQueuePath(join(config.logsDir, "event-queue"), jobId),
    );
    const forwarder = createLaravelForwarder(
      options.eventForwarding.statusUrl,
      options.eventForwarding.apiToken,
      { queue },
    );
    watcher.onEntry(forwarder.consume);
    forwarderFlush = forwarder.flush;
  }

  // --- Optional dispatch tracking: create a dispatches row and finalize it
  //     when a terminal state is reached. Callers that should not appear in
  //     dispatch history (e.g., Slack router-only) omit options.dispatch. ---
  let dispatchTracker: DispatchTracker | undefined;
  if (options.dispatch) {
    dispatchTracker = await startDispatchTracking({
      jobId,
      repoName: options.repoName,
      trigger: options.dispatch,
      runtimeMode: config.isHost ? "host" : "docker",
      danxbotCommit: getDanxbotCommit(),
      watcher,
      startedAtMs: job.startedAt.getTime(),
      parentJobId: options.parentJobId ?? null,
    });
    job.dispatchTracker = dispatchTracker;
  }

  watcher.start();

  let termSettingsDirToClean: string | undefined;

  // --- Inactivity timer: resets on watcher entries, kills via the runtime-
  //     aware handle (docker: child.kill; host: process.kill(pid, sig)). ---
  const inactivityTimer = createInactivityTimer(
    (signal) => job.handle?.kill(signal),
    options.timeoutMs,
    (j) => {
      // Fire-and-forget: cleanup awaits drain + finalize internally so the
      // dispatch row converges on its own. The external Laravel PUT is a
      // separate store; a brief order skew vs. the local DB is acceptable.
      void cleanup();
      // The docker close-handler wrapper only PUTs when job.status === "running"
      // at close time; by the time the child exits here it will not issue a
      // terminal PUT. notifyTerminalStatus is the only signal the dispatcher
      // receives for an inactivity timeout.
      notifyTerminalStatus(j, options, "timeout", j.summary);
    },
    job,
  );

  // --- Optional heartbeat ---
  if (options.statusUrl && options.apiToken) {
    startHeartbeat(job, options.apiToken);
  }

  // --- Optional max runtime ---
  let maxRuntimeHandle: ReturnType<typeof setTimeout> | undefined;
  if (options.maxRuntimeMs) {
    maxRuntimeHandle = setTimeout(() => {
      if (job.status === "running") {
        log.info(
          `[Job ${jobId}] Max runtime exceeded — ${options.maxRuntimeMs! / 1000}s — killing process`,
        );
        job.handle?.kill("SIGTERM");
        job.status = "timeout";
        job.summary = `Agent exceeded max runtime of ${Math.round(options.maxRuntimeMs! / 1000 / 60)} minutes`;
        job.completedAt = new Date();
        // See inactivity-timer comment — fire-and-forget; cleanup awaits
        // drain + finalize internally.
        void cleanup();
        // See the inactivity-timer comment above — docker close-handler will
        // not issue a terminal PUT once job.status !== "running".
        notifyTerminalStatus(job, options, "timeout", job.summary);
      }
    }, options.maxRuntimeMs);
  }

  // Cache the in-flight cleanup promise so concurrent callers (e.g. the
  // close handler's `void cleanup()` racing cancelJob's `await
  // job._cleanup()`) all observe the SAME drain + finalize chain, instead of
  // the second caller short-circuiting on a flag and resolving its await
  // before the first chain has actually finished. A bare boolean flag would
  // satisfy idempotency but defeat the only reason cancelJob and job.stop
  // await the cleanup at all (sequencing the external `putStatus` PUT after
  // the dispatch row's finalize commit). The un-cached payload lives in
  // `agent-cleanup.ts`; this closure adds the cache + the catch.
  const runCleanup = buildCleanup({
    job,
    jobId,
    watcher,
    inactivityTimer,
    getMaxRuntimeHandle: () => maxRuntimeHandle,
    forwarderFlush,
    dispatchTracker,
    promptDir,
    getTermSettingsDir: () => termSettingsDirToClean,
  });
  let cleanupPromise: Promise<void> | undefined;
  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    // Catch so fire-and-forget callers (close handler, inactivity timer,
    // host onExit) never raise an unhandled rejection if drain/finalize
    // throw. Errors are logged via the inner try/catch around
    // `dispatchTracker.finalize`; this outer .catch is a defense-in-depth
    // net for everything else (drain itself, watcher.stop, forwarderFlush).
    cleanupPromise = runCleanup().catch((err) => {
      log.error(`[Job ${jobId}] Cleanup failed`, err);
    });
    return cleanupPromise;
  }

  job._cleanup = cleanup;
  job._onComplete = () => options.onComplete?.(job);

  // --- Agent-initiated stop mechanism ---
  // The agent calls stop() via the HTTP /api/stop/:jobId endpoint when lifecycle
  // tools signal completion. This is distinct from cancelJob() (user-initiated).
  // See `agent-stop.ts` for the SIGTERM/SIGKILL grace pattern + cleanup
  // ordering rationale.
  job.stop = buildJobStopHandler({
    job,
    jobId,
    cleanup,
    statusUrl: options.statusUrl,
    apiToken: options.apiToken,
    onComplete: options.onComplete,
  });

  // ============================================================================
  // Runtime fork — ONLY the spawn shape differs. Monitoring, heartbeat, stall
  // detection, event forwarding, completion signaling, and cancellation are all
  // identical across docker and host modes (see agent-dispatch.md).
  // ============================================================================
  if (options.openTerminal) {
    await runHostModeFork({
      job,
      jobId,
      options,
      flags,
      firstMessage,
      agentCwd,
      env,
      cleanup,
      getLastAssistantText: usageAccumulator.getLastAssistantText,
      registerTermDir: (dir) => {
        termSettingsDirToClean = dir;
      },
    });
  } else {
    spawnDockerMode({
      job,
      flags,
      firstMessage,
      agentCwd,
      env,
      getLastAssistantText: usageAccumulator.getLastAssistantText,
      cleanup,
      statusUrl: options.statusUrl,
      apiToken: options.apiToken,
      onComplete: options.onComplete,
    });
  }

  return job;
}

/**
 * Cancel a running job by sending SIGTERM, then SIGKILL after 5 seconds.
 * Works identically in docker (ChildProcess handle) and host (tracked PID) modes.
 *
 * Sets job.status="canceled" BEFORE sending SIGTERM so the close/exit handlers
 * (setupProcessHandlers in docker mode, spawnHostMode.onExit in host mode)
 * see a non-running status and early-return via their `job.status === "running"`
 * guards. Mirrors the pattern in job.stop() — the prior `_canceling` flag
 * only covered the docker path, leaving a host-mode race where onExit
 * overwrote status to "completed"/"failed" during the 5s grace wait.
 */
export async function cancelJob(
  job: AgentJob,
  apiToken: string,
): Promise<void> {
  if (job.status !== "running") return;
  if (!job.handle) return;

  log.info(`[Job ${job.id}] Cancel requested — sending SIGTERM`);

  job.status = "canceled";
  job.summary = "Agent was canceled by user request";
  job.completedAt = new Date();

  await terminateWithGrace(job, 5_000);

  // Awaited so dispatchTracker.finalize commits the cancelled-state row with
  // any drained JSONL totals BEFORE the external putStatus PUT. Without this
  // the dispatch row is "running" when the PUT lands, then flips to
  // "cancelled" later, racing any reader keying off the PUT.
  await job._cleanup?.();
  await putStatus(job, apiToken, "canceled", job.summary);
  job._onComplete?.();
}

/**
 * Get the status of a job for the API response.
 */
export function getJobStatus(job: AgentJob): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    summary: job.summary,
    started_at: job.startedAt.toISOString(),
    completed_at: job.completedAt?.toISOString() || null,
    elapsed_seconds: Math.round(
      ((job.completedAt?.getTime() || Date.now()) - job.startedAt.getTime()) /
        1000,
    ),
    input_tokens: job.usage.input_tokens,
    output_tokens: job.usage.output_tokens,
    cache_read_input_tokens: job.usage.cache_read_input_tokens,
    cache_creation_input_tokens: job.usage.cache_creation_input_tokens,
  };
}

