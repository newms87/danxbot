import type { PoolClient } from "pg";

/**
 * DX-566 (Phase 6 of DX-560 — Self-Repair): adds `recurrence_count` to
 * `system_errors`. Phase 2's `recordError` ON CONFLICT clause checks
 * this column when the existing row's `status='fixed'`: an occurrence
 * of a previously-fixed signature flips the row back to `open` AND
 * bumps `recurrence_count`. When `recurrence_count >= 3` the row goes
 * to `unfixable` and the dispatcher skips it.
 *
 * Default `0` so every pre-existing row enters the new code path with
 * the same semantics it had before (`fixed` + recurrence_count=0 → flip
 * to `open` + bump on next recurrence).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE system_errors
    ADD COLUMN recurrence_count INT NOT NULL DEFAULT 0
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE system_errors DROP COLUMN IF EXISTS recurrence_count
  `);
}
