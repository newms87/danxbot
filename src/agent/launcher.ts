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

import { createLogger } from "../logger.js";
import { putStatus } from "./agent-status.js";
import { runHostModeFork } from "./spawn-host-mode.js";
import { spawnDockerMode } from "./spawn-docker-mode.js";
import { runSpawnPreflight } from "./spawn-preflight.js";
import { pairedWriteHostPid } from "./paired-host-pid-write.js";
import { attachMonitoringStack } from "./attach-monitoring-stack.js";
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
export {
  buildCompletionInstruction,
  shouldAppendCompletionInstruction,
} from "./completion-instruction.js";
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

  // Wire the watcher / usage / forwarder / inactivity-timer / heartbeat /
  // max-runtime / cleanup / stop chain onto `job`. Phase 2b extracted this
  // into its own module so Phase 2c (DB-driven full-stack reattach) can
  // attach the same chain to a reattach shim. See
  // `attach-monitoring-stack.ts` for the full ordering contract.
  const { cleanup, getLastAssistantText, registerTermDir } =
    await attachMonitoringStack({
      job,
      jobId,
      agentCwd,
      promptDir,
      options,
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
      getLastAssistantText,
      registerTermDir,
    });
  } else {
    spawnDockerMode({
      job,
      flags,
      firstMessage,
      agentCwd,
      env,
      getLastAssistantText,
      cleanup,
      statusUrl: options.statusUrl,
      apiToken: options.apiToken,
      onComplete: options.onComplete,
    });
  }

  // Phase 1 of the DB-as-dispatch-registry epic (DX-140) — atomic paired
  // write of `host_pid` + `dispatch.pid`. The runtime fork has resolved
  // `job.handle.pid` (host: `script -q -f` wrapper PID; docker: claude
  // child PID). Stamp it onto the DB row AND the YAML in one operation
  // so reconcile + reattach both see the same value.
  //
  // Skipped when the dispatch is not tracked (no DB row to update) or
  // when the runtime fork failed to set a handle. The latter is already
  // a fatal spawn failure: `runHostModeFork` will throw and `spawnAgent`
  // unwinds before we reach here. The defensive guard exists for tests
  // that inject a mocked runtime fork without setting `job.handle`.
  if (options.dispatch && job.handle) {
    try {
      await pairedWriteHostPid({
        dispatchId: jobId,
        pid: job.handle.pid,
        yaml: options.pairedWriteYaml,
      });
    } catch (pairedErr) {
      // Paired-write rolled back. The dispatch row is already marked
      // failed (with summary "Paired host_pid write rolled back"). Tear
      // down the spawned agent — it has no monitoring contract on the
      // worker side anymore — and unwind cleanly so the caller sees the
      // failure instead of a silently-orphaned process.
      log.error(
        `[Job ${jobId}] paired host_pid write failed; tearing down agent`,
        pairedErr,
      );
      job.status = "failed";
      job.summary = "Paired host_pid write rolled back";
      job.completedAt = new Date();
      try {
        job.handle.kill("SIGTERM");
      } catch (killErr) {
        log.error(
          `[Job ${jobId}] failed to SIGTERM after paired-write rollback`,
          killErr,
        );
      }
      void cleanup();
      throw pairedErr;
    }
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
