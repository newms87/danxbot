import type { ResultSetHeader } from "mysql2/promise";
import { getPool } from "../db/connection.js";

/**
 * Audit-row repository for `worker_restarts` (ISS-71). Lives under
 * `src/worker/` because the table is purely a worker-side concern —
 * the dashboard never reads or writes it. The card description floated
 * placing it next to `dispatches-db.ts`; keeping it here is more honest
 * about the read/write surface (only `restart.ts` and the detached
 * finalizer touch it).
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
 * Insert a new restart row. Returns the auto-increment id so callers
 * can update the row when the detached finalizer reports back.
 */
export async function insertRestart(
  input: InsertRestartInput,
): Promise<number> {
  const pool = getPool();
  const [result] = await pool.execute(
    `INSERT INTO worker_restarts
       (requesting_dispatch_id, repo, reason, outcome, old_pid, started_at)
     VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(? / 1000))`,
    [
      input.requestingDispatchId,
      input.repo,
      input.reason,
      input.outcome,
      input.oldPid,
      input.startedAt,
    ],
  );
  return (result as ResultSetHeader).insertId;
}

/**
 * Stamp `completed_at` / `new_pid` / `duration_ms` / final `outcome`
 * onto the row created by `insertRestart`. Called from the detached
 * finalizer once the new worker's `/health` returns 200 (or the
 * deadline expires).
 */
export async function completeRestart(
  input: CompleteRestartInput,
): Promise<void> {
  const pool = getPool();
  await pool.execute(
    `UPDATE worker_restarts
       SET completed_at = FROM_UNIXTIME(? / 1000),
           new_pid = ?,
           outcome = ?,
           duration_ms = TIMESTAMPDIFF(
             MICROSECOND, started_at, FROM_UNIXTIME(? / 1000)
           ) DIV 1000
     WHERE id = ?`,
    [input.completedAt, input.newPid, input.outcome, input.completedAt, input.id],
  );
}

/**
 * Fetch the latest successful restart for a repo. Used at worker boot
 * to seed the in-memory cooldown map so a fresh worker doesn't accept
 * an immediate second restart.
 */
export async function getLatestSuccessfulRestart(
  repo: string,
): Promise<RestartRow | null> {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT * FROM worker_restarts
       WHERE repo = ? AND outcome = 'success'
       ORDER BY completed_at DESC
       LIMIT 1`,
    [repo],
  );
  const arr = rows as RestartRow[];
  return arr.length === 0 ? null : arr[0];
}
