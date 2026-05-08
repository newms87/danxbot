import type { PoolClient } from "pg";

/**
 * Adds `parent_job_id` to `dispatches` to support resume lineage.
 *
 * When a caller POSTs `/api/resume` with a parent job_id, the worker spawns a
 * fresh dispatch that inherits the parent's Claude session (via `--resume`).
 * The new row stores the parent ID so the chain is queryable end-to-end.
 * Nullable because the column is absent for non-resume dispatches (launch,
 * Slack, Trello).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE dispatches
    ADD COLUMN parent_job_id VARCHAR(255) NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_parent_job_id
    ON dispatches (parent_job_id)
  `);
}
