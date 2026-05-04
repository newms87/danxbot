/**
 * Status reporting + heartbeat for AgentJob.
 *
 * Pure-function module — no closures over launcher state. Every entry point
 * takes the AgentJob plus the bits it needs (apiToken, options) explicitly.
 *
 * Three responsibilities:
 *   1. `putStatus` — single PUT to the dispatch's `status_url`. Terminal
 *      statuses (completed/failed/canceled/timeout) retry up to 3 times so
 *      a transient network blip cannot leave the external dispatcher stuck
 *      believing the agent is still running.
 *   2. `startHeartbeat` / `stopHeartbeat` — the 10s liveness PUT loop.
 *   3. `notifyTerminalStatus` — fire-and-forget terminal notification used
 *      by the sync-context transitions in launcher.ts (inactivity timer,
 *      max-runtime timer, host onExit). The await-variants (job.stop,
 *      cancelJob, host spawn-error catch) compose the same pattern inline
 *      because they need await for other reasons.
 */

import { createLogger } from "../logger.js";
import type { AgentJob } from "./agent-types.js";

const log = createLogger("agent-status");

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const TERMINAL_STATUS_RETRIES = 3;
export const TERMINAL_STATUS_RETRY_DELAY_MS = 2_000;

/**
 * PUT status update to the dispatch's status_url.
 * Terminal statuses (completed, failed, canceled) retry up to 3 times.
 */
export async function putStatus(
  job: AgentJob,
  apiToken: string,
  status: string,
  message?: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!job.statusUrl) return;

  const body = JSON.stringify({
    status,
    message: message || undefined,
    data: data || undefined,
  });

  const isTerminal = status !== "running";
  const maxAttempts = isTerminal ? TERMINAL_STATUS_RETRIES : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(job.statusUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body,
      });

      if (response.ok) return;

      log.error(
        `[Job ${job.id}] Status PUT failed (attempt ${attempt}/${maxAttempts}): HTTP ${response.status}`,
      );
    } catch (err) {
      log.error(
        `[Job ${job.id}] Status PUT error (attempt ${attempt}/${maxAttempts}):`,
        err,
      );
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, TERMINAL_STATUS_RETRY_DELAY_MS),
      );
    }
  }

  if (isTerminal) {
    log.error(
      `[Job ${job.id}] All ${maxAttempts} status PUT attempts failed for terminal status '${status}'.`,
    );
  }
}

/**
 * Start the heartbeat loop for a running job.
 * Sends PUT {status_url} with { status: "running" } every 10 seconds.
 */
export function startHeartbeat(job: AgentJob, apiToken: string): void {
  if (!job.statusUrl) return;

  job.heartbeatInterval = setInterval(() => {
    if (job.status !== "running") {
      stopHeartbeat(job);
      return;
    }
    putStatus(job, apiToken, "running");
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(job: AgentJob): void {
  if (job.heartbeatInterval) {
    clearInterval(job.heartbeatInterval);
    job.heartbeatInterval = undefined;
  }
}

/**
 * Fire-and-forget terminal notification: PUT the external dispatcher (if
 * configured) then invoke the caller's onComplete. Used by every sync-context
 * terminal transition (inactivity timer, max-runtime timer, host onExit).
 *
 * The await-variants (job.stop, cancelJob, host-mode spawn-error catch)
 * compose this pattern inline because they need await for other reasons
 * (5s grace wait, error propagation via rethrow). The docker close-handler
 * wrapper has its own shape because it coerces status via exit-code mapping
 * inside setupProcessHandlers.
 */
export function notifyTerminalStatus(
  job: AgentJob,
  options: {
    statusUrl?: string;
    apiToken?: string;
    onComplete?: (j: AgentJob) => void;
  },
  status: string,
  summary?: string,
): void {
  if (options.statusUrl && options.apiToken) {
    putStatus(job, options.apiToken, status, summary);
  }
  options.onComplete?.(job);
}
