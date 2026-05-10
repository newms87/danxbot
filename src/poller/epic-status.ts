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
import {
  dbListChildrenByParent,
  dbListParentsToRecompute,
} from "./issues-db.js";
import { repoNameFromPath } from "./repo-name.js";
import {
  applyParentDeriveMutation,
  deriveParentStatus,
  type DeriveParentStatusResult,
} from "../issue/reconcile/parent.js";

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
 * Phase 2 (DX-217) moved the priority-rule decision function to
 * `src/issue/reconcile/parent.ts#deriveParentStatus` so reconcile step 3a
 * can call it directly. This re-export preserves the legacy
 * `deriveStatus` name for tests + audit-loop callers; the source of
 * truth is the pure helper in `reconcile/parent.ts`.
 */
export type DeriveStatusResult = DeriveParentStatusResult;
export const deriveStatus = deriveParentStatus;

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
    // DX-217: the audit-pass mutation IS reconcile step 3a's mutation.
    // Single source of truth lives in `applyParentDeriveMutation`
    // (`src/issue/reconcile/parent.ts`) — it stamps the
    // `worker:auto-derive` `status_change` history entry with the
    // priority-rule string AND maintains the
    // `status === "Blocked" ⟺ blocked !== null` schema invariant.
    const updated: Issue = applyParentDeriveMutation(
      parent,
      derived,
      new Date().toISOString(),
    );
    // Use writeIssue which always writes to open/. Derived statuses of
    // Done / Cancelled WILL leave the parent in open/ until the next
    // agent save triggers worker's open/→closed/ move; that's fine —
    // the file is still authoritative and the next save reconciles.
    await writeIssue(repoLocalPath, updated);
    changes.push({ id: parent.id, before, after: derived.status, rule: derived.rule });
  }

  return changes;
}
