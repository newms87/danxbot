/**
 * SPA mirror of `src/issue/derive-status.ts` (DX-582 / DX-575).
 *
 * Byte-identical 7-rule precedence so SSE-pushed `issue:updated` rows
 * render the derived status without a refetch. The backend's
 * `parseIssue` runs the same logic; the wire-shape carries the
 * lifecycle timestamps + gate fields the dashboard needs to re-derive
 * client-side.
 *
 * Lockstep contract: this function MUST stay structurally identical
 * to `deriveStatus` in `src/issue/derive-status.ts`. Adding a field
 * to the backend derivation requires adding the same field to the
 * `DeriveStatusInput` shape here AND to the SPA's wire-shape upstream.
 * The shared unit-test fixture lives in `derive-status.test.ts` on
 * both sides — when one drifts, the other breaks.
 *
 * See the backend file's docstring for rule-7 deviation rationale.
 */

import type { IssueStatus } from "../types";

export interface DeriveStatusInput {
  status: IssueStatus;
  dispatch: { id: string } | null;
  blocked: { at: string } | null;
  ready_at: string | null;
  archived_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export function deriveStatus(issue: DeriveStatusInput): IssueStatus {
  if (issue.cancelled_at) return "Cancelled";
  if (issue.completed_at) return "Done";
  if (issue.blocked?.at) return "Blocked";
  if (issue.ready_at) return "ToDo";
  if (issue.archived_at) return "Backlog";
  return issue.status;
}
