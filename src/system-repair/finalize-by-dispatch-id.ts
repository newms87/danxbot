/**
 * DX-652 (Phase 3 of DX-580 — Self-Repair) — finalize hook keyed on
 * `dispatch_id`.
 *
 * Closes the Self-Repair lifecycle loop. When a worker-repair dispatch
 * (Phase 2, `src/cron/jobs/self-repair-dispatch.ts`) calls
 * `danxbot_complete`, the worker's `handleStop` reaches this hook with
 * the agent's summary + the mapped terminal status. The hook:
 *
 *   1. Looks up `system_error_repairs` by `dispatch_id`. No match →
 *      no-op `{finalized: false}` (the dispatch was NOT a self-repair;
 *      every other dispatch route lands here too).
 *   2. Parses the agent's summary for a verdict prefix (`fixed:` /
 *      `unfixable:` / `failed:`). Unrecognized → defaults to `failed`,
 *      same lifecycle as an explicit `failed:`.
 *   3. Maps the verdict + the row's `attempt_n` vs `REPAIR_CAP` to the
 *      next `system_errors.status`:
 *        - `fixed` → `'fixed'`
 *        - `unfixable` → `'unfixable'`
 *        - `failed` AND `attempt_n >= REPAIR_CAP` → `'unfixable'`
 *          (cap exhausted, retire signature)
 *        - `failed` AND `attempt_n <  REPAIR_CAP` → `'open'` (the next
 *          dispatcher tick may try again)
 *   4. Single transaction: UPDATE the repair row's
 *      `{ended_at, verdict, report_md}` AND UPDATE the parent
 *      `system_errors.status`. Both lands or neither.
 *   5. Fires the post-write SSE publish so the Self-Repair tab projects
 *      the new state without a refetch.
 *
 * Idempotency: a second call with the same `dispatchId` AFTER the first
 * commit lands on the already-finalized row. Both UPDATEs re-fire —
 * the repair row's `{ended_at, verdict, report_md}` re-stamps the same
 * values; the `system_errors.status` UPDATE re-writes the deterministic
 * result of `nextErrorStatus(verdict, attempt_n)` on top of itself.
 * Idempotency is by VALUE (deterministic re-stamp), not by guard. SSE
 * publish does re-fire on every call — subscribers MUST be idempotent
 * (the dashboard reducer is — it replaces by `error_id`). The handler
 * returns `{finalized: true}` in both cases; callers that want the
 * idempotency-distinction can read the returned `verdict` /
 * `errorStatus`.
 *
 * Why dispatch_id and not issue_id: the Phase 2 rebuild fires
 * card-LESS dispatches (`issueId: null`). The picker's Pass-A walks
 * YAMLs, so a null `issue_id` row cannot create a resume loop. The
 * finalize hook keys on the row UUID to close the lifecycle without
 * inventing a synthetic card to carry the state — see CLAUDE.md
 * "Self-Repair — WORKER FAULTS ONLY" for the contract.
 */

import type { Pool } from "pg";
import { publishRepairErrorUpdated } from "./publish.js";
import {
  REPAIR_CAP,
  type SystemErrorRepairVerdict,
  type SystemErrorStatus,
} from "./types.js";

export interface FinalizeRepairByDispatchIdInput {
  db: Pool;
  dispatchId: string;
  /** Agent's `danxbot_complete` summary text. May be empty / null. */
  summary: string | null | undefined;
  /** Mapped terminal dispatch status (`completed` / `failed`). */
  terminalStatus: "completed" | "failed";
  /** Test seam — defaults to the production SSE publisher. */
  publish?: (db: Pool, errorId: number) => void;
  /** Test seam — defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface FinalizeRepairByDispatchIdResult {
  /** True iff a matching `system_error_repairs` row was found + finalized. */
  finalized: boolean;
  /** The verdict written. Absent on no-op. */
  verdict?: SystemErrorRepairVerdict;
  /** The `system_errors.id` linked to this repair. Absent on no-op. */
  errorId?: number;
  /** The post-finalize `system_errors.status`. Absent on no-op. */
  errorStatus?: SystemErrorStatus;
  /** `attempt_n` on the finalized row (for caller logging). Absent on no-op. */
  attemptN?: number;
}

/**
 * Pure parser — exported for unit-test access. Verdict mapping:
 *
 *   - leading `fixed:` (case-insensitive, optional whitespace) → `fixed`
 *   - leading `unfixable:` → `unfixable`
 *   - leading `failed:` → `failed`
 *   - anything else → `failed` (default safety branch — an agent that
 *     forgot the prefix OR signaled completion on a busted repair is
 *     treated as a failure, NOT a silent success)
 *
 * `terminalStatus` is accepted for symmetry with the production signature
 * but does not change the mapping. A `failed` terminal status without a
 * recognized prefix lands at `failed` (same as the success-with-no-prefix
 * branch) — both routes funnel through the `attempt_n vs REPAIR_CAP` cap
 * decision downstream.
 */
export function parseRepairVerdict(
  summary: string | null | undefined,
  _terminalStatus: "completed" | "failed",
): SystemErrorRepairVerdict {
  const trimmed = (summary ?? "").trimStart();
  if (/^fixed\s*:/i.test(trimmed)) return "fixed";
  if (/^unfixable\s*:/i.test(trimmed)) return "unfixable";
  if (/^failed\s*:/i.test(trimmed)) return "failed";
  return "failed";
}

/**
 * Resolve the next `system_errors.status` from the verdict + the
 * just-finalized row's `attempt_n` vs `REPAIR_CAP`. Pure helper.
 */
export function nextErrorStatus(
  verdict: SystemErrorRepairVerdict,
  attemptN: number,
): SystemErrorStatus {
  if (verdict === "fixed") return "fixed";
  if (verdict === "unfixable") return "unfixable";
  // verdict === "failed"
  return attemptN >= REPAIR_CAP ? "unfixable" : "open";
}

interface RepairLookupRow {
  id: number;
  error_id: number;
  attempt_n: number;
}

/**
 * Finalize a self-repair dispatch keyed on the dispatch row UUID.
 *
 * No-op + `{finalized: false}` when no `system_error_repairs` row
 * carries this `dispatch_id` — every non-self-repair dispatch
 * (issue-worker cards, slack, API) lands here too and MUST be a
 * cheap pass-through.
 */
export async function finalizeRepairByDispatchId(
  input: FinalizeRepairByDispatchIdInput,
): Promise<FinalizeRepairByDispatchIdResult> {
  const { db, dispatchId, summary, terminalStatus } = input;
  const publish = input.publish ?? defaultPublish;
  const now = input.now ?? (() => new Date());

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lookup = await client.query<RepairLookupRow>(
      `SELECT id, error_id, attempt_n
         FROM system_error_repairs
        WHERE dispatch_id = $1
        FOR UPDATE`,
      [dispatchId],
    );

    if (lookup.rows.length === 0) {
      await client.query("ROLLBACK");
      return { finalized: false };
    }

    const row = lookup.rows[0];
    const verdict = parseRepairVerdict(summary, terminalStatus);
    const errorStatus = nextErrorStatus(verdict, row.attempt_n);
    const reportMd = summary ?? "";

    await client.query(
      `UPDATE system_error_repairs
          SET ended_at = $1,
              verdict   = $2,
              report_md = $3
        WHERE id = $4`,
      [now(), verdict, reportMd, row.id],
    );
    await client.query(
      `UPDATE system_errors SET status = $1 WHERE id = $2`,
      [errorStatus, row.error_id],
    );

    await client.query("COMMIT");

    // Fire-and-forget — never block the worker's stop path on SSE.
    publish(db, row.error_id);

    return {
      finalized: true,
      verdict,
      errorId: row.error_id,
      errorStatus,
      attemptN: row.attempt_n,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function defaultPublish(db: Pool, errorId: number): void {
  void publishRepairErrorUpdated({ db, errorId });
}
