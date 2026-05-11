/**
 * Effective `waiting_on` derivation. Single source of truth for "is this
 * issue's dep-chain still gating progress?" — consumed by the poller's
 * dispatch filter, the ancestor walk, and the dashboard reader.
 *
 * Design (DX-219 follow-up): the raw `Issue.waiting_on` field is a
 * **durable record** of the dep relationship. It is set when an agent or
 * operator declares the dependency and is NEVER auto-cleared on dep
 * resolution — only the agent itself (recognising a mistakenly-set link)
 * may clear it. The earlier auto-clear path (reconcile step 3b /
 * `resolveWaitingOnCards`) was removed because mutating durable state on
 * a transient condition (dep happens to be terminal) destroyed the
 * historical relationship the operator was trying to express.
 *
 * Effective state is derived at read-time instead: a card is "effectively
 * unblocked" when every id in `waiting_on.by[]` resolves to a terminal
 * status (`Done` or `Cancelled`). Effective-null means the dispatcher
 * may pick the card up AND the dashboard hides the "waiting on" badge —
 * but the YAML / DB row still carries the raw link as an audit trail.
 *
 * Missing-dep semantics: any id in `by[]` that does not resolve in the
 * supplied `byId` map keeps the card effectively waiting. The caller's
 * map must therefore include every dep the issue might reference;
 * callers that read open-only data must pre-populate the map with any
 * closed deps they care about. This mirrors the user's stated intent:
 * the dispatch gate must verify Done/Cancelled before progressing —
 * "can't find the dep" is not the same as "dep is terminal" and should
 * not auto-eligibilise the card.
 */

import type { Issue, WaitingOn } from "../issue-tracker/interface.js";

export function effectiveWaitingOn(
  issue: Issue,
  byId: Map<string, Issue>,
): WaitingOn | null {
  if (issue.waiting_on == null) return null;
  for (const depId of issue.waiting_on.by) {
    const dep = byId.get(depId);
    if (!dep) return issue.waiting_on;
    if (dep.status !== "Done" && dep.status !== "Cancelled") {
      return issue.waiting_on;
    }
  }
  return null;
}

export function isEffectivelyWaitingOn(
  issue: Issue,
  byId: Map<string, Issue>,
): boolean {
  return effectiveWaitingOn(issue, byId) !== null;
}
