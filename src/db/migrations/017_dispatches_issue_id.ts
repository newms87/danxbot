import type { PoolClient } from "pg";

/**
 * DX-84 (Phase 2 of the Agent Chat epic): add `issue_id` so the per-card
 * Chat tab can list every dispatch ever launched against a given issue.
 * The poller stamps this from the local YAML's `<PREFIX>-N` id when it
 * dispatches a card-bound session; non-card dispatches (Slack, ideator,
 * board-chat, external `/api/launch`) leave the column NULL.
 *
 * Indexed on `(issue_id, started_at DESC)` so the listing query
 * `WHERE issue_id = $1 ORDER BY started_at DESC` hits an index without a
 * filesort — that's the hot path the chat header opens with.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE dispatches
    ADD COLUMN issue_id VARCHAR(32) NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_issue_id
      ON dispatches (issue_id, started_at DESC)
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_dispatches_issue_id`);
  await client.query(`ALTER TABLE dispatches DROP COLUMN issue_id`);
}
