import { query } from "../db/connection.js";

/**
 * Audit-row repository for `worker_restarts` (ISS-71). Lives under
 * `src/worker/` because the table is purely a worker-side concern —
 * the dashboard never reads or writes it.
 */

export type RestartOutcome =
  | "started"
  | "success"
  | "cooldown"
  | "cross_repo"
  | "docker_self"
  | "spawn_failed"
  | "health_timeout";

export interface InsertRestartInput {
  requestingDispatchId: string;
  repo: string;
  reason: string;
  outcome: RestartOutcome;
  oldPid: number | null;
  startedAt: number;
}

export interface CompleteRestartInput {
  id: number;
  outcome: RestartOutcome;
  newPid: number | null;
  completedAt: number;
}

export interface RestartRow {
  id: number;
  requesting_dispatch_id: string;
  repo: string;
  reason: string;
  outcome: RestartOutcome;
  old_pid: number | null;
  new_pid: number | null;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
}

/**
 * Insert a new restart row. Returns the surrogate id so callers
 * can update the row when the detached finalizer reports back.
 */
export async function insertRestart(
  input: InsertRestartInput,
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO worker_restarts
       (requesting_dispatch_id, repo, reason, outcome, old_pid, started_at)
     VALUES ($1, $2, $3, $4, $5, TO_TIMESTAMP($6::bigint / 1000.0))
     RETURNING id`,
    [
      input.requestingDispatchId,
      input.repo,
      input.reason,
      input.outcome,
      input.oldPid,
      input.startedAt,
    ],
  );
  return rows[0].id;
}

/**
 * Stamp `completed_at` / `new_pid` / `duration_ms` / final `outcome`
 * onto the row created by `insertRestart`.
 */
export async function completeRestart(
  input: CompleteRestartInput,
): Promise<void> {
  await query(
    `UPDATE worker_restarts
       SET completed_at = TO_TIMESTAMP($1::bigint / 1000.0),
           new_pid = $2,
           outcome = $3,
           duration_ms = (
             EXTRACT(EPOCH FROM (TO_TIMESTAMP($1::bigint / 1000.0) - started_at)) * 1000
           )::int
     WHERE id = $4`,
    [input.completedAt, input.newPid, input.outcome, input.id],
  );
}

/**
 * Fetch the latest successful restart for a repo. Used at worker boot
 * to seed the in-memory cooldown map.
 */
export async function getLatestSuccessfulRestart(
  repo: string,
): Promise<RestartRow | null> {
  const rows = await query<RestartRow>(
    `SELECT * FROM worker_restarts
       WHERE repo = $1 AND outcome = 'success'
       ORDER BY completed_at DESC
       LIMIT 1`,
    [repo],
  );
  return rows.length === 0 ? null : rows[0];
}
