/**
 * Row shapes for the two tables that store deduped error categories
 * and per-attempt repair history. Mirrors the column set declared in
 * migration 021. Used by `recordError` in `categorize.ts` (write path)
 * + the dashboard read surface (`db-reads.ts`, `self-repair-routes.ts`).
 *
 * NOTE: the card-creating dispatcher (DX-560) was retired; the
 * `"repairing"` status + `SystemErrorRepairVerdict` are reserved for
 * the DX-580 worker-fault rebuild and no current code writes them.
 */

export type SystemErrorStatus = "open" | "repairing" | "fixed" | "unfixable";

/**
 * Single source of truth for the self-repair cap.
 *
 * Live consumers:
 *   - `categorize.ts` — recurrence transition at
 *     `recurrence_count + 1 >= REPAIR_CAP` flips straight to
 *     `unfixable` instead of `open` (the only path that fires today).
 *
 * Reserved for DX-580 rebuild:
 *   - dispatcher pick query — refuse rows with `>= REPAIR_CAP` attempts.
 *   - finalize hook — `failed` verdict at `attempt_n >= REPAIR_CAP`
 *     flips the row to `unfixable`.
 *
 * The dashboard mirrors the literal via `recurrence_count >= REPAIR_CAP`
 * in `SelfRepairTab.vue`; keep the SPA-side literal in sync by hand if
 * the cap moves (cross-process boundary makes runtime import
 * inconvenient).
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
