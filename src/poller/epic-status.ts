/**
 * Auto-derive a parent issue's status from the union of its children's
 * statuses (ISS-98). Runs every poller tick after `bulkSyncMissingYamls`,
 * before dispatch decisions, so the same tick that hydrates a freshly
 * created child card propagates its status up the parent chain.
 *
 * Contract:
 *
 *  - The parent's `status` field is **derivation-owned**. Agent edits to
 *    a parent's status are overwritten on the next poller tick. The
 *    skill docs explicitly tell agents to NOT touch epic status; they
 *    edit child statuses, derivation propagates up.
 *  - Cancelled children are excluded from rules 4 + 5 (they don't block
 *    a Done / Review derivation). Rule 6 fires only when EVERY child is
 *    Cancelled — a single non-Cancelled child shifts the answer.
 *  - Parents with `waiting_on != null` are skipped — the worker normalizes
 *    waiting-on parents to `status: ToDo` on save, so writing a derived
 *    status would just churn IO every tick.
 *  - Children may live in `open/` or `closed/`. The walker reads both
 *    via `loadLocal`, which short-circuits on the open/ hit and falls
 *    back to closed/ for terminal children (Done / Cancelled).
 *  - When the union of child statuses doesn't satisfy any rule (e.g.
 *    `Review` + `Done` with no `Cancelled`), `deriveStatus` returns
 *    `null` and the caller leaves the parent untouched. Better than
 *    forcing a guess.
 *
 * Pure-local: no tracker imports, no logger import. Outbound mirror to
 * the tracker happens via the existing `syncIssue` path on the parent's
 * next reconcile (the worker's per-tick poller mirror). The poller does
 * not push the derived status itself — accepts brief tracker-side drift
 * in exchange for keeping this module pure-local + cheap.
 *
 * Priority rules (first match wins):
 *
 *  1. Any child `Needs Help` OR `Needs Approval` → parent inherits the
 *     same status. `Needs Help` wins if both are present (signals
 *     blocking-on-info, which is louder than blocking-on-approval).
 *     Both are non-dispatchable, so either lifts the parent into a
 *     non-dispatchable state.
 *  2. Any child `In Progress` → parent `In Progress`.
 *  3. Any child `ToDo` → parent `ToDo`.
 *  4. All non-cancelled children `Review` → parent `Review`.
 *  5. All non-cancelled children `Done` → parent `Done`.
 *  6. All children `Cancelled` (no exclusion) → parent `Cancelled`.
 *
 * Anything that doesn't fit (e.g. mix of `Review` + `Done` with no
 * `Cancelled`) returns `null`.
 */

import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import { writeIssue } from "./yaml-lifecycle.js";
import { appendHistory } from "../issue-tracker/yaml.js";
import {
  dbListChildrenByParent,
  dbListParentsToRecompute,
} from "./issues-db.js";
import { repoNameFromPath } from "./repo-name.js";

export interface ParentStatusChange {
  id: string;
  before: IssueStatus;
  after: IssueStatus;
  /**
   * Human-readable description of the priority rule that produced
   * `after`. Threaded onto the parent's `history[]` as the `note` of the
   * `worker:auto-derive` `status_change` entry — DX-147 AC #1.
   */
  rule: string;
}

/**
 * Result of `deriveStatus` — the derived parent status PLUS the rule
 * that produced it. The rule string is consumed by `recomputeParentStatuses`
 * as the `note` on the appended `worker:auto-derive` `status_change`
 * history entry (DX-147), so the dashboard can correlate parent flips
 * back to the priority rule that fired without re-running the derivation.
 */
export interface DeriveStatusResult {
  status: IssueStatus;
  rule: string;
}

export function deriveStatus(children: Issue[]): DeriveStatusResult | null {
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
    return { status: "In Progress", rule: "Any child In Progress — parent In Progress" };
  }
  if (children.some((c) => c.status === "ToDo")) {
    return { status: "ToDo", rule: "Any child ToDo — parent ToDo" };
  }

  // Rules 4 + 5: terminal-or-review derivation excludes Cancelled
  // children (they don't block a Done/Review parent).
  const nonCancelled = children.filter((c) => c.status !== "Cancelled");
  const hasNonCancelled = nonCancelled.length > 0;
  if (hasNonCancelled && nonCancelled.every((c) => c.status === "Review")) {
    return {
      status: "Review",
      rule: "All non-cancelled children Review — parent Review",
    };
  }
  if (hasNonCancelled && nonCancelled.every((c) => c.status === "Done")) {
    return { status: "Done", rule: "All non-cancelled children Done — parent Done" };
  }
  if (!hasNonCancelled) {
    return { status: "Cancelled", rule: "All children Cancelled — parent Cancelled" };
  }

  // Mixed terminal states (e.g. Review + Done) — caller leaves the
  // parent's current status untouched.
  return null;
}

/**
 * Iterate every issue in the DB whose `children[]` is non-empty and
 * status is non-terminal, re-deriving its `status` from the union of its
 * children's statuses. Writes the parent's YAML only when the derived
 * status differs from the on-disk status. Returns the list of changes
 * (id + before/after) so the caller can log them.
 *
 * Phase 4 (DX-155) — DB-backed: replaces the YAML walk with two SQL
 * queries (parents + children-by-parent_id). Children of any parent are
 * fetched via the `(repo_name, parent_id)` partial index. The `prefix`
 * parameter is unused under SQL but kept for caller compatibility.
 *
 * Skips:
 *  - Parents with `waiting_on != null` (the worker forces those to
 *    `status: ToDo` on save; deriving would churn IO).
 *  - Parents whose every listed child is missing from the DB (defensive
 *    — `deriveStatus` of an empty resolved set returns null).
 *  - Parents whose derived status equals the current status.
 *
 * Closed parents are not walked: the SQL filter excludes Done /
 * Cancelled rows.
 */
export async function recomputeParentStatuses(
  repoLocalPath: string,
  _prefix: string,
): Promise<ParentStatusChange[]> {
  const repoName = repoNameFromPath(repoLocalPath);
  const parents = await dbListParentsToRecompute(repoName);
  const changes: ParentStatusChange[] = [];

  for (const parent of parents) {
    if (parent.children.length === 0) continue;
    if (parent.waiting_on !== null) continue;

    // Fetch every child of this parent via the (repo_name, parent_id)
    // index. Missing rows (children referenced in the parent's
    // `children[]` but absent from the DB) are silently dropped — the
    // alternative (treat missing as "blocks derivation") would lock a
    // parent's status forever after a child is renamed / deleted.
    const resolved = await dbListChildrenByParent(repoName, parent.id);
    if (resolved.length === 0) continue;

    const derived = deriveStatus(resolved);
    if (derived === null) continue;
    if (derived.status === parent.status) continue;

    const before = parent.status;
    // DX-147: every auto-derive flip leaves an audit-log entry on the
    // parent attributing the change to `worker:auto-derive` with the
    // priority-rule string as the `note`. The writer KNOWS what it
    // changed (deterministic, single source) so we call `appendHistory`
    // directly rather than rerunning a diff against a cached snapshot.
    const updatedHistory = appendHistory(parent.history, {
      timestamp: new Date().toISOString(),
      actor: "worker:auto-derive",
      event: "status_change",
      from: before,
      to: derived.status,
      note: derived.rule,
    });
    // Maintain the v4 invariant `status === "Blocked" ⟺ blocked !== null`
    // when the auto-derive promotes the parent to / from Blocked. The
    // self-block reason carries the derive-rule string so a reader can
    // see why the parent was auto-flipped without walking children.
    let updatedBlocked = parent.blocked;
    if (derived.status === "Blocked" && parent.blocked === null) {
      updatedBlocked = {
        reason: `Auto-derived from children: ${derived.rule}`,
        timestamp: new Date().toISOString(),
      };
    } else if (derived.status !== "Blocked" && parent.blocked !== null) {
      updatedBlocked = null;
    }
    const updated: Issue = {
      ...parent,
      status: derived.status,
      blocked: updatedBlocked,
      history: updatedHistory,
    };
    // Use writeIssue which always writes to open/. Derived statuses of
    // Done / Cancelled WILL leave the parent in open/ until the next
    // agent save triggers worker's open/→closed/ move; that's fine —
    // the file is still authoritative and the next save reconciles.
    await writeIssue(repoLocalPath, updated);
    changes.push({ id: parent.id, before, after: derived.status, rule: derived.rule });
  }

  return changes;
}
