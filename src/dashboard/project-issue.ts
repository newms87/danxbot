/**
 * Shared issue projector. Builds the canonical `IssueListItem` wire shape
 * from a raw `Issue` + the in-memory `byId` + `allOpen` set the projection
 * needs for cross-card derived fields (`children_detail`,
 * `child_assignments`, `requires_human_child_count`, effective
 * `waiting_on`, `conflict_on_active_count`).
 *
 * This is the SINGLE source of truth for the projection. Both code paths
 * that ship issues to the SPA call it:
 *
 *   - REST `/api/issues` (via `issues-reader.ts#listIssues` → `toListItem`)
 *   - SSE `issue:updated` (via `publish-issue-update.ts#publishIssueUpsert`)
 *
 * Keeping derivation here — not in the SPA — means the client reducer is
 * a dumb id-keyed upsert. There is no client-side recomputation; the
 * server is responsible for emitting the correct projected shape on every
 * lifecycle event.
 */

import type {
  Issue,
  IssueStatus,
  IssueType,
} from "../issue-tracker/interface.js";
import { cloneTriage } from "../issue-tracker/interface.js";
import { effectiveWaitingOn } from "../issue/effective-waiting-on.js";
import { effectiveConflictOn } from "../issue/effective-conflict-on.js";
import { deriveCreatedAt } from "./issue-created-at.js";
import type {
  IssueListChild,
  IssueListChildAssignment,
  IssueListItem,
} from "./issues-reader.js";

/**
 * Non-terminal child statuses contributing to the parent `child_assignments`
 * rollup. `Done` / `Cancelled` children excluded so stale agent names from
 * completed work do not surface on the parent row; `Review` excluded
 * because cards there have not yet been picked up — a stamped
 * `assigned_agent` there is almost certainly leftover triage residue, not
 * active work. Mirrors pre-extraction logic in `issues-reader.ts`.
 */
const ASSIGNABLE_STATUSES = new Set<IssueStatus>([
  "ToDo",
  "In Progress",
  "Blocked",
]);

function collectChildAssignments(
  root: Issue,
  byId: Map<string, Issue>,
): IssueListChildAssignment[] {
  const out: IssueListChildAssignment[] = [];
  const visited = new Set<string>([root.id]);
  function walk(parent: Issue): void {
    for (const cid of parent.children) {
      if (visited.has(cid)) continue;
      visited.add(cid);
      const child = byId.get(cid);
      if (!child) continue;
      if (
        ASSIGNABLE_STATUSES.has(child.status) &&
        child.assigned_agent !== null
      ) {
        out.push({
          agent: child.assigned_agent,
          issue_id: child.id,
          issue_title: child.title,
        });
      }
      walk(child);
    }
  }
  walk(root);
  return out;
}

export function projectIssue(
  issue: Issue,
  mtimeMs: number,
  byId: Map<string, Issue>,
  allOpen: readonly Issue[],
): IssueListItem {
  const childrenDetail: IssueListChild[] = issue.children.map((cid) => {
    const child = byId.get(cid);
    if (!child) {
      // Missing child → surface as waiting so SPA routes to ⛔ chip.
      return {
        id: cid,
        name: `<${cid}: unknown>`,
        type: "Feature" as IssueType,
        status: "ToDo" as IssueStatus,
        waiting_on: true,
        waiting_on_by_card: false,
        requires_human: false,
        missing: true,
      };
    }
    const childEffective = effectiveWaitingOn(child, byId);
    return {
      id: cid,
      name: child.title,
      type: child.type,
      status: child.status,
      waiting_on: childEffective !== null,
      waiting_on_by_card:
        childEffective !== null && childEffective.by.length > 0,
      requires_human: child.requires_human !== null,
      missing: false,
    };
  });
  const effective = effectiveWaitingOn(issue, byId);
  const conflictReport = effectiveConflictOn(issue, allOpen);
  return {
    id: issue.id,
    type: issue.type,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    parent_id: issue.parent_id,
    children: [...issue.children],
    ac_total: issue.ac.length,
    ac_done: issue.ac.filter((a) => a.checked).length,
    children_detail: childrenDetail,
    waiting_on: effective !== null,
    waiting_on_reason: effective?.reason ?? null,
    waiting_on_by: effective?.by ?? [],
    comments_count: issue.comments.length,
    has_retro:
      issue.retro.good.length > 0 ||
      issue.retro.bad.length > 0 ||
      issue.retro.action_item_ids.length > 0 ||
      issue.retro.commits.length > 0,
    updated_at: mtimeMs,
    created_at: deriveCreatedAt(issue.external_id, mtimeMs),
    priority: issue.priority,
    position: issue.position,
    assigned_agent: issue.assigned_agent,
    requires_human: issue.requires_human,
    requires_human_child_count: childrenDetail.filter((c) => c.requires_human)
      .length,
    blocked: issue.blocked,
    list_name: issue.list_name,
    conflict_on: issue.conflict_on.map((e) => ({ ...e })),
    conflict_on_active_count:
      conflictReport.forward.length + conflictReport.reverse.length,
    triage: cloneTriage(issue.triage),
    child_assignments: collectChildAssignments(issue, byId),
  };
}
