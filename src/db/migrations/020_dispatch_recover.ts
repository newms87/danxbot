import type { PoolClient } from "pg";

/**
 * DX-259 (Phase 1 of DX-246 — Claude API stream-idle auto-recover):
 * add the two `dispatches` columns the recover path will write to
 * once Phase 2 wires the launcher up. Both are pure additions; no
 * existing query touches them and no existing column moves.
 *
 * `recover_count` — integer counter incremented on each successful
 * stream-idle recover for a dispatch chain. Defaults to 0 so every
 * pre-migration row + every fresh insert that omits the field reads
 * as "never recovered". The Phase 2 cap (`MAX_RECOVERS = 3`) reads
 * this column to decide failed-vs-recovered branching; storing it on
 * the row instead of in-memory survives worker restarts mid-chain.
 *
 * `parent_recover_id` — self-referential FK to `dispatches(id)`,
 * NULLable so non-recover rows leave it alone. Indexed (the
 * `idx_dispatches_parent_recover_id` index below) so the dashboard's
 * future "show recover chain" query and the worker's escalation
 * lookup don't scan the full table. The FK is declared without
 * cascade — a recovery chain's history must outlive any individual
 * row delete.
 *
 * Idempotent on both directions via `IF NOT EXISTS` / `IF EXISTS`.
 * The runner's `schema_migrations` table normally prevents re-apply,
 * but a partial-apply replay (DDL committed before the migrations
 * row insert succeeded) lands here without erroring.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE dispatches
    ADD COLUMN IF NOT EXISTS recover_count INT NOT NULL DEFAULT 0
  `);
  await client.query(`
    ALTER TABLE dispatches
    ADD COLUMN IF NOT EXISTS parent_recover_id VARCHAR(255) NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_parent_recover_id
    ON dispatches (parent_recover_id)
    WHERE parent_recover_id IS NOT NULL
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_dispatches_parent_recover_id`);
  await client.query(`
    ALTER TABLE dispatches
    DROP COLUMN IF EXISTS parent_recover_id
  `);
  await client.query(`
    ALTER TABLE dispatches
    DROP COLUMN IF EXISTS recover_count
  `);
}
