/**
 * Computed-card-state derivation (DX-582 / DX-575).
 *
 * Pure function that turns a v10 Issue's lifecycle timestamps + gate
 * fields into its derived `IssueStatus`. The single source of truth for
 * "what column is this card in." Status remains a writable field on the
 * YAML for serializer round-trip stability — Phase 5 (DX-585) stops the
 * direct writes — but EVERY read goes through this function via
 * `parseIssue` so on-disk drift never leaks into business logic.
 *
 * Precedence (first match wins; ties at higher precedence beat ties at
 * lower):
 *
 *   1. `cancelled_at`                                    → `Cancelled`
 *   2. `completed_at`                                    → `Done`
 *   3. `blocked.at`                                      → `Blocked`
 *   4. `dispatch != null` AND raw status not terminal    → `In Progress`
 *   5. `ready_at`                                        → `ToDo`
 *   6. `archived_at`                                     → `Backlog`
 *   7. fallthrough                                       → raw `issue.status`
 *
 * Rule 7 deviation from the card spec (DX-582 description rule 7 reads
 * "else → Review"). Every v10 card currently on disk has all five
 * lifecycle timestamps and `dispatch` null; only `status` + `blocked.at`
 * are populated. A literal Review fallthrough would flip every existing
 * card to Review the instant the loader switches to derived. Falling
 * through to the raw on-disk `status` makes Phase 2 a non-breaking
 * landing — the derived value progressively takes over as Phase 4
 * (DX-584) wires timestamp stamping into the dispatch / poller / picker
 * transitions and the raw field drops out of relevance entirely.
 *
 * Rule 4 (added in Phase 4 — DX-584). `dispatch != null` is the
 * authoritative "live work in flight on this card" signal. The Phase 4
 * dispatch lifecycle stamps `completed_at` / `cancelled_at` / `blocked.at`
 * on terminal save AND clears the `dispatch` sidecar at the same write,
 * so the two prior on-disk patterns that blocked landing rule 4 in
 * Phase 2 are now resolved:
 *   - Terminal cards with lingering `dispatch` — the new write paths
 *     (`stampIssueCompleted`, `stampIssueCancelled`, `stampIssueBlocked`)
 *     explicitly clear `dispatch: null` so the terminal-state precedence
 *     (rules 1-2 / rule 3) fires before rule 4 even gets a look-in.
 *   - Cards forced to ToDo by `forceWaitingOnToToDo` while a transient
 *     dispatch field lingers — the rare race window where `dispatch`
 *     and `ready_at` co-exist with a forced ToDo. Rule 4 correctly
 *     surfaces such a card as In Progress because the dispatch IS
 *     live; the waiting_on gate still skips it at the picker filter,
 *     so there is no spurious re-dispatch.
 * Rule 4 fires AFTER the terminal-timestamp rules + blocked.at so a
 * terminal-stamped card whose `dispatch` block somehow lingered still
 * reads as Done / Cancelled / Blocked. The picker filter
 * (`listDispatchableYamls`) requires `dispatch === null` independently,
 * so a card with a live dispatch can never be picked even when its
 * derived status says "ToDo".
 *
 * Rule 5 vs rule 6: `ready_at` (became dispatch-eligible) beats
 * `archived_at` (parked / shelved) — a card explicitly readied for
 * dispatch is not backlog regardless of any prior archival. Same
 * precedence direction as the description body.
 */

import type { Issue, IssueStatus } from "../issue-tracker/interface.js";

/**
 * Minimal shape `deriveStatus` consumes — the dashboard SPA mirror at
 * `dashboard/src/composables/derive-status.ts` accepts the SPA's
 * `IssueListItem` projection of the same fields via this same shape so
 * the two derivations cannot drift. ANY future field the backend
 * derivation reads MUST be added here AND mirrored in the SPA shape.
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
 * The 7-rule precedence as a pure function. Returns the derived
 * `IssueStatus`. Accepts the full `Issue` shape OR the minimal
 * `DeriveStatusInput` projection above — both narrow to the same
 * fields. Centralize edits here; never re-derive inline at a call site.
 */
export function deriveStatus(issue: DeriveStatusInput | Issue): IssueStatus {
  if (issue.cancelled_at) return "Cancelled";
  if (issue.completed_at) return "Done";
  // Blocked beats dispatch: a card with `blocked.at` populated is a
  // stable explicit-gate state. Phase 4's `stampIssueBlocked` clears
  // `dispatch` at the same write, but a pre-Phase-4 Blocked card with
  // a lingering dispatch must still derive Blocked — the agent that
  // self-blocked is the authoritative signal, not the leftover
  // dispatch sidecar.
  if (issue.blocked?.at) return "Blocked";
  // DX-584 (Phase 4) — rule 4. `dispatch != null` is the live-work
  // signal AFTER terminal-timestamp + blocked rules. Guarded against
  // raw-terminal-status to preserve the pre-Phase-4 legacy heal path:
  // a card whose raw `status` is "Done" / "Cancelled" with a lingering
  // `dispatch` (pre-Phase-4 artifact where dispatch was not cleared
  // on terminal save) still derives terminal via rule 7 fallthrough
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
