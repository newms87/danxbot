/**
 * Reset-all-data primitive. Truncates the operational data tables while
 * leaving auth (users, api_tokens) and migration bookkeeping intact.
 *
 * The table list is an EXPLICIT ALLOWLIST. Never derive it from
 * `SHOW TABLES` — that would silently wipe any table added later,
 * including new auth or config tables. When a new data table is added,
 * update `TABLES_TO_WIPE` intentionally in the same PR.
 *
 * Order matters: tables with foreign-key dependents must be truncated
 * AFTER their dependents. Today none of the wipeable tables have FKs
 * pointing at other wipeable tables, but keep the ordering
 * dependents-first to preserve that invariant under future migrations.
 *
 * After truncating, the in-memory dispatch snapshot cache
 * (`dispatch-stream.ts#knownDispatches`) is cleared so the next SSE
 * poll tick does not treat the empty DB as "all dispatches were
 * updated to not-exist".
 */

import { getPool } from "../db/connection.js";
import { createLogger } from "../logger.js";
import { clearDispatchSnapshotCache } from "./dispatch-stream.js";

const log = createLogger("reset-data");

/**
 * Explicit allowlist of tables cleared by `resetAllData`. Order is
 * dependents-first. Adding a new operational data table requires adding
 * it here deliberately; adding a new auth/config table requires NOT
 * adding it here.
 */
export const TABLES_TO_WIPE = [
  "dispatches",
  "threads",
  "events",
  "health_check",
] as const;

export interface ResetAllDataResult {
  tablesCleared: string[];
  rowsDeleted: number;
  perTable: Record<string, number>;
}

export async function resetAllData(): Promise<ResetAllDataResult> {
  const pool = getPool();
  const perTable: Record<string, number> = {};
  let total = 0;

  for (const table of TABLES_TO_WIPE) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
    const typed = rows as Array<{ n: number | string }>;
    if (typed.length === 0) {
      // `SELECT COUNT(*)` without a WHERE always returns exactly one row.
      // Zero rows here means the driver handed us a malformed result set —
      // fail loud instead of silently reporting `0 rows deleted` and
      // truncating anyway.
      throw new Error(`COUNT query returned no row for table ${table}`);
    }
    const count = Number(typed[0].n);
    perTable[table] = count;
    total += count;
    await pool.query(`TRUNCATE TABLE ${table}`);
  }

  clearDispatchSnapshotCache();

  const breakdown = Object.entries(perTable)
    .map(([t, n]) => `${t}=${n}`)
    .join(", ");
  log.info(
    `Reset data: cleared ${TABLES_TO_WIPE.length} table(s), ${total} row(s) deleted (${breakdown})`,
  );

  return {
    tablesCleared: [...TABLES_TO_WIPE],
    rowsDeleted: total,
    perTable,
  };
}
