import type { Pool } from "mysql2/promise";

/**
 * Add `host_pid` to `dispatches` so the worker can tell at startup which
 * non-terminal rows belong to a still-running claude process and which were
 * orphaned by a worker restart.
 *
 * Host-mode dispatches outlive the worker — `script -q -f` reparents the
 * claude child to PID 1, so the new worker has zero in-memory record of
 * dispatches that were running when the old worker died. Without `host_pid`
 * the only signal is the tracker-side lock TTL, which is wall-clock based
 * and reclaims the card while the original claude is still working —
 * producing TWO claude processes editing the same YAML.
 *
 * Populated at row-insert time in `dispatch-tracker.ts` (= the worker's
 * own `process.pid`). Consumers:
 *   - `reconcileOrphanedDispatches` at worker startup marks rows with a
 *     dead PID (or null PID — pre-fix legacy rows) as `failed`.
 *   - The poller's pre-claim DB guard skips a Trello card whose dispatch
 *     row has `host_pid` still alive.
 *
 * Legacy rows at upgrade time get `host_pid = NULL` and are treated as
 * orphaned by the next worker restart's reconciliation pass — the
 * intended migration semantics.
 *
 * No index on `host_pid` — both consumers (startup reconcile + poller
 * pre-claim guard) filter by `repo_name` + `status` first, which already
 * narrows to a handful of rows per repo. An index here is unwarranted at
 * current scale; revisit only if `findNonTerminalDispatches` ever runs
 * against millions of rows.
 *
 * See ISS-69.
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE dispatches
    ADD COLUMN host_pid INT NULL AFTER runtime_mode
  `);
}
