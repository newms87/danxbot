import type { Pool } from "mysql2/promise";

/**
 * Adds denormalized `slack_thread_ts` + `slack_channel_id` columns to
 * `dispatches` (nullable; only populated when `trigger = 'slack'`).
 *
 * Both values already exist inside the JSON `trigger_metadata` blob for
 * Slack rows, but we pull them out into dedicated columns so that the
 * Phase 2 thread-continuity lookup
 * (`findLatestDispatchBySlackThread(threadTs)`) can hit a real index
 * instead of scanning JSON paths. `slack_channel_id` is denormalized
 * alongside for symmetry and to let future "all dispatches in channel
 * X" queries stay indexable without another migration.
 *
 * Non-Slack rows leave both columns NULL — the columns are inert for
 * `trigger IN ('api', 'trello')` and cost effectively nothing at that
 * scale. See Phase 1 of the `kMQ170Ea` epic.
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE dispatches
    ADD COLUMN slack_thread_ts VARCHAR(64) NULL AFTER trigger_metadata,
    ADD COLUMN slack_channel_id VARCHAR(32) NULL AFTER slack_thread_ts,
    ADD INDEX idx_dispatches_slack_thread_ts (slack_thread_ts)
  `);
}
