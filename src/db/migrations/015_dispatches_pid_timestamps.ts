import type { PoolClient } from "pg";

/**
 * Phase 1 of the DB-as-dispatch-registry epic (DX-139 / DX-140). Add two
 * timestamp columns to `dispatches` so the lifetime of `host_pid` is
 * recorded alongside the value itself:
 *
 *   - `host_pid_at` — millisecond epoch when `host_pid` was stamped via
 *     `pairedWriteHostPid`. `NULL` for rows where the paired write never
 *     ran (legacy rows pre-migration, rows whose spawn failed before PID
 *     resolution).
 *   - `pid_terminated_at` — millisecond epoch when termination of the
 *     stamped PID was confirmed. Two writers stamp this column:
 *       1. The `danxbot_complete` stop handler (agent self-terminated).
 *       2. `reconcileOrphanedDispatches` when a dead PID is swept.
 *     `NULL` while the dispatch is running.
 *
 * Together with the existing `host_pid` column these three fields express
 * the PID's full lifecycle without losing the historical value: the row
 * carries `host_pid` from spawn to termination, and the operator can see
 * "what PID owned this row + when did it start + when did it die" with
 * one row read.
 *
 * Migration tracker (`src/db/migrate.ts`) ensures this runs exactly once
 * per database — no IF NOT EXISTS guards needed. See DX-140 for the
 * paired-write design that motivates these columns.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE dispatches
    ADD COLUMN host_pid_at BIGINT NULL,
    ADD COLUMN pid_terminated_at BIGINT NULL
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE dispatches
    DROP COLUMN pid_terminated_at,
    DROP COLUMN host_pid_at
  `);
}
