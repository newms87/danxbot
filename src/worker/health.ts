import { isSlackConnected, getQueueStats, getTotalQueuedCount } from "../slack/listener.js";
import { checkDbConnection } from "../db/health.js";
import type { RepoContext } from "../types.js";
import {
  readFlag,
  type CriticalFailurePayload,
} from "../critical-failure.js";
import {
  preflightClaudeAuth,
  type PreflightFailureReason,
} from "../agent/claude-auth-preflight.js";
import {
  preflightProjectsDir,
  type ProjectsDirFailureReason,
} from "../agent/projects-dir-preflight.js";

/**
 * Status is three-valued:
 * - `halted` — critical-failure flag present. Takes precedence over
 *   `degraded`/`ok` because a halt signals the poller has refused to
 *   run until a human clears the flag; that's a more urgent signal
 *   than "db down" or "slack disconnected".
 * - `degraded` — db or expected slack is unreachable, or the claude-auth
 *   preflight rejects (RO bind, expired token, missing creds — Trello
 *   3l2d7i46). All three contribute the same severity; the per-field
 *   detail tells the operator which one fired.
 * - `ok` — everything up.
 *
 * HTTP status code on the wire stays 200 in every case so Docker health
 * checks stay green regardless of state — we don't want a halted worker
 * to be restarted by the container orchestrator (the flag would persist
 * on disk and crash-loop). The `status` field is the operator signal.
 */
export type WorkerHealthStatus = "ok" | "degraded" | "halted";

export interface ClaudeAuthHealth {
  ok: boolean;
  /**
   * Failure category from `preflightClaudeAuth`. Omitted when `ok` is true.
   * Lets the dashboard render a category-specific remediation hint
   * without parsing the summary string.
   */
  reason?: PreflightFailureReason;
  /**
   * Human-readable message — same string spawnAgent throws as the dispatch
   * launch error, so dashboard, /health output, and dispatch responses all
   * agree on what went wrong. Omitted when `ok` is true.
   */
  summary?: string;
}

export interface ProjectsDirHealth {
  ok: boolean;
  /**
   * Failure category from `preflightProjectsDir`. Omitted when `ok` is true.
   * Trello cjAyJpgr-followup: `missing` (dir doesn't exist), `readonly`
   * (root-owned bind source — UID 1000 can't write), or `unreachable`
   * (other IO error).
   */
  reason?: ProjectsDirFailureReason;
  /**
   * Human-readable message — same string spawnAgent throws as the dispatch
   * launch error. Carries the chown remediation in the body so the
   * operator sees the exact fix command without leaving the dashboard.
   * Omitted when `ok` is true.
   */
  summary?: string;
}

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
   * Result of the claude-auth preflight that gates every dispatch (Trello
   * 3l2d7i46). When `ok` is false the worker WILL reject `/api/launch`
   * with a 503 — exposing the same check on `/health` lets operators
   * notice the broken auth chain without waiting for the next dispatch
   * to fail.
   */
  claude_auth: ClaudeAuthHealth;
  /**
   * Result of the projects-dir preflight (Trello cjAyJpgr-followup). Same
   * dispatch-gating contract as claude_auth: when `ok` is false the
   * worker WILL reject `/api/launch` with a 503, and the dashboard's
   * Agents tab can surface the chown remediation so the operator
   * doesn't waste a dispatch discovering the broken bind.
   */
  projects_dir: ProjectsDirHealth;
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
  // Run both preflights in parallel — they're independent file-system
  // probes, no need to serialize.
  const [authResult, projectsResult] = await Promise.all([
    preflightClaudeAuth(),
    preflightProjectsDir(),
  ]);
  const claude_auth: ClaudeAuthHealth = authResult.ok
    ? { ok: true }
    : { ok: false, reason: authResult.reason, summary: authResult.summary };
  const projects_dir: ProjectsDirHealth = projectsResult.ok
    ? { ok: true }
    : {
        ok: false,
        reason: projectsResult.reason,
        summary: projectsResult.summary,
      };

  // Halt takes precedence over degraded/ok — operator must investigate
  // before anything else matters. Auth-broken and projects-dir-broken
  // both fold into degraded with db/slack: same severity tier, the
  // per-field detail tells the operator which one fired.
  let status: WorkerHealthStatus;
  if (criticalFailure) {
    status = "halted";
  } else if (
    dbConnected &&
    (!slackExpected || slackConnected) &&
    claude_auth.ok &&
    projects_dir.ok
  ) {
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
    claude_auth,
    projects_dir,
    criticalFailure,
  };
}
