import type { Pool } from "mysql2/promise";

/**
 * Adds `parent_job_id` to `dispatches` to support resume lineage.
 *
 * When a caller POSTs `/api/resume` with a parent job_id, the worker spawns a
 * fresh dispatch that inherits the parent's Claude session (via `--resume`).
 * The new row stores the parent ID so the chain is queryable end-to-end.
 * Nullable because the column is absent for non-resume dispatches (launch,
 * Slack, Trello).
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE dispatches
    ADD COLUMN parent_job_id VARCHAR(255) NULL AFTER jsonl_path,
    ADD INDEX idx_dispatches_parent_job_id (parent_job_id)
  `);
}
