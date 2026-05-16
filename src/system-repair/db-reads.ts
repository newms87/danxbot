/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair): SQL helpers the dashboard
 * "Self-Repair" tab reads. The dispatcher (`dispatch-pick.ts`) reads
 * the WRITE side; this module is the READ + operator-action side.
 *
 * `listRepairErrors` and `getRepairErrorDetail` return the same
 * `RepairErrorWithAttempts` shape — list is multi-row, detail is
 * one row with full sample payload. The shape mirrors what the SSE
 * publisher emits on every `system_errors` mutation, so a freshly-
 * hydrated tab can reduce subsequent live events without a refetch.
 *
 * `resetRepairError` clears every repair attempt for the error AND
 * flips the row back to `status='open'`. Used when an operator wants
 * the self-repair pipeline to try again after a manual fix (or after
 * three failed agent attempts hit the cap). DELETE-cascade on
 * `system_error_repairs` keeps the implementation a single statement.
 *
 * `markUnfixable` is the operator override that flips status to
 * `unfixable` without going through a repair attempt — used when a
 * human inspects an open error and decides it isn't worth automating.
 */

import type { Pool } from "pg";
import type {
  SystemErrorRepairRow,
  SystemErrorRow,
  SystemErrorStatus,
} from "./types.js";

const VALID_STATUSES: ReadonlySet<SystemErrorStatus> = new Set([
  "open",
  "repairing",
  "fixed",
  "unfixable",
]);

type SystemErrorRowFromDb = Omit<SystemErrorRow, "status"> & { status: string };

function rowToSystemError(r: SystemErrorRowFromDb): SystemErrorRow {
  if (!VALID_STATUSES.has(r.status as SystemErrorStatus)) {
    throw new Error(
      `system_errors row id=${r.id} carries unknown status="${r.status}"`,
    );
  }
  return { ...r, status: r.status as SystemErrorStatus };
}

export interface RepairErrorWithAttempts {
  error: SystemErrorRow;
  attempts: SystemErrorRepairRow[];
}

const SELECT_ERROR_COLS =
  "id, signature_hash, category_key, component, err_class, " +
  "normalized_msg, sample_payload, count, first_seen, last_seen, status, repo";

const SELECT_ATTEMPT_COLS =
  "id, error_id, attempt_n, card_id, dispatch_id, " +
  "started_at, ended_at, verdict, report_md";

export interface ListRepairErrorsInput {
  db: Pool;
  /** When null/undefined, return all repos. */
  repo: string | null;
  /** Cap on returned rows. Defaults to 200. */
  limit?: number;
}

/**
 * Return every system_errors row (optionally filtered by repo) ordered
 * count DESC, last_seen DESC — the same ranking the dispatcher uses,
 * so the top of the list is what the pipeline will pick next. Each
 * row's `attempts[]` is sorted attempt_n ASC.
 *
 * Two-statement implementation: one fetch of the error rows, one
 * batched fetch of every attempt by `error_id = ANY(...)`. The batched
 * shape keeps the worst case at O(rowCount + attemptCount) instead of
 * the N+1 the naive per-row fetch would produce.
 */
export async function listRepairErrors(
  input: ListRepairErrorsInput,
): Promise<RepairErrorWithAttempts[]> {
  const { db, repo, limit = 200 } = input;

  const errorsResult = repo
    ? await db.query<SystemErrorRowFromDb>(
        `SELECT ${SELECT_ERROR_COLS} FROM system_errors WHERE repo = $1 ORDER BY count DESC, last_seen DESC LIMIT $2`,
        [repo, limit],
      )
    : await db.query<SystemErrorRowFromDb>(
        `SELECT ${SELECT_ERROR_COLS} FROM system_errors ORDER BY count DESC, last_seen DESC LIMIT $1`,
        [limit],
      );

  const errors = errorsResult.rows.map(rowToSystemError);
  if (errors.length === 0) return [];

  const ids = errors.map((e) => e.id);
  const attemptsResult = await db.query<SystemErrorRepairRow>(
    `SELECT ${SELECT_ATTEMPT_COLS} FROM system_error_repairs WHERE error_id = ANY($1::bigint[]) ORDER BY error_id, attempt_n ASC`,
    [ids],
  );

  const byErrorId = new Map<number, SystemErrorRepairRow[]>();
  for (const r of attemptsResult.rows) {
    let list = byErrorId.get(Number(r.error_id));
    if (!list) {
      list = [];
      byErrorId.set(Number(r.error_id), list);
    }
    list.push(r);
  }

  return errors.map((error) => ({
    error,
    attempts: byErrorId.get(error.id) ?? [],
  }));
}

export interface GetRepairErrorDetailInput {
  db: Pool;
  id: number;
}

export async function getRepairErrorDetail(
  input: GetRepairErrorDetailInput,
): Promise<RepairErrorWithAttempts | null> {
  const { db, id } = input;
  const errorResult = await db.query<SystemErrorRowFromDb>(
    `SELECT ${SELECT_ERROR_COLS} FROM system_errors WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (errorResult.rows.length === 0) return null;
  const error = rowToSystemError(errorResult.rows[0]);

  const attemptsResult = await db.query<SystemErrorRepairRow>(
    `SELECT ${SELECT_ATTEMPT_COLS} FROM system_error_repairs WHERE error_id = $1 ORDER BY attempt_n ASC`,
    [id],
  );
  return { error, attempts: attemptsResult.rows };
}

export interface ResetRepairErrorInput {
  db: Pool;
  id: number;
}

export type ResetRepairErrorResult =
  | { kind: "not-found" }
  | { kind: "reset"; row: SystemErrorRow };

/**
 * Operator-only reset. Clears every repair attempt for the error AND
 * flips the row's status back to `open`. Idempotent — re-running on a
 * row already at `open` with no attempts is a no-op that still returns
 * the post-update row.
 *
 * Single transaction so concurrent dispatchers cannot pick the same
 * error while reset is mid-flight: the DELETE blocks any other
 * `system_error_repairs` row insert against the same error_id, the
 * UPDATE blocks any other `status` flip on the row.
 */
export async function resetRepairError(
  input: ResetRepairErrorInput,
): Promise<ResetRepairErrorResult> {
  const { db, id } = input;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<SystemErrorRowFromDb>(
      `SELECT ${SELECT_ERROR_COLS} FROM system_errors WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return { kind: "not-found" };
    }
    await client.query(
      `DELETE FROM system_error_repairs WHERE error_id = $1`,
      [id],
    );
    const updated = await client.query<SystemErrorRowFromDb>(
      `UPDATE system_errors SET status = 'open' WHERE id = $1 RETURNING ${SELECT_ERROR_COLS}`,
      [id],
    );
    await client.query("COMMIT");
    const row = rowToSystemError(updated.rows[0]);
    return { kind: "reset", row };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface MarkUnfixableInput {
  db: Pool;
  id: number;
}

export type MarkUnfixableResult =
  | { kind: "not-found" }
  | { kind: "marked"; row: SystemErrorRow };

/**
 * Operator override: flip a `system_errors` row directly to
 * `unfixable`. Does NOT touch repair attempts — any prior history
 * stays visible in the drawer. Idempotent.
 */
export async function markUnfixable(
  input: MarkUnfixableInput,
): Promise<MarkUnfixableResult> {
  const { db, id } = input;
  const result = await db.query<SystemErrorRowFromDb>(
    `UPDATE system_errors SET status = 'unfixable' WHERE id = $1 RETURNING ${SELECT_ERROR_COLS}`,
    [id],
  );
  if (result.rows.length === 0) return { kind: "not-found" };
  return { kind: "marked", row: rowToSystemError(result.rows[0]) };
}
