import type { PoolClient } from "pg";

/**
 * Adds denormalized `slack_thread_ts` + `slack_channel_id` columns to
 * `dispatches` (nullable; only populated when `trigger = 'slack'`).
 *
 * Both values already exist inside the JSONB `trigger_metadata` blob for
 * Slack rows, but we pull them out into dedicated columns so that the
 * Phase 2 thread-continuity lookup
 * (`findLatestDispatchBySlackThread(threadTs)`) can hit a real index
 * instead of scanning JSON paths. `slack_channel_id` is denormalized
 * alongside for symmetry and to let future "all dispatches in channel
 * X" queries stay indexable without another migration.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE dispatches
    ADD COLUMN slack_thread_ts VARCHAR(64) NULL,
    ADD COLUMN slack_channel_id VARCHAR(32) NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_slack_thread_ts
    ON dispatches (slack_thread_ts)
  `);
}
