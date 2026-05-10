/**
 * Pure helper for the `waiting_on` auto-clear decision. Phase 2 of the
 * Event-Driven Worker epic (DX-215 / DX-217).
 *
 * Single responsibility: given an issue with a non-null `waiting_on`
 * record AND a per-id status map of every dependency listed in
 * `waiting_on.by[]`, decide whether the dependency chain has fully
 * cleared. Pure — no fs, no db. The orchestrator
 * (`reconcileIssue` step 3b) does the DB lookup that produces the
 * `byStatuses` map, then calls this helper.
 *
 * Clear rule: `waiting_on` clears iff EVERY id in `by[]` resolves to a
 * terminal status (`Done` or `Cancelled`). A missing dependency
 * (`status === null` in the map) keeps the card waiting — the
 * alternative (treat missing as terminal) would silently unblock a card
 * whose dep was renamed, which is worse than a stuck card the operator
 * can investigate.
 *
 * Returns `false` when:
 *  - `issue.waiting_on === null` (no record to clear).
 *  - Any dep in `by[]` is missing from the status map.
 *  - Any dep's status is non-terminal (Review / ToDo / In Progress /
 *    Blocked).
 *
 * Returns `true` when every dep resolves to `Done` or `Cancelled`.
 */

import type { Issue, IssueStatus } from "../../issue-tracker/interface.js";

/**
 * Per-dep status lookup. `null` represents "no DB row" — the dep id was
 * listed in `waiting_on.by[]` but the issue isn't in the mirror. The
 * caller distinguishes "looked up and found null" from "didn't look up"
 * via `Map.has` if needed; the helper itself only consumes the value.
 */
export type ByStatusMap = Map<string, IssueStatus | null>;

export function decideWaitingOnClear(
  issue: Issue,
  byStatuses: ByStatusMap,
): boolean {
  if (issue.waiting_on === null) return false;
  for (const depId of issue.waiting_on.by) {
    if (!byStatuses.has(depId)) return false;
    const depStatus = byStatuses.get(depId);
    if (depStatus === null || depStatus === undefined) return false;
    if (depStatus !== "Done" && depStatus !== "Cancelled") return false;
  }
  return true;
}
