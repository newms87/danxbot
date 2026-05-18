/**
 * Pure helper for the parent-status derivation rule. Phase 2 of the
 * Event-Driven Worker epic (DX-215 / DX-217).
 *
 * Single responsibility: given a parent issue's children, decide what
 * the parent's status should be. The function is fully pure — no fs, no
 * db, no logger — so it can be exercised with hand-built fixtures
 * without any setup.
 *
 * DX-658 / Phase 2 of "Blocked becomes a dispatch gate, not a status"
 * (parent epic DX-656) retired `"Blocked"` from `IssueStatus` AND
 * removed the Blocked rollup rule. Children with `blocked: {at,
 * reason}` populated keep their semantic status (Review / In Progress
 * / ToDo / …); the picker reads the gate independently. The parent's
 * derived status now follows the remaining six rules over the
 * children's union — a self-blocked child neither pulls the parent
 * onto a parking status nor stamps the parent's `blocked` field.
 *
 * Priority rules (first match wins). Each rule consults the child's
 * DERIVED status (`deriveStatus(child)`) — never the raw on-disk
 * `child.status` — so a parent rollup never lags the child's
 * timestamp-driven transitions. See `src/issue/derive-status.ts`.
 *
 *  1. Any child `In Progress` → parent `In Progress`.
 *  2. Any child `ToDo` → parent `ToDo`.
 *  3. All non-cancelled children `Review` → parent `Review`.
 *  4. All non-cancelled children `Backlog` → parent `Backlog` (DX-582).
 *     Mixed Backlog + Done counts as the project being shelved with
 *     completed work behind it — rule 5 (Done) still wins when every
 *     non-cancelled child is Done. Rule 4 fires only when every
 *     non-cancelled child is parked.
 *  5. All non-cancelled children `Done` → parent `Done`.
 *  6. All children `Cancelled` (no exclusion) → parent `Cancelled`.
 *
 * `Needs Approval` was retired in DX-231 (schema_version 6). The
 * orthogonal `requires_human` field replaces the parking status —
 * children carrying it do NOT propagate to the parent (only the dispatch
 * filter consults the field; epic-level rollup is purely status-based).
 *
 * Anything that doesn't fit (e.g. mix of `Review` + `Done` with no
 * `Cancelled`) returns `null` — the caller leaves the parent's current
 * status untouched. Better than forcing a guess.
 *
 * Cancelled children are excluded from rules 3-5 (they don't block a
 * Done / Review derivation). Rule 6 fires only when EVERY child is
 * Cancelled — a single non-Cancelled child shifts the answer.
 *
 * The `rule` string is consumed by reconcile step 5 as the `note` on
 * the appended `worker:auto-derive` `status_change` history entry
 * (DX-147), so the dashboard can correlate parent flips back to the
 * priority rule that fired without re-running the derivation.
 */

import type {
  Issue,
  IssueHistoryEntry,
  IssueStatus,
} from "../../issue-tracker/interface.js";
import { appendHistory } from "../../issue-tracker/yaml.js";
import { deriveStatus } from "../derive-status.js";

export interface DeriveParentStatusResult {
  status: IssueStatus;
  rule: string;
}

export function deriveParentStatus(
  children: Issue[],
): DeriveParentStatusResult | null {
  if (children.length === 0) return null;

  const derived = children.map((c) => deriveStatus(c));

  if (derived.some((s) => s === "In Progress")) {
    return {
      status: "In Progress",
      rule: "Any child In Progress — parent In Progress",
    };
  }
  if (derived.some((s) => s === "ToDo")) {
    return { status: "ToDo", rule: "Any child ToDo — parent ToDo" };
  }

  const nonCancelled = derived.filter((s) => s !== "Cancelled");
  const hasNonCancelled = nonCancelled.length > 0;
  if (hasNonCancelled && nonCancelled.every((s) => s === "Review")) {
    return {
      status: "Review",
      rule: "All non-cancelled children Review — parent Review",
    };
  }
  if (hasNonCancelled && nonCancelled.every((s) => s === "Backlog")) {
    return {
      status: "Backlog",
      rule: "All non-cancelled children Backlog — parent Backlog",
    };
  }
  if (hasNonCancelled && nonCancelled.every((s) => s === "Done")) {
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
 * Apply a `deriveParentStatus` decision to an Issue. Appends a
 * `worker:auto-derive` `status_change` entry to `history[]` with the
 * priority-rule string as `note` (DX-147 AC #1).
 *
 * DX-658 / Phase 2 retired the auto-stamp-clear of `Issue.blocked` —
 * the gate is now independent of the parent's derived status and
 * never modified by the parent-derive path. The previous invariant
 * (`status === "Blocked" ⟺ blocked !== null`) is gone.
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
  return {
    ...issue,
    status: derived.status,
    history: updatedHistory,
  };
}
