/**
 * DX-561 (Phase 1 of DX-560 — Self-Repair): row shapes for the two
 * tables that store deduped error categories and per-attempt repair
 * history. Mirrors the column set declared in migration 021. Used by
 * `recordError` / `getOpenErrorsRanked` in `categorize.ts`; the Phase 3
 * dispatcher will consume `SystemErrorRow` directly when it scans for
 * top-ranked open errors to dispatch repair agents at.
 */

export type SystemErrorStatus = "open" | "repairing" | "fixed" | "unfixable";

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
