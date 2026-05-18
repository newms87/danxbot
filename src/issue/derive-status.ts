/**
 * Computed-card-state derivation (DX-582 / DX-575).
 *
 * Pure function that turns a v10+ Issue's lifecycle timestamps + gate
 * fields into its derived `IssueStatus`. The single source of truth for
 * "what column is this card in." Status remains a writable field on the
 * YAML for serializer round-trip stability — Phase 5 (DX-585) stopped
 * the agent-driven direct writes — but EVERY read goes through this
 * function via `parseIssue` so on-disk drift never leaks into business
 * logic.
 *
 * DX-658 / Phase 2 of "Blocked becomes a dispatch gate, not a status"
 * (parent epic DX-656) retired rule 3 (`blocked.at → Blocked`). The
 * `IssueStatus` union no longer contains `"Blocked"`. The card's
 * `blocked: {at, reason}` field becomes a pure dispatch gate the
 * picker reads independently — the card keeps its semantic derived
 * status (Review / In Progress / ToDo / …) while gated.
 *
 * Precedence (first match wins; ties at higher precedence beat ties at
 * lower):
 *
 *   1. `cancelled_at`                                    → `Cancelled`
 *   2. `completed_at`                                    → `Done`
 *   3. `dispatch != null` AND raw status not terminal    → `In Progress`
 *   4. `ready_at`                                        → `ToDo`
 *   5. `archived_at`                                     → `Backlog`
 *   6. fallthrough                                       → raw `issue.status`
 *
 * Rule 6 fallthrough deviation from a literal "else → Review": every
 * v10 card on disk pre-Phase-4 (DX-584) shipped with all lifecycle
 * timestamps null and `dispatch` null, so a literal Review fallthrough
 * would flip every card to Review the instant the loader switched to
 * derived. Falling through to the raw on-disk `status` makes the
 * progressive landing non-breaking — the derived value takes over as
 * timestamp triggers accumulate.
 *
 * Rule 3 (added in Phase 4 — DX-584). `dispatch != null` is the
 * authoritative "live work in flight on this card" signal. The Phase 4
 * dispatch lifecycle stamps `completed_at` / `cancelled_at` on
 * terminal save AND clears the `dispatch` sidecar at the same write,
 * so the terminal-state precedence (rules 1-2) fires before rule 3
 * even gets a look-in. Rule 3 fires AFTER the terminal-timestamp
 * rules so a terminal-stamped card whose `dispatch` block somehow
 * lingered still reads as Done / Cancelled. The picker filter
 * (`listDispatchableYamls`) requires `dispatch === null` independently,
 * so a card with a live dispatch can never be picked even when its
 * derived status says "ToDo".
 *
 * Rule 4 vs rule 5: `ready_at` (became dispatch-eligible) beats
 * `archived_at` (parked / shelved) — a card explicitly readied for
 * dispatch is not backlog regardless of any prior archival.
 */

import type { Issue, IssueStatus } from "../issue-tracker/interface.js";

/**
 * Minimal shape `deriveStatus` consumes — the dashboard SPA mirror at
 * `dashboard/src/composables/derive-status.ts` accepts the SPA's
 * `IssueListItem` projection of the same fields via this same shape so
 * the two derivations cannot drift. ANY future field the backend
 * derivation reads MUST be added here AND mirrored in the SPA shape.
 *
 * DX-658 keeps `blocked` on the shape even though `deriveStatus` no
 * longer reads it — every YAML carries the field, the wire shape is
 * unchanged, and downstream consumers (the picker, the dashboard's
 * dispatch-gates panel) still need it. Removing it from the input
 * shape would force every reader to switch types.
 */
export interface DeriveStatusInput {
  status: IssueStatus;
  dispatch: { id: string } | null;
  blocked: { at: string } | null;
  ready_at: string | null;
  archived_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

/**
 * The 6-rule precedence as a pure function. Returns the derived
 * `IssueStatus`. Accepts the full `Issue` shape OR the minimal
 * `DeriveStatusInput` projection above — both narrow to the same
 * fields. Centralize edits here; never re-derive inline at a call site.
 */
export function deriveStatus(issue: DeriveStatusInput | Issue): IssueStatus {
  if (issue.cancelled_at) return "Cancelled";
  if (issue.completed_at) return "Done";
  // DX-584 (Phase 4) — rule 3. `dispatch != null` is the live-work
  // signal AFTER terminal-timestamp rules. Guarded against
  // raw-terminal-status to preserve the pre-Phase-4 legacy heal path:
  // a card whose raw `status` is "Done" / "Cancelled" with a lingering
  // `dispatch` (pre-Phase-4 artifact where dispatch was not cleared
  // on terminal save) still derives terminal via rule 6 fallthrough
  // so `moveToClosedIfTerminal` + `healLocalYamls` flush the stuck
  // state on the next tick. Phase 4 write paths clear `dispatch` on
  // every terminal save, so the legacy pattern stops accumulating
  // going forward.
  if (
    issue.dispatch &&
    issue.status !== "Done" &&
    issue.status !== "Cancelled"
  ) {
    return "In Progress";
  }
  if (issue.ready_at) return "ToDo";
  if (issue.archived_at) return "Backlog";
  return issue.status;
}
