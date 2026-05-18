/**
 * DX-630 (Phase 4 of DX-626 — Priority cascade + epic-move cascade dialog).
 *
 * Pure-function core of the recursive epic-move cascade. Given a parent
 * card being moved to a destination `ListType` + `listName`, computes
 * the per-descendant trigger writes that produce the desired derived
 * status on each child per the 5×5 spec table in DX-626.
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
 * Spec table (FROM rows ↓, TO cols →) — source of truth is DX-626's
 * body. `completed` / `cancelled` rows stay-on-everything: terminal
 * sources never auto-cancel or auto-complete via cascade.
 *
 *   FROM ↓ \ TO →         review/ready/archived | blocked | in_progress       | completed       | cancelled
 *   review/ready/archived | SAME-TYPE-LATERAL   | stay    | FIRST-DISPATCH    | move→completed  | move→cancelled
 *   in_progress           | stay                | stay    | stay              | move→completed  | move→cancelled
 *   blocked               | stay                | stay    | confirm→in_prog   | confirm→done    | confirm→cancel
 *   completed             | stay                | stay    | stay              | stay            | stay
 *   cancelled             | stay                | stay    | stay              | stay            | stay
 *
 * - `SAME-TYPE-LATERAL`: descendant in `parent.list_name` moves to
 *   `destListName`; descendants in another same-type list stay.
 * - `FIRST-DISPATCH`: only the first entry in `dispatchableByPriority`
 *   whose current `ListType` ∈ {review, ready, archived} moves;
 *   helper consumes the list, never recomputes it.
 * - `confirm→X`: blocked descendants moving out require
 *   `unblockConfirmed: true`. When false, helper returns
 *   `requiresUnblockConfirm: true` and skips the blocked descendants'
 *   childWrites (non-blocked descendants still get their writes).
 *
 * Dest=blocked is epic-only: parent stamped, no descendant writes.
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
 */
export interface TriggerWrite {
  completed_at?: string | null;
  cancelled_at?: string | null;
  ready_at?: string | null;
  archived_at?: string | null;
  blocked?: { at: string; reason: string } | null;
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
  unblockConfirmed: boolean;
  /** Required when `destListType === "blocked"`. */
  blockedReason?: string;
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
  requiresUnblockConfirm: boolean;
  blockedReasonRequired: boolean;
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
    unblockConfirmed,
    blockedReason,
    overrides = {},
    dispatchableByPriority = [],
    now = new Date().toISOString(),
  } = input;

  // Gate 1 — blockedReasonRequired. When moving the parent to a
  // blocked-type list, the YAML invariant requires `{at, reason}` both
  // populated. Without a reason, refuse to compute any writes.
  const blockedReasonRequired =
    destListType === "blocked" && !blockedReason;

  if (blockedReasonRequired) {
    return {
      parentWrite: {},
      childWrites: [],
      requiresUnblockConfirm: false,
      blockedReasonRequired: true,
    };
  }

  // Gate 2 — requiresUnblockConfirm. Any descendant currently in the
  // blocked tier AND a non-blocked destination AND no explicit
  // confirmation → flag the dialog to surface the forced-confirm
  // banner. Non-blocked descendants still get their writes; blocked
  // ones are skipped until the operator confirms.
  const anyDescendantBlocked = descendants.some(
    (d) => deriveListTypeForIssue(d) === "blocked",
  );
  const requiresUnblockConfirm =
    destListType !== "blocked" && anyDescendantBlocked && !unblockConfirmed;

  // Parent write — destBlocked is its own branch (the only trigger is
  // the blocked record itself, no lifecycle timestamps). Every other
  // dest stamps the standard trigger pattern for that ListType.
  const parentWrite: TriggerWrite =
    destListType === "blocked"
      ? {
          blocked: { at: now, reason: blockedReason! },
          list_name: destListName,
        }
      : triggerWritesForDest(destListType, destListName, now);

  // Moving the parent to blocked stamps no descendants — the spec is
  // epic-only block (children carry on in their own state).
  if (destListType === "blocked") {
    return {
      parentWrite,
      childWrites: [],
      requiresUnblockConfirm: false,
      blockedReasonRequired: false,
    };
  }

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

    // Default-path skip: blocked descendant + non-blocked dest +
    // !unblockConfirmed → don't emit a write. Explicit override
    // bypasses this (operator decided per-row).
    if (
      !override &&
      childCurrentType === "blocked" &&
      !unblockConfirmed
    ) {
      continue;
    }

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

    // Any move out of the blocked tier clears the gate field so
    // `deriveStatus` rule 3 stops firing on the next read.
    if (childCurrentType === "blocked") {
      write.blocked = null;
    }

    childWrites.push({ id: child.id, write });
  }

  return {
    parentWrite,
    childWrites,
    requiresUnblockConfirm,
    blockedReasonRequired: false,
  };
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

  // Caller short-circuited dest=blocked before invoking this function;
  // reaching here means a caller invariant broke. Fail loud rather than
  // silently returning stay (which would hide a real bug).
  if (destListType === "blocked") {
    throw new Error("cascadeEpicMove: defaultAction reached with destListType=blocked — caller must short-circuit");
  }

  // FROM blocked rows: only TO in_progress / completed / cancelled
  // trigger the confirm-clear path. The unblockConfirmed gate is
  // enforced by the caller's skip branch — by the time we reach the
  // default-action function, the caller has either passed the gate
  // or the descendant was already filtered out.
  if (childCurrentType === "blocked") {
    if (
      destListType === "in_progress" ||
      destListType === "completed" ||
      destListType === "cancelled"
    ) {
      return { kind: "move_same_type" };
    }
    return { kind: "stay" };
  }

  // FROM in_progress rows: only TO completed / cancelled move; the
  // rest stay (passive dest = stay; in_progress dest = stay; blocked
  // dest already returned).
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
 * which auto-flips `dispatch != null` (rule 4 → In Progress). Writing
 * `dispatch` directly here would conflate the cascade with the
 * picker's pickup responsibility — the gotcha in DX-630's body.
 *
 * `blocked`: not reachable from descendants — the dest=blocked
 * short-circuit returns before any descendant write is requested,
 * and override targets to `blocked` would need a reason which is not
 * threaded through to this scope. Fail loud rather than emit a
 * silently-incomplete patch.
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
    case "blocked":
      throw new Error("cascadeEpicMove: triggerWritesForDest called with type=blocked — descendant writes never target blocked");
  }
}
