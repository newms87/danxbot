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
 * Return contract: when the card IS still effectively waiting, the
 * returned record carries a FILTERED `by[]` containing only the deps
 * that are still gating progress — terminal (Done / Cancelled) deps
 * are removed. This is what every consumer wants for display + counting
 * ("WAITING ON N" pills, dispatch gate reasoning, drawer partner list).
 * The raw, unfiltered record remains on `issue.waiting_on` for callers
 * that need the durable history. Order in `by[]` mirrors the raw record;
 * a fresh array is returned on every call (no mutation of the input).
 *
 * Missing-dep semantics: any id in `by[]` that does not resolve in the
 * supplied `byId` map is KEPT in the filtered `by[]` and KEEPS the card
 * effectively waiting. The caller's map must therefore include every dep
 * the issue might reference; callers that read open-only data must pre-
 * populate the map with any closed deps they care about. This mirrors
 * the user's stated intent: the dispatch gate must verify Done/Cancelled
 * before progressing — "can't find the dep" is not the same as "dep is
 * terminal" and should not auto-eligibilise the card.
 */

import type { Issue, WaitingOn } from "../issue-tracker/interface.js";
import { deriveStatus } from "./derive-status.js";

export function effectiveWaitingOn(
  issue: Issue,
  byId: Map<string, Issue>,
): WaitingOn | null {
  if (issue.waiting_on == null) return null;
  const filtered: string[] = [];
  for (const depId of issue.waiting_on.by) {
    const dep = byId.get(depId);
    if (!dep) {
      // Missing → keep as a still-gating dep (fail-safe).
      filtered.push(depId);
      continue;
    }
    // DX-584 (Phase 4) — derived semantic state. A dep with terminal
    // timestamps but stale raw `status` still counts as terminal; same
    // for the inverse (raw "Done" without `completed_at` per the
    // pre-Phase-4 write path).
    const depDerived = deriveStatus(dep);
    if (depDerived !== "Done" && depDerived !== "Cancelled") {
      filtered.push(depId);
    }
  }
  if (filtered.length === 0) return null;
  return {
    reason: issue.waiting_on.reason,
    timestamp: issue.waiting_on.timestamp,
    by: filtered,
  };
}

export function isEffectivelyWaitingOn(
  issue: Issue,
  byId: Map<string, Issue>,
): boolean {
  return effectiveWaitingOn(issue, byId) !== null;
}
