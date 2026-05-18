/**
 * DX-651 (Phase 2 of DX-580) — Self-Repair worker-fault dispatcher.
 *
 * A cron job (registered in `./index.ts`, fired every 60s by
 * `src/cron/worker-loop.ts`) that scans `system_errors` for open rows
 * past `REPAIR_THRESHOLD` whose `category_key` matches the worker-fault
 * whitelist (Phase 1 — `src/system-repair/dispatch-pick.ts`), and fires
 * a card-LESS `dispatch()` against the `worker-repair` workspace.
 *
 * Why card-less: the retired DX-560 dispatcher created a YAML card per
 * repair, and the picker's owned-card resume pass kept re-dispatching
 * it because the YAML's status never flipped terminal. This rebuild
 * keys the entire lifecycle on the dispatch row UUID; the picker
 * cannot pick up a dispatch with `issueId: null`, so no resume loop is
 * possible.
 *
 * Contracts pinned by the unit tests in `self-repair-dispatch.test.ts`:
 *
 *   1. App-code category filter is the safety wall. The SQL pre-filter
 *      (`status='open' AND count >= REPAIR_THRESHOLD`) is broad; the
 *      `isWorkerFaultCategory` filter in TS is the load-bearing gate
 *      that keeps agent-domain rows (`audit-pass:*`, `orphan-ip-heal:*`,
 *      etc.) from firing repair dispatches.
 *   2. In-flight repair skip — a row with an existing
 *      `system_error_repairs` entry whose `verdict IS NULL` is already
 *      being worked; never start a second concurrent attempt.
 *   3. Cap respect — a row whose `MAX(attempt_n) >= REPAIR_CAP` is
 *      retired (the future Phase-3 finalize hook flips status to
 *      `unfixable`). The dispatcher refuses to fire a 4th attempt
 *      even if status is still `open`.
 *   4. One dispatch per tick — even when 5 candidates qualify, only
 *      ONE dispatch fires. Storm guard for the cron cadence.
 *   5. Atomic DB writes — INSERT repair row + UPDATE error status to
 *      `repairing` run inside a single transaction. Dispatch throws
 *      → compensating UPDATE (revert status to `open`) + DELETE repair
 *      row, so a failed spawn leaves NO residue in either table.
 *   6. Top-level swallow — every error inside `run()` is caught and
 *      logged; the job NEVER rejects. A throw out of a cron job is
 *      itself a `cron-job:*` system_error which would recurse.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPool } from "../../db/connection.js";
import { dispatch as defaultDispatch } from "../../dispatch/core.js";
import {
  isWorkerFaultCategory as defaultIsWorkerFaultCategory,
} from "../../system-repair/dispatch-pick.js";
import {
  REPAIR_CAP,
  REPAIR_THRESHOLD,
  type SystemErrorRow,
  type SystemErrorSamplePayload,
} from "../../system-repair/types.js";
import { buildRepairTaskBody } from "../../system-repair/repair-task-body.js";
import { getRepoContext as defaultGetRepoContext } from "../../repo-context.js";
import type { RepoContext } from "../../types.js";
import type { CronJob, CronJobContext } from "../types.js";

/** Workspace name the dispatcher targets. Owns the `CLAUDE.md` prose half. */
export const REPAIR_WORKSPACE = "worker-repair";

/** Maximum candidate rows pulled from SQL per tick before app-side filtering. */
const CANDIDATE_FETCH_LIMIT = 50;

/** Joined candidate row — system_errors + per-row repair history aggregates. */
export interface CandidateRow extends SystemErrorRow {
  max_attempt_n: number;
  has_in_flight: boolean;
}

/** Slim row shape pg returns from the join query (status is text). */
type CandidateRowFromDb = Omit<SystemErrorRow, "status" | "sample_payload"> & {
  status: string;
  sample_payload: SystemErrorSamplePayload | string;
  max_attempt_n: number | string;
  has_in_flight: boolean;
};

export type QueryCandidatesFn = () => Promise<CandidateRow[]>;
export type IsWorkerFaultFn = (categoryKey: string) => boolean;
export type GetRepoContextFn = (name: string) => RepoContext;
export type UuidFn = () => string;

export interface SelfRepairDispatchLogLineSuccess {
  readonly name: "self-repair-dispatch";
  readonly kind: "dispatched";
  readonly errorId: number;
  readonly attemptN: number;
  readonly dispatchId: string;
  readonly categoryKey: string;
  readonly repo: string;
}

export interface SelfRepairDispatchLogLineSkip {
  readonly name: "self-repair-dispatch";
  readonly kind: "skip-empty" | "skip-no-candidates" | "skip-tick-error";
  readonly reason?: string;
}

export interface SelfRepairDispatchLogLineError {
  readonly name: "self-repair-dispatch";
  readonly kind: "spawn-failed" | "tick-error";
  readonly errorId?: number;
  readonly dispatchId?: string;
  readonly error: string;
}

export type SelfRepairDispatchLogLine =
  | SelfRepairDispatchLogLineSuccess
  | SelfRepairDispatchLogLineSkip
  | SelfRepairDispatchLogLineError;

export type LogFn = (line: SelfRepairDispatchLogLine) => void;

export interface SelfRepairDispatchDeps {
  /**
   * Override the candidate query. Production: a JOIN against
   * `system_errors` + `system_error_repairs` with the threshold +
   * status pre-filter. Tests inject a synchronous fixture array.
   */
  queryCandidates?: QueryCandidatesFn;
  /**
   * Override the `dispatch()` entry-point. Tests inject a stub that
   * records the call shape (workspace, issueId, task body, dispatchKind)
   * AND optionally throws to exercise the compensating delete path.
   */
  dispatchFn?: typeof defaultDispatch;
  /** Override the worker-fault category whitelist filter. */
  isWorkerFault?: IsWorkerFaultFn;
  /** Override the RepoContext resolver — tests inject a fake. */
  getRepoContext?: GetRepoContextFn;
  /** Pre-generate the dispatch UUID. Defaults to `randomUUID()`. */
  uuid?: UuidFn;
  /**
   * INSERT repair row + UPDATE error status in one tx. Returns true on
   * commit, false when the UPDATE found zero rows (raced — another tick
   * or a recordError flipped status between SELECT and UPDATE).
   */
  insertRepairAndFlipStatus?: (
    input: InsertRepairInput,
  ) => Promise<boolean>;
  /**
   * Compensating writes: DELETE the repair row + UPDATE error status
   * back to `open`. Invoked when `dispatch()` throws after the row was
   * inserted. Never throws — failures inside the compensator are
   * logged via the `log` dep so the tick can move on.
   */
  compensateFailedDispatch?: (
    input: CompensateInput,
    log: LogFn,
  ) => Promise<void>;
  /** Inject a clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Structured logger — one object per decision. */
  log?: LogFn;
}

export interface InsertRepairInput {
  errorId: number;
  attemptN: number;
  dispatchId: string;
  startedAt: Date;
}

export interface CompensateInput {
  errorId: number;
  attemptN: number;
  dispatchId: string;
}

function getPoolOrUndefined(): Pool | undefined {
  try {
    return getPool();
  } catch {
    return undefined;
  }
}

async function defaultQueryCandidates(): Promise<CandidateRow[]> {
  const pool = getPoolOrUndefined();
  if (!pool) return [];
  const { rows } = await pool.query<CandidateRowFromDb>(
    `
    SELECT
      e.id, e.signature_hash, e.category_key, e.component, e.err_class,
      e.normalized_msg, e.sample_payload, e.count, e.first_seen, e.last_seen,
      e.status, e.repo, e.recurrence_count,
      COALESCE(MAX(r.attempt_n), 0)::int AS max_attempt_n,
      -- LEFT JOIN emits one null-padded row when no repair exists, so
      -- (r.verdict IS NULL) alone aliases an "empty join" as "in-flight".
      -- Gate on (r.id IS NOT NULL) to count only real repair rows.
      COALESCE(
        BOOL_OR(r.id IS NOT NULL AND r.verdict IS NULL),
        false
      ) AS has_in_flight
    FROM system_errors e
    LEFT JOIN system_error_repairs r ON r.error_id = e.id
    WHERE e.status = 'open' AND e.count >= $1
    GROUP BY e.id
    ORDER BY e.count DESC, e.last_seen DESC
    LIMIT $2
    `,
    [REPAIR_THRESHOLD, CANDIDATE_FETCH_LIMIT],
  );
  return rows.map((r) => ({
    ...r,
    status: r.status as SystemErrorRow["status"],
    sample_payload:
      typeof r.sample_payload === "string"
        ? (JSON.parse(r.sample_payload) as SystemErrorSamplePayload)
        : r.sample_payload,
    max_attempt_n: Number(r.max_attempt_n),
    has_in_flight: Boolean(r.has_in_flight),
  }));
}

async function defaultInsertRepairAndFlipStatus(
  input: InsertRepairInput,
): Promise<boolean> {
  const pool = getPoolOrUndefined();
  if (!pool) {
    throw new Error("self-repair-dispatch: getPool() unavailable");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO system_error_repairs
         (error_id, attempt_n, card_id, dispatch_id, started_at,
          ended_at, verdict, report_md)
       VALUES ($1, $2, NULL, $3, $4, NULL, NULL, NULL)`,
      [input.errorId, input.attemptN, input.dispatchId, input.startedAt],
    );
    const updateRes = await client.query(
      `UPDATE system_errors SET status = 'repairing'
        WHERE id = $1 AND status = 'open'`,
      [input.errorId],
    );
    if (updateRes.rowCount === 0) {
      // Raced — recordError or a peer tick flipped the row between
      // SELECT + UPDATE. Roll back so the repair row never lands.
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function defaultCompensateFailedDispatch(
  input: CompensateInput,
  log: LogFn,
): Promise<void> {
  const pool = getPoolOrUndefined();
  if (!pool) return;
  try {
    await pool.query(
      `DELETE FROM system_error_repairs WHERE error_id = $1 AND attempt_n = $2`,
      [input.errorId, input.attemptN],
    );
    await pool.query(
      `UPDATE system_errors SET status = 'open' WHERE id = $1 AND status = 'repairing'`,
      [input.errorId],
    );
  } catch (err) {
    log({
      name: "self-repair-dispatch",
      kind: "tick-error",
      errorId: input.errorId,
      dispatchId: input.dispatchId,
      error:
        err instanceof Error
          ? `compensate-failed: ${err.message}`
          : `compensate-failed: ${String(err)}`,
    });
  }
}

function defaultLog(line: SelfRepairDispatchLogLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Pick the FIRST candidate that passes every app-side filter. Returns
 * `null` when no row qualifies (empty queue OR every candidate filtered
 * out). Order is the SQL `count DESC, last_seen DESC` — preserved by
 * the caller's array order.
 */
export function pickCandidate(
  candidates: readonly CandidateRow[],
  isWorkerFault: IsWorkerFaultFn,
): CandidateRow | null {
  for (const c of candidates) {
    if (!isWorkerFault(c.category_key)) continue;
    if (c.has_in_flight) continue;
    if (c.max_attempt_n >= REPAIR_CAP) continue;
    return c;
  }
  return null;
}

/**
 * One tick body. Pure orchestrator over the injected deps — no env
 * reads, no module-level state. Safe to call concurrently (the
 * single-flight guarantee comes from the in-worker cron loop's
 * `lastRunMs` gate, not from this function).
 */
export async function runSelfRepairDispatch(
  ctx: CronJobContext,
  deps: SelfRepairDispatchDeps = {},
): Promise<void> {
  const log = deps.log ?? defaultLog;
  const queryCandidates = deps.queryCandidates ?? defaultQueryCandidates;
  const dispatchFn = deps.dispatchFn ?? defaultDispatch;
  const isWorkerFault = deps.isWorkerFault ?? defaultIsWorkerFaultCategory;
  const getRepoContext = deps.getRepoContext ?? defaultGetRepoContext;
  const uuid = deps.uuid ?? randomUUID;
  const now = deps.now ?? Date.now;
  const insertRepairAndFlipStatus =
    deps.insertRepairAndFlipStatus ?? defaultInsertRepairAndFlipStatus;
  const compensateFailedDispatch =
    deps.compensateFailedDispatch ?? defaultCompensateFailedDispatch;

  try {
    const candidates = await queryCandidates();
    if (candidates.length === 0) {
      log({ name: "self-repair-dispatch", kind: "skip-empty" });
      return;
    }

    const pick = pickCandidate(candidates, isWorkerFault);
    if (!pick) {
      log({ name: "self-repair-dispatch", kind: "skip-no-candidates" });
      return;
    }

    const attemptN = pick.max_attempt_n + 1;
    const dispatchId = uuid();
    const startedAt = new Date(now());

    const committed = await insertRepairAndFlipStatus({
      errorId: pick.id,
      attemptN,
      dispatchId,
      startedAt,
    });
    if (!committed) {
      // Lost the race. Some peer (recordError flip / Phase 3 finalize)
      // moved the row's status between our SELECT and UPDATE. Move on.
      log({
        name: "self-repair-dispatch",
        kind: "skip-tick-error",
        reason: `race: error ${pick.id} status changed between fetch and dispatch`,
      });
      return;
    }

    const repo = getRepoContext(ctx.repoName);
    const taskBody = buildRepairTaskBody({ error: pick, attemptN });

    try {
      await dispatchFn({
        repo,
        task: taskBody,
        workspace: REPAIR_WORKSPACE,
        overlay: {},
        issueId: null,
        dispatchId,
        title: `Self-Repair: ${pick.category_key} (attempt ${attemptN})`,
        apiDispatchMeta: {
          trigger: "api",
          metadata: {
            endpoint: "/internal/self-repair-dispatch",
            callerIp: null,
            statusUrl: null,
            initialPrompt: taskBody,
            workspace: REPAIR_WORKSPACE,
          },
        },
      });
      log({
        name: "self-repair-dispatch",
        kind: "dispatched",
        errorId: pick.id,
        attemptN,
        dispatchId,
        categoryKey: pick.category_key,
        repo: pick.repo,
      });
    } catch (err) {
      await compensateFailedDispatch(
        { errorId: pick.id, attemptN, dispatchId },
        log,
      );
      log({
        name: "self-repair-dispatch",
        kind: "spawn-failed",
        errorId: pick.id,
        dispatchId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    log({
      name: "self-repair-dispatch",
      kind: "tick-error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const selfRepairDispatch: CronJob = {
  name: "self-repair-dispatch",
  intervalSec: 60,
  run: (ctx) => {
    if (!ctx) {
      // The in-worker cron loop always passes `ctx` for per-repo jobs;
      // legacy callers (none today, but the typing allows it) cannot
      // satisfy the repoName requirement, so fail loud.
      return Promise.reject(
        new Error(
          "self-repair-dispatch requires CronJobContext (repoName + repoRoot)",
        ),
      );
    }
    return runSelfRepairDispatch(ctx);
  },
};
