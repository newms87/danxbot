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
 *   1. `cancelled_at`                        → `Cancelled`
 *   2. `completed_at`                        → `Done`
 *   3. (deferred — see deferral note below)
 *   4. `blocked.at`                          → `Blocked`
 *   5. `ready_at`                            → `ToDo`
 *   6. `archived_at`                         → `Backlog`
 *   7. fallthrough                           → raw `issue.status`
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
 * Rule 3 deferral. The spec's rule 3 (`dispatch != null && !blocked.at`
 * → `In Progress`) reads the `dispatch` sidecar as authoritative for
 * the In-Progress state. Two on-disk patterns block landing it in
 * Phase 2:
 *   - Terminal cards with lingering `dispatch` (DX-202 retired the
 *     clear-on-terminal step; the dispatch field persists as an audit
 *     record of who ran the last session). Reading rule 3 over them
 *     flips Done / Cancelled cards back to In Progress and breaks the
 *     heal pass + post-completion auto-sync.
 *   - Cards forced to ToDo by `forceWaitingOnToToDo` while a transient
 *     dispatch field lingers (rare race during waiting_on save). The
 *     poller's invariant pins them to ToDo; rule 3 would silently
 *     contradict.
 * The natural co-landing is Phase 4 (DX-584) — which wires
 * `completed_at` / `cancelled_at` stamping into the dispatch lifecycle.
 * Once those timestamps populate on terminal saves, rules 1-2 cover
 * the cases rule 3 was attempting to back-derive. Until then, raw
 * `status` carries the In-Progress signal directly via fallthrough
 * (rule 7), which is correct in 100% of cases — Phase 2 ships the
 * other six rules.
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
  if (issue.blocked?.at) return "Blocked";
  if (issue.ready_at) return "ToDo";
  if (issue.archived_at) return "Backlog";
  return issue.status;
}
