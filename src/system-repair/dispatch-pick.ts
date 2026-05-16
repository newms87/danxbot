/**
 * DX-563 (Phase 3 of DX-560 — Self-Repair): thin DB helpers the
 * dispatcher uses to find a target, record the attempt, and flip the
 * `system_errors` row's status as the lifecycle advances.
 *
 * Each helper wraps ONE SQL statement — the orchestrator is in
 * `src/cron/jobs/self-repair-dispatch.ts`. Idempotency of the overall
 * flow is achieved by ordering: insert the repair attempt BEFORE
 * creating the card, then stamp the card_id once it exists, then flip
 * the error row to `repairing` last. A crash mid-create leaves a
 * partial repair row with a null card_id; the next tick's pick query
 * sees that row's `ended_at IS NULL` and skips this error (a future
 * reconciler can mark it `failed`).
 */

import type { Pool } from "pg";
import {
  REPAIR_CAP,
  type SystemErrorRow,
  type SystemErrorRepairRow,
  type SystemErrorStatus,
} from "./types.js";
import { publishRepairErrorUpdated } from "./publish.js";

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

export interface GetDispatchCandidateInput {
  db: Pool;
  repo: string;
  threshold: number;
}

/**
 * Pick the next error to dispatch a repair card at.
 *
 * Returns the top open row for `repo` whose count clears `threshold`
 * AND has fewer than 3 prior attempts AND has no in-flight attempt
 * (any repair row with `ended_at IS NULL`). Ordered by count DESC,
 * last_seen DESC — most-frequent and most-recent wins.
 */
export async function getDispatchCandidate(
  input: GetDispatchCandidateInput,
): Promise<SystemErrorRow | null> {
  const { db, repo, threshold } = input;
  const { rows } = await db.query<SystemErrorRowFromDb>(
    `
    SELECT e.id, e.signature_hash, e.category_key, e.component, e.err_class,
           e.normalized_msg, e.sample_payload, e.count, e.first_seen, e.last_seen,
           e.status, e.repo, e.recurrence_count
    FROM system_errors e
    WHERE e.repo = $1
      AND e.status = 'open'
      AND e.count >= $2
      AND (
        SELECT COUNT(*) FROM system_error_repairs r
        WHERE r.error_id = e.id
      ) < $3
      AND NOT EXISTS (
        SELECT 1 FROM system_error_repairs r2
        WHERE r2.error_id = e.id AND r2.ended_at IS NULL
      )
    ORDER BY e.count DESC, e.last_seen DESC
    LIMIT 1
    `,
    [repo, threshold, REPAIR_CAP],
  );
  if (rows.length === 0) return null;
  return rowToSystemError(rows[0]);
}

export interface GetPriorAttemptsInput {
  db: Pool;
  errorId: number;
}

export async function getPriorAttempts(
  input: GetPriorAttemptsInput,
): Promise<SystemErrorRepairRow[]> {
  const { db, errorId } = input;
  const { rows } = await db.query<SystemErrorRepairRow>(
    `
    SELECT id, error_id, attempt_n, card_id, dispatch_id,
           started_at, ended_at, verdict, report_md
    FROM system_error_repairs
    WHERE error_id = $1
    ORDER BY attempt_n ASC
    `,
    [errorId],
  );
  return rows;
}

export interface InsertRepairAttemptInput {
  db: Pool;
  errorId: number;
  attemptN: number;
}

/**
 * Insert the repair row BEFORE the card is created — a crash mid-
 * create leaves a row with `card_id IS NULL` AND `ended_at IS NULL`,
 * which the next pick query treats as in-flight (skipping the error
 * until a reconciler closes it). The integration test pins this
 * ordering.
 */
export async function insertRepairAttempt(
  input: InsertRepairAttemptInput,
): Promise<SystemErrorRepairRow> {
  const { db, errorId, attemptN } = input;
  const { rows } = await db.query<SystemErrorRepairRow>(
    `
    INSERT INTO system_error_repairs (error_id, attempt_n, started_at)
    VALUES ($1, $2, NOW())
    RETURNING id, error_id, attempt_n, card_id, dispatch_id,
              started_at, ended_at, verdict, report_md
    `,
    [errorId, attemptN],
  );
  return rows[0];
}

export interface SetRepairAttemptCardInput {
  db: Pool;
  attemptId: number;
  cardId: string;
}

export async function setRepairAttemptCard(
  input: SetRepairAttemptCardInput,
): Promise<void> {
  const { db, attemptId, cardId } = input;
  const { rows } = await db.query<{ error_id: number }>(
    `UPDATE system_error_repairs SET card_id = $1 WHERE id = $2 RETURNING error_id`,
    [cardId, attemptId],
  );
  // DX-565: fan out post-write snapshot. `error_id` is RETURNING'd so
  // we don't need a second SELECT to find it.
  if (rows.length > 0) {
    void publishRepairErrorUpdated({ db, errorId: Number(rows[0].error_id) });
  }
}

export interface FlipErrorStatusInput {
  db: Pool;
  errorId: number;
  status: SystemErrorStatus;
}

export async function flipErrorStatus(
  input: FlipErrorStatusInput,
): Promise<void> {
  const { db, errorId, status } = input;
  await db.query(
    `UPDATE system_errors SET status = $1 WHERE id = $2`,
    [status, errorId],
  );
  // DX-565: fan out post-flip snapshot for the Self-Repair tab.
  void publishRepairErrorUpdated({ db, errorId });
}
