/**
 * DX-630 (Phase 4 of DX-626 — Priority cascade + epic-move cascade dialog).
 *
 * Pure-function core of the recursive epic-move cascade. Given a parent
 * card being moved to a destination `ListType` + `listName`, computes
 * the per-descendant trigger writes that produce the desired derived
 * status on each child per the 4×4 spec table in DX-626.
 *
 * The helper is PURE — no `Date.now()`, no I/O, no MCP, no DB. The
 * caller passes `now: string` (or accepts the boundary default) so unit
 * tests can pin timestamps. BFS-flattening of descendants is the
 * caller's job; this module iterates `descendants[]` verbatim and
 * preserves input order in `childWrites[]`.
 *
 * Phase 5 (DX-631) wires this into a PATCH `/api/issues/cascade`
 * endpoint that resolves dispatchable-by-priority via the existing
 * picker query, calls `cascadeEpicMove`, and applies each write
 * through `applyListMove`. Phase 6 (DX-632) wires the endpoint to the
 * `EpicMoveCascadeDialog.vue`. This phase ships ONLY the pure fn +
 * tests; do not import dispatcher / route / dialog code here.
 *
 * DX-658 / Phase 2 of "Blocked becomes a dispatch gate, not a status"
 * (parent epic DX-656) retired the `"blocked"` ListType + the
 * `"Blocked"` IssueStatus. List-moves (drag + cascade) NEVER touch
 * the `Issue.blocked` gate field — clearing / setting the gate is a
 * separate dispatch-gates affordance in the dashboard. The cascade's
 * source-row / destination-column branches that previously special-
 * cased the blocked tier are gone.
 *
 * Spec table (FROM rows ↓, TO cols →) — source of truth is DX-626's
 * body, post-DX-658 simplification.
 *
 *   FROM ↓ \ TO →         review/ready/archived | in_progress       | completed       | cancelled
 *   review/ready/archived | SAME-TYPE-LATERAL   | FIRST-DISPATCH    | move→completed  | move→cancelled
 *   in_progress           | stay                | stay              | move→completed  | move→cancelled
 *   completed             | stay                | stay              | stay            | stay
 *   cancelled             | stay                | stay              | stay            | stay
 *
 * - `SAME-TYPE-LATERAL`: descendant in `parent.list_name` moves to
 *   `destListName`; descendants in another same-type list stay.
 * - `FIRST-DISPATCH`: only the first entry in `dispatchableByPriority`
 *   whose current `ListType` ∈ {review, ready, archived} moves;
 *   helper consumes the list, never recomputes it.
 */

import type { Issue } from "../issue-tracker/interface.js";
import type { ListType } from "../lists-types.js";
import { deriveStatus } from "./derive-status.js";
import { deriveListTypeFromSemanticStatus } from "./list-resolve.js";

export type CascadeAction =
  /** Descendant stays where it is — no write emitted. */
  | { kind: "stay" }
  /** Descendant moves to the parent's destListType / destListName. */
  | { kind: "move_same_type" }
  /** Descendant moves to an operator-chosen list (override path). */
  | { kind: "move_to"; listType: ListType; listName: string };

/**
 * Trigger-write patch for a single Issue. Fields absent here are left
 * unchanged on the target YAML; explicit `null` clears the trigger so
 * `deriveStatus` re-projects to the intended `ListType`.
 *
 * `priority` is currently unused by the cascade — reserved for a
 * future hook (e.g. drag-reorder priority bump during a cascade).
 *
 * DX-658 / Phase 2 — the `blocked` field is intentionally absent;
 * cascades never touch the self-block gate.
 */
export interface TriggerWrite {
  completed_at?: string | null;
  cancelled_at?: string | null;
  ready_at?: string | null;
  archived_at?: string | null;
  list_name?: string;
  priority?: number;
}

export interface CascadeMoveInput {
  /** Card being moved. Any type with non-empty `children[]`. */
  parent: Issue;
  /** BFS-flattened descendants — caller's responsibility to flatten. */
  descendants: Issue[];
  destListType: ListType;
  destListName: string;
  /** Per-descendant override keyed by `issue.id`. */
  overrides?: Record<string, CascadeAction>;
  /**
   * First-dispatchable-by-priority list. Phase 5 supplies this from
   * the picker query; helper consumes verbatim and does not compute.
   */
  dispatchableByPriority?: Issue[];
  /** ISO 8601 timestamp for every stamped trigger; boundary default
   * `new Date().toISOString()` keeps the helper pure for tests. */
  now?: string;
}

export interface CascadeMoveOutput {
  parentWrite: TriggerWrite;
  childWrites: Array<{ id: string; write: TriggerWrite }>;
}

/**
 * Derive a card's current `ListType` via `deriveStatus` →
 * `deriveListTypeFromSemanticStatus`. The cascade keys on TYPE, never
 * on raw `status` or `list_name`.
 */
export function deriveListTypeForIssue(issue: Issue): ListType {
  return deriveListTypeFromSemanticStatus(deriveStatus(issue));
}

export function cascadeEpicMove(input: CascadeMoveInput): CascadeMoveOutput {
  const {
    parent,
    descendants,
    destListType,
    destListName,
    overrides = {},
    dispatchableByPriority = [],
    now = new Date().toISOString(),
  } = input;

  const parentWrite: TriggerWrite = triggerWritesForDest(
    destListType,
    destListName,
    now,
  );

  const parentSourceListName = parent.list_name;

  // First-dispatchable id is the unique descendant id eligible for
  // the FIRST-DISPATCH spec cell. Computed once outside the loop:
  // skip anything not currently in a passive (review/ready/archived)
  // tier so an already-running child doesn't consume the slot.
  let firstDispatchableId: string | null = null;
  if (destListType === "in_progress") {
    for (const d of dispatchableByPriority) {
      const t = deriveListTypeForIssue(d);
      if (t === "review" || t === "ready" || t === "archived") {
        firstDispatchableId = d.id;
        break;
      }
    }
  }

  const childWrites: Array<{ id: string; write: TriggerWrite }> = [];

  for (const child of descendants) {
    const childCurrentType = deriveListTypeForIssue(child);
    const override = overrides[child.id];

    const action: CascadeAction =
      override ??
      defaultAction({
        childCurrentType,
        destListType,
        childListName: child.list_name,
        parentSourceListName,
        isFirstDispatchable: firstDispatchableId === child.id,
      });

    if (action.kind === "stay") continue;

    let writeListType: ListType;
    let writeListName: string;
    if (action.kind === "move_same_type") {
      writeListType = destListType;
      writeListName = destListName;
    } else {
      writeListType = action.listType;
      writeListName = action.listName;
    }

    const write = triggerWritesForDest(writeListType, writeListName, now);
    childWrites.push({ id: child.id, write });
  }

  return { parentWrite, childWrites };
}

/**
 * Spec-table lookup. Returns the default `CascadeAction` for a
 * descendant given its current `ListType`, the parent's destination
 * type, and the lateral / first-dispatchable context. Override path
 * skips this lookup entirely.
 */
function defaultAction(args: {
  childCurrentType: ListType;
  destListType: ListType;
  childListName: string | null;
  parentSourceListName: string | null;
  isFirstDispatchable: boolean;
}): CascadeAction {
  const {
    childCurrentType,
    destListType,
    childListName,
    parentSourceListName,
    isFirstDispatchable,
  } = args;

  // Terminal sources never auto-move (completed never auto-cancels;
  // cancelled never auto-completes; neither ever re-opens).
  if (childCurrentType === "completed" || childCurrentType === "cancelled") {
    return { kind: "stay" };
  }

  // FROM in_progress rows: only TO completed / cancelled move; the
  // rest stay.
  if (childCurrentType === "in_progress") {
    if (destListType === "completed" || destListType === "cancelled") {
      return { kind: "move_same_type" };
    }
    return { kind: "stay" };
  }

  // FROM passive (review / ready / archived).
  const destIsPassive =
    destListType === "review" ||
    destListType === "ready" ||
    destListType === "archived";

  if (destIsPassive) {
    // SAME-TYPE-LATERAL: only descendants currently in
    // parent.list_name follow the parent across the rename.
    if (
      parentSourceListName !== null &&
      childListName !== null &&
      childListName === parentSourceListName
    ) {
      return { kind: "move_same_type" };
    }
    return { kind: "stay" };
  }

  if (destListType === "in_progress") {
    return isFirstDispatchable ? { kind: "move_same_type" } : { kind: "stay" };
  }

  // dest is completed or cancelled — every passive descendant moves.
  return { kind: "move_same_type" };
}

/**
 * Produce the `TriggerWrite` patch that makes `deriveStatus` project
 * an Issue to the given `ListType`. Each branch explicitly nulls the
 * lifecycle timestamps the dest doesn't want so a card crossing the
 * ladder backward (e.g. Done → ToDo via override) clears the higher
 * triggers cleanly.
 *
 * `in_progress`: stamps `ready_at` + `list_name` only. The card
 * becomes dispatchable; the picker spawns an agent on the next tick
 * which auto-flips `dispatch != null` (rule 3 → In Progress). Writing
 * `dispatch` directly here would conflate the cascade with the
 * picker's pickup responsibility — the gotcha in DX-630's body.
 */
function triggerWritesForDest(
  type: ListType,
  listName: string,
  now: string,
): TriggerWrite {
  switch (type) {
    case "review":
      return {
        ready_at: null,
        archived_at: null,
        completed_at: null,
        cancelled_at: null,
        list_name: listName,
      };
    case "ready":
      return {
        ready_at: now,
        archived_at: null,
        completed_at: null,
        cancelled_at: null,
        list_name: listName,
      };
    case "archived":
      return {
        archived_at: now,
        ready_at: null,
        completed_at: null,
        cancelled_at: null,
        list_name: listName,
      };
    case "in_progress":
      return { ready_at: now, list_name: listName };
    case "completed":
      return {
        completed_at: now,
        cancelled_at: null,
        list_name: listName,
      };
    case "cancelled":
      return { cancelled_at: now, list_name: listName };
  }
}
