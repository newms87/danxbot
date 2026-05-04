/**
 * Agent self-stop handler — assigned to `job.stop` by `spawnAgent`.
 *
 * Distinct from `cancelJob` (user-initiated): the agent invokes this via
 * `danxbot_complete` MCP -> worker `/api/stop/:jobId` HTTP -> `job.stop`.
 * Sends SIGTERM, waits 5 s, then SIGKILL if the kernel hasn't reaped the
 * process. Status is set BEFORE killing so the close/exit handler's
 * `job.status === "running"` guard sees the terminal state and early-returns
 * instead of overwriting the agent-supplied summary.
 *
 * The SIGTERM → 5 s → SIGKILL pattern intentionally mirrors
 * `terminateWithGrace` but is open-coded here — only this call site cares
 * whether exit fired during the grace window (via `processExited`), so it
 * can skip the SIGKILL when the kernel already reaped the process.
 * `terminateWithGrace` operates on `isAlive()` only and is correct for
 * `cancelJob` + stall recovery, which don't need that signal.
 *
 * Cleanup is awaited (via `job._cleanup ?? cleanup`) so the dispatch row's
 * final token totals land BEFORE the external `putStatus` PUT — see
 * `agent-cleanup.ts` for the race fix. `job._cleanup` is preferred over
 * the local `cleanup` so any wrappers registered after spawn (e.g. stall
 * detection teardown from `setupStallDetection`) are honored.
 */

import { createLogger } from "../logger.js";
import { putStatus } from "./agent-status.js";
import type { AgentJob } from "./agent-types.js";

const log = createLogger("agent-stop");

export interface BuildJobStopHandlerDeps {
  job: AgentJob;
  jobId: string;
  cleanup: () => Promise<void>;
  statusUrl?: string;
  apiToken?: string;
  onComplete?: (job: AgentJob) => void;
}

export function buildJobStopHandler(
  deps: BuildJobStopHandlerDeps,
): AgentJob["stop"] {
  const { job, jobId, cleanup, statusUrl, apiToken, onComplete } = deps;

  return async function jobStop(
    status: "completed" | "failed",
    summary?: string,
  ): Promise<void> {
    if (job.status !== "running") return;
    if (!job.handle) return;

    log.info(`[Job ${jobId}] Agent self-stop (${status}) — sending SIGTERM`);

    // Set terminal status BEFORE killing to prevent the close handler from overriding it
    job.status = status;
    if (summary) job.summary = summary;
    job.completedAt = new Date();

    // Register exit listener BEFORE kill to avoid missing a fast exit. Both
    // runtimes converge on the handle's onExit — docker delegates to
    // ChildProcess.once("close"), host delegates to the PID watcher.
    let processExited = false;
    job.handle.onExit(() => {
      processExited = true;
    });

    job.handle.kill("SIGTERM");

    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    if (!processExited && job.handle.isAlive()) {
      log.info(`[Job ${jobId}] Still alive after 5s — sending SIGKILL`);
      job.handle.kill("SIGKILL");
    }

    // Use job._cleanup rather than the captured `cleanup` so any wrappers
    // registered after spawn (e.g. stall detection teardown from
    // setupStallDetection) are honored.
    await (job._cleanup ?? cleanup)();

    if (statusUrl && apiToken) {
      await putStatus(job, apiToken, status, job.summary);
    }
    onComplete?.(job);
  };
}
