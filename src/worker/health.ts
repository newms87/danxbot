import { isSlackConnected, getQueueStats, getTotalQueuedCount } from "../slack/listener.js";
import { checkDbConnection } from "../db/health.js";
import type { RepoContext } from "../types.js";
import {
  readFlag,
  type CriticalFailurePayload,
} from "../critical-failure.js";

/**
 * Status is three-valued:
 * - `halted` — critical-failure flag present. Takes precedence over
 *   `degraded`/`ok` because a halt signals the poller has refused to
 *   run until a human clears the flag; that's a more urgent signal
 *   than "db down" or "slack disconnected".
 * - `degraded` — db or expected slack is unreachable.
 * - `ok` — everything up.
 *
 * HTTP status code on the wire stays 200 in every case so Docker health
 * checks stay green regardless of state — we don't want a halted worker
 * to be restarted by the container orchestrator (the flag would persist
 * on disk and crash-loop). The `status` field is the operator signal.
 */
export type WorkerHealthStatus = "ok" | "degraded" | "halted";

export interface WorkerHealthResponse {
  status: WorkerHealthStatus;
  repo: string;
  uptime_seconds: number;
  slack_connected: boolean;
  slack_expected: boolean;
  db_connected: boolean;
  memory_usage_mb: number;
  queued_messages: number;
  queue_by_thread: Record<string, number>;
  /**
   * When the poller's critical-failure flag is present, this carries the
   * parsed payload so the dashboard can render the banner without a
   * second read from disk. Null when the flag is absent.
   */
  criticalFailure: CriticalFailurePayload | null;
}

export async function getHealthStatus(
  repo: RepoContext,
): Promise<WorkerHealthResponse> {
  const slackConnected = isSlackConnected();
  const dbConnected = await checkDbConnection();
  const slackExpected = repo.slack.enabled;
  const criticalFailure = readFlag(repo.localPath);

  // Halt takes precedence over degraded/ok — operator must investigate
  // before anything else matters.
  let status: WorkerHealthStatus;
  if (criticalFailure) {
    status = "halted";
  } else if (dbConnected && (!slackExpected || slackConnected)) {
    status = "ok";
  } else {
    status = "degraded";
  }

  return {
    status,
    repo: repo.name,
    uptime_seconds: Math.round(process.uptime()),
    slack_connected: slackConnected,
    slack_expected: slackExpected,
    db_connected: dbConnected,
    memory_usage_mb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    queued_messages: getTotalQueuedCount(),
    queue_by_thread: getQueueStats(),
    criticalFailure,
  };
}
