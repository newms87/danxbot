/**
 * Pure helper for the parent-status derivation rule. Phase 2 of the
 * Event-Driven Worker epic (DX-215 / DX-217).
 *
 * Single responsibility: given a parent issue's children, decide what
 * the parent's status should be. The function is fully pure — no fs, no
 * db, no logger — so it can be exercised with hand-built fixtures
 * without any setup.
 *
 * Lives under `src/issue/reconcile/` because it is reconcile step 3a's
 * decision function. The poller's `recomputeParentStatuses` (a Phase-5
 * audit pass) calls this same helper for drift detection; the source of
 * truth is here.
 *
 * Priority rules (first match wins):
 *
 *  1. Any child `Blocked` → parent `Blocked`.
 *  2. Any child `Needs Approval` → parent `Needs Approval`.
 *  3. Any child `In Progress` → parent `In Progress`.
 *  4. Any child `ToDo` → parent `ToDo`.
 *  5. All non-cancelled children `Review` → parent `Review`.
 *  6. All non-cancelled children `Done` → parent `Done`.
 *  7. All children `Cancelled` (no exclusion) → parent `Cancelled`.
 *
 * Anything that doesn't fit (e.g. mix of `Review` + `Done` with no
 * `Cancelled`) returns `null` — the caller leaves the parent's current
 * status untouched. Better than forcing a guess.
 *
 * Cancelled children are excluded from rules 5 + 6 (they don't block a
 * Done / Review derivation). Rule 7 fires only when EVERY child is
 * Cancelled — a single non-Cancelled child shifts the answer.
 *
 * The `rule` string is consumed by reconcile step 5 as the `note` on
 * the appended `worker:auto-derive` `status_change` history entry
 * (DX-147), so the dashboard can correlate parent flips back to the
 * priority rule that fired without re-running the derivation.
 */

import type {
  Blocked,
  Issue,
  IssueHistoryEntry,
  IssueStatus,
} from "../../issue-tracker/interface.js";
import { appendHistory } from "../../issue-tracker/yaml.js";

export interface DeriveParentStatusResult {
  status: IssueStatus;
  rule: string;
}

export function deriveParentStatus(
  children: Issue[],
): DeriveParentStatusResult | null {
  if (children.length === 0) return null;

  if (children.some((c) => c.status === "Blocked")) {
    return { status: "Blocked", rule: "Any child Blocked — parent Blocked" };
  }
  if (children.some((c) => c.status === "Needs Approval")) {
    return {
      status: "Needs Approval",
      rule: "Any child Needs Approval — parent Needs Approval",
    };
  }
  if (children.some((c) => c.status === "In Progress")) {
    return {
      status: "In Progress",
      rule: "Any child In Progress — parent In Progress",
    };
  }
  if (children.some((c) => c.status === "ToDo")) {
    return { status: "ToDo", rule: "Any child ToDo — parent ToDo" };
  }

  const nonCancelled = children.filter((c) => c.status !== "Cancelled");
  const hasNonCancelled = nonCancelled.length > 0;
  if (hasNonCancelled && nonCancelled.every((c) => c.status === "Review")) {
    return {
      status: "Review",
      rule: "All non-cancelled children Review — parent Review",
    };
  }
  if (hasNonCancelled && nonCancelled.every((c) => c.status === "Done")) {
    return {
      status: "Done",
      rule: "All non-cancelled children Done — parent Done",
    };
  }
  if (!hasNonCancelled) {
    return {
      status: "Cancelled",
      rule: "All children Cancelled — parent Cancelled",
    };
  }

  return null;
}

/**
 * Apply a `deriveParentStatus` decision to an Issue. Single source of
 * truth for the THREE entangled mutations a parent-derive flip
 * produces:
 *
 *  1. Append `worker:auto-derive` `status_change` to `history[]` with
 *     the priority-rule string as `note` (DX-147 AC #1).
 *  2. If the new status is `Blocked` AND the issue has no self-block
 *     record yet, stamp one whose `reason` carries the derive rule.
 *  3. If the new status is non-Blocked AND a self-block record exists,
 *     clear it. Maintains the schema invariant
 *     `status === "Blocked" ⟺ blocked !== null`.
 *
 * Both `reconcileIssue` step 3a (the chokepoint) and the legacy
 * `recomputeParentStatuses` audit pass call this helper, so a future
 * refinement to the `worker:auto-derive` shape lands in one place
 * instead of drifting between the two writers.
 *
 * Returns the updated Issue. Pure — does not write to disk; the caller
 * owns the persistence step.
 */
export function applyParentDeriveMutation(
  issue: Issue,
  derived: DeriveParentStatusResult,
  now: string,
): Issue {
  const before = issue.status;
  const updatedHistory: IssueHistoryEntry[] = appendHistory(issue.history, {
    timestamp: now,
    actor: "worker:auto-derive",
    event: "status_change",
    from: before,
    to: derived.status,
    note: derived.rule,
  });
  let updatedBlocked: Blocked | null = issue.blocked;
  if (derived.status === "Blocked" && issue.blocked === null) {
    updatedBlocked = {
      reason: `Auto-derived from children: ${derived.rule}`,
      timestamp: now,
    };
  } else if (derived.status !== "Blocked" && issue.blocked !== null) {
    updatedBlocked = null;
  }
  return {
    ...issue,
    status: derived.status,
    blocked: updatedBlocked,
    history: updatedHistory,
  };
}
