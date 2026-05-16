/**
 * DX-561 (Phase 1 of DX-560 — Self-Repair): row shapes for the two
 * tables that store deduped error categories and per-attempt repair
 * history. Mirrors the column set declared in migration 021. Used by
 * `recordError` / `getOpenErrorsRanked` in `categorize.ts`; the Phase 3
 * dispatcher will consume `SystemErrorRow` directly when it scans for
 * top-ranked open errors to dispatch repair agents at.
 */

export type SystemErrorStatus = "open" | "repairing" | "fixed" | "unfixable";

/**
 * DX-566 Phase 6 — single source of truth for the self-repair cap.
 *
 * Three call sites read it; they MUST agree:
 *   - `dispatch-pick.ts` — WHERE clause refuses to pick rows with
 *     `>= REPAIR_CAP` prior attempts.
 *   - `finalize.ts` — `failed` verdict at `attempt_n >= REPAIR_CAP`
 *     flips the row to `unfixable`.
 *   - `categorize.ts` — recurrence transition at
 *     `recurrence_count + 1 >= REPAIR_CAP` flips straight to
 *     `unfixable` instead of `open`.
 *
 * Changing this value here propagates to all three. The dashboard
 * mirrors it via the `recurrence_count >= REPAIR_CAP` branch in
 * `SelfRepairTab.vue`; keep the SPA-side literal in sync by hand if
 * the cap ever moves (the cross-process boundary makes a runtime
 * import inconvenient).
 */
export const REPAIR_CAP = 3;

export interface SystemErrorRow {
  id: number;
  signature_hash: string;
  category_key: string;
  component: string;
  err_class: string;
  normalized_msg: string;
  sample_payload: SystemErrorSamplePayload;
  count: number;
  first_seen: Date;
  last_seen: Date;
  status: SystemErrorStatus;
  repo: string;
  /**
   * DX-566 (Phase 6): bumped each time `recordError` sees a NEW
   * occurrence of a signature whose current `status='fixed'`. The
   * conflict clause flips the row back to `open` on the bump; on the
   * 3rd recurrence it flips straight to `unfixable` instead.
   */
  recurrence_count: number;
}

export interface SystemErrorSamplePayload {
  raw_msg: string;
  path?: string;
  line?: number;
  stack?: string;
  [extra: string]: unknown;
}

export type SystemErrorRepairVerdict = "fixed" | "failed" | "unfixable";

export interface SystemErrorRepairRow {
  id: number;
  error_id: number;
  attempt_n: number;
  card_id: string | null;
  dispatch_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  verdict: SystemErrorRepairVerdict | null;
  report_md: string | null;
}
