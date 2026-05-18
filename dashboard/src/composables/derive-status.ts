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

import type { IssueStatus, List, ListType } from "../types";

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
  // DX-584 (Phase 4) — rule 4. `dispatch != null` is the live-work
  // signal AFTER terminal-timestamp + blocked rules, guarded against
  // raw-terminal status so a legacy Done/Cancelled card with
  // lingering dispatch still derives terminal via rule 7 fallthrough.
  // Mirror of `src/issue/derive-status.ts`.
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

/**
 * DX-639 — semantic-status → `ListType` projection.
 *
 * Pure mirror of `deriveListTypeFromSemanticStatus` in
 * `src/issue/list-resolve.ts`. Total over the seven `IssueStatus`
 * values; the dashboard composes this with `deriveStatus` to project
 * the column the card BELONGS in independent of the denormalized
 * `list_name` field on the wire.
 */
export function deriveListTypeFromStatus(status: IssueStatus): ListType {
  switch (status) {
    case "Backlog":
      return "archived";
    case "Review":
      return "review";
    case "ToDo":
      return "ready";
    case "In Progress":
      return "in_progress";
    case "Blocked":
      return "blocked";
    case "Done":
      return "completed";
    case "Cancelled":
      return "cancelled";
  }
}

/**
 * DX-639 — derive the list name a card SHOULD live in from its
 * lifecycle triggers + the per-repo list taxonomy. Composes
 * `deriveStatus(card)` → `deriveListTypeFromStatus(status)` →
 * the type's default list. Returns null when the taxonomy carries
 * no default list for the projected type (lists-routes guarantees
 * ≥1 default per type, so null is only reachable during the brief
 * pre-hydrate window before the SPA's first lists fetch resolves).
 *
 * Reading the raw `list_name` field for column grouping is forbidden
 * — DX-624 proved a single missed `list_name` projection event
 * leaves a Done card rendered in In Progress forever. This helper is
 * the single read-path projection; the field stays writable as a
 * denormalized display cache + tracker round-trip carrier but never
 * informs grouping decisions.
 */
export function derivedListName(
  card: DeriveStatusInput,
  lists: readonly List[],
): string | null {
  const type = deriveListTypeFromStatus(deriveStatus(card));
  const def = lists.find((l) => l.is_default_for_type && l.type === type);
  return def?.name ?? null;
}
