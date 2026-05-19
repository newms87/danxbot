/**
 * Effective `blocked` derivation. An epic / parent card surfaces as
 * "blocked" when ANY descendant (recursive) carries a populated
 * `Issue.blocked` gate, even though the parent's own `Issue.blocked`
 * may be null. Mirrors the read-time projection style of
 * `effectiveWaitingOn` + `effectiveConflictOn`: pure function, no DB
 * column, projector emits the derived field on the wire shape so the
 * SPA reducer is a dumb upsert.
 *
 * Contract:
 *   - `self` — passthrough of `issue.blocked` (null when not self-blocked).
 *   - `inherited[]` — every descendant id whose own `blocked` is non-null,
 *     deepest-first walk order (children left-to-right, depth-first). The
 *     parent's own `self` is NEVER duplicated into `inherited[]`; the two
 *     fields are orthogonal so the SPA can render a tooltip that
 *     distinguishes "this card is self-blocked" from "a phase is blocked".
 *
 * Cycle-safety: a `visited` set keyed on issue id prevents infinite
 * recursion in malformed parent/children graphs (same shape as
 * `collectChildAssignments` in `src/dashboard/project-issue.ts`).
 *
 * Missing-child semantics: an id in `children[]` that does not resolve
 * in the supplied `byId` map is skipped. Closed cards are typically
 * absent from the open-only `byId` map the dashboard projector builds;
 * a parent's "blocked" surface is therefore driven by OPEN descendants
 * only, which matches operator intent — a Done phase no longer gates
 * the epic, regardless of the gate it carried while open.
 */

import type { Blocked, Issue } from "../issue-tracker/interface.js";

export interface InheritedBlocked {
  id: string;
  reason: string;
  at: string;
}

export interface EffectiveBlocked {
  self: Blocked | null;
  inherited: InheritedBlocked[];
}

export function effectiveBlocked(
  issue: Issue,
  byId: Map<string, Issue>,
): EffectiveBlocked {
  const inherited: InheritedBlocked[] = [];
  const visited = new Set<string>([issue.id]);
  function walk(parent: Issue): void {
    // Malformed mirror rows may carry an undefined `children` field — the
    // post-DX-642 mirror sets `_malformed: true` but doesn't always shape
    // every field. Treat missing children as empty.
    const childIds = parent.children ?? [];
    for (const cid of childIds) {
      if (visited.has(cid)) continue;
      visited.add(cid);
      const child = byId.get(cid);
      if (!child) continue;
      if (child.blocked != null) {
        inherited.push({
          id: child.id,
          reason: child.blocked.reason,
          at: child.blocked.at,
        });
      }
      walk(child);
    }
  }
  walk(issue);
  return { self: issue.blocked, inherited };
}

export function isEffectivelyBlocked(
  issue: Issue,
  byId: Map<string, Issue>,
): boolean {
  if (issue.blocked !== null) return true;
  const visited = new Set<string>([issue.id]);
  function walk(parent: Issue): boolean {
    for (const cid of parent.children) {
      if (visited.has(cid)) continue;
      visited.add(cid);
      const child = byId.get(cid);
      if (!child) continue;
      if (child.blocked !== null) return true;
      if (walk(child)) return true;
    }
    return false;
  }
  return walk(issue);
}
