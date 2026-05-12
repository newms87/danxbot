/**
 * Agent self-stop handler — assigned to `job.stop` by `spawnAgent`.
 *
 * Distinct from `cancelJob` (user-initiated): the agent invokes this via
 * `danxbot_complete` MCP -> worker `/api/stop/:jobId` HTTP -> `job.stop`.
 *
 * Delegates the actual process-tree teardown to `stopAgentTree`
 * (`src/agent/job-stop.ts`) — the single entry point that branches on
 * `job.scopeName` between `systemctl --user stop` (host runtime, DX-326)
 * and SIGTERM-then-SIGKILL on the tracked PID (docker runtime, container
 * boundary IS the cgroup). Status is set BEFORE killing so the close /
 * exit handler's `job.status === "running"` guard sees the terminal state
 * and early-returns instead of overwriting the agent-supplied summary.
 *
 * Cleanup is awaited (via `job._cleanup ?? cleanup`) so the dispatch row's
 * final token totals land BEFORE the external `putStatus` PUT — see
 * `agent-cleanup.ts` for the race fix. `job._cleanup` is preferred over
 * the local `cleanup` so any wrappers registered after spawn (e.g. stall
 * detection teardown from `setupStallDetection`) are honored.
 */

import { createLogger } from "../logger.js";
import { putStatus } from "./agent-status.js";
import { stopAgentTree } from "./job-stop.js";
import type { CompleteStatus } from "../mcp/danxbot-server.js";
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

/**
 * Map an agent-facing `CompleteStatus` to the in-memory
 * `AgentJob.status` value. `buildCleanup` collapses the result to the
 * DispatchStatus the dispatch row stores via the same shape contract:
 *
 *   - `completed`          → `completed` (in-memory) → `completed` (DB)
 *   - `failed`             → `failed`                → `failed`
 *   - `critical_failure`   → `failed`                → `failed`
 *   - `api_error_failed`   → `failed`                → `failed`
 *   - `api_error_recover`  → `recovered`             → `recovered`
 *   - `rate_limited`       → `throttled`             → `throttled` (DX-322)
 *
 * The cap-exhausted / critical-failure / throttle flags are written
 * by the caller BEFORE invoking `job.stop`, mirroring the two-layer
 * pattern the `critical_failure` handler in `worker/dispatch.ts`
 * already uses.
 */
function mapCompleteToInMemory(
  status: CompleteStatus,
): "completed" | "failed" | "recovered" | "throttled" {
  if (status === "completed") return "completed";
  if (status === "api_error_recover") return "recovered";
  if (status === "rate_limited") return "throttled";
  return "failed";
}

export function buildJobStopHandler(
  deps: BuildJobStopHandlerDeps,
): AgentJob["stop"] {
  const { job, jobId, cleanup, statusUrl, apiToken, onComplete } = deps;

  return async function jobStop(
    status: CompleteStatus,
    summary?: string,
  ): Promise<void> {
    if (job.status !== "running") return;
    if (!job.handle) return;

    log.info(`[Job ${jobId}] Agent self-stop (${status})`);

    // Set terminal status BEFORE killing to prevent the close handler from overriding it.
    // The `CompleteStatus` is collapsed to the narrower in-memory job
    // status here — `buildCleanup` re-derives the DispatchStatus from
    // `job.status` so the DB row mirrors the same shape.
    job.status = mapCompleteToInMemory(status);
    if (summary) job.summary = summary;
    job.completedAt = new Date();

    // DX-326: route every terminal stop through the single helper.
    // Host (scopeName set) → `systemctl --user stop <scope>.scope` reaps
    // the whole cgroup atomically (incl. backgrounded grandchildren).
    // Docker (scopeName unset) → SIGTERM-then-SIGKILL on job.handle.pid,
    // container boundary cascades to descendants. No kill(pid) call
    // survives on the host stop path — see job-stop.ts.
    await stopAgentTree({ job, scopeName: job.scopeName });

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
