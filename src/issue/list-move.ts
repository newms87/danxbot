/**
 * DX-586 (Phase 6 of DX-575 — Computed card state) — list-driven move
 * semantics for the dashboard PATCH path.
 *
 * Takes an Issue + a target list (resolved to a `ListType` by the caller)
 * and applies the ladder semantics described in the epic body:
 *
 *  - Lateral (`destIdx === currentIdx`): only `list_name` changes.
 *  - Rightward (`destIdx > currentIdx`): stamp every missing lifecycle
 *    timestamp for types `currentIdx+1..destIdx`. Gate-field types
 *    (`blocked`, `in_progress`) only stamp when they are the DEST — a
 *    pass-through never stamps `blocked.at` (which needs a reason) or
 *    auto-injects a `dispatch` record.
 *  - Leftward (`destIdx < currentIdx`): clear every trigger above `destIdx`,
 *    then stamp the dest's representative if missing.
 *
 * Two gate cases the simple ladder doesn't cover need explicit handling
 * from the caller:
 *
 *  - **INTO blocked** — requires `blocked: {reason}` in the patch body.
 *    Stamps `blocked: {at, reason}` and skips the rest of the ladder
 *    sweep (no lifecycle timestamps stamped on the way).
 *  - **INTO in_progress** — auto-stamps `dispatch` with the operator's
 *    username encoded into the v10-compatible record so the card derives
 *    `In Progress` via `deriveStatus` rule 4. The literal `kind: "human"`
 *    enum value from the AC body is reinterpreted to fit the v10 schema
 *    (which only knows `work | triage | recovery`) — the operator
 *    identity lives in `host` as `dashboard:<username>` for now; a
 *    future schema bump can promote it to a proper `assignee` field.
 *
 * The helper is a pure function over an `Issue`. The caller (`issue-write.ts`)
 * owns mutex acquisition, file I/O, and the round-trip `parseIssue` check
 * that catches any invariant violation the move would introduce.
 */

import type { Issue, IssueDispatch, IssueStatus } from "../issue-tracker/interface.js";
import type { ListType } from "../lists-types.js";
import { LIST_TYPES } from "../lists-types.js";
import { deriveStatus } from "./derive-status.js";
import { deriveListTypeFromSemanticStatus } from "./list-resolve.js";

/**
 * Map a `ListType` back to the `IssueStatus` literal stored in the YAML's
 * raw `status` field. The PATCH path writes BOTH the derived-triggers
 * (timestamps + gates) AND the raw status so the YAML round-trips byte-
 * stable AND so `deriveStatus` rule 4's `raw !== Done/Cancelled` guard
 * does not block a leftward-out-of-terminal move (Done → In Progress
 * etc.). The agent path is forbidden from writing raw `status` (see
 * `CLAUDE.md` Forbidden Patterns); the server lifecycle write path is
 * the only legitimate writer.
 */
function rawStatusForListType(type: ListType): IssueStatus {
  switch (type) {
    case "archived":
      return "Backlog";
    case "review":
      return "Review";
    case "ready":
      return "ToDo";
    case "blocked":
      return "Blocked";
    case "in_progress":
      return "In Progress";
    case "completed":
      return "Done";
    case "cancelled":
      return "Cancelled";
  }
}

/**
 * Ladder ordering — left → right. Index = ladder position. Matches the
 * order in the epic body + `LIST_TYPE_LADDER` in `dashboard/src/types.ts`.
 * Owner-side defense: assert at module load that this array contains
 * exactly every `ListType` value (no drift if a future enum addition
 * forgets to bump this list).
 */
export const LADDER_ORDER: readonly ListType[] = [
  "archived",
  "review",
  "ready",
  "blocked",
  "in_progress",
  "completed",
  "cancelled",
] as const;

// Sanity: every ListType participates in the ladder exactly once.
{
  const set = new Set(LADDER_ORDER);
  if (set.size !== LADDER_ORDER.length) {
    throw new Error("LADDER_ORDER contains a duplicate ListType");
  }
  for (const t of LIST_TYPES) {
    if (!set.has(t)) {
      throw new Error(`LADDER_ORDER missing ListType "${t}" — bump after enum addition`);
    }
  }
}

export function ladderIndexForType(type: ListType): number {
  const idx = LADDER_ORDER.indexOf(type);
  if (idx < 0) {
    throw new Error(`Unknown ListType "${type}" — not in LADDER_ORDER`);
  }
  return idx;
}

/**
 * Compute the issue's current ladder index from its derived status.
 * `deriveStatus` is the only authoritative source — never read
 * `list_name` to derive position (see DX-584 read-side guard at
 * `src/__tests__/no-list-name-reads.test.ts`).
 *
 * **Always operates on PRE-mutation state.** `applyListMove` invokes
 * this against the `current` argument once at the top of the function
 * to anchor the lateral / rightward / leftward branch decision on
 * where the card actually IS before any trigger writes land. A future
 * refactor that passes `next` (post-mutation) here would invert
 * leftward/rightward sweeps and silently lose timestamp triggers —
 * the source-mutation-guard test pins this.
 */
export function currentLadderIndex(issue: Issue): number {
  const status = deriveStatus(issue);
  const type = deriveListTypeFromSemanticStatus(status);
  return ladderIndexForType(type);
}

/**
 * Optional `blocked` patch from the request body.
 *
 *  - `undefined` — body did not mention `blocked`. Default ladder rules
 *    apply (rightward dest=blocked rejects; leftward across blocked
 *    auto-clears).
 *  - `null` — explicit unblock confirmation (OUT-of-blocked dialog
 *    submit). Always cleared regardless of dest.
 *  - `{reason}` — INTO-blocked dialog submit. Stamped with
 *    `{at: nowIso, reason}` ONLY when dest type is `blocked`. Any other
 *    dest = the helper throws `ListMoveError` so the route returns 400.
 */
export type BlockedPatchInput =
  | { reason: string }
  | null
  | undefined;

export interface ListMoveContext {
  current: Issue;
  destListType: ListType;
  destListName: string;
  blockedPatch: BlockedPatchInput;
  authUsername: string;
  nowIso: string;
  uuid: () => string;
}

export class ListMoveError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ListMoveError";
  }
}

/**
 * Apply the move. Returns a NEW Issue value — the caller's source object
 * is not mutated (every nested object is shallow-cloned on touch).
 *
 * Always sets `list_name = destListName`. The ladder logic determines
 * which timestamps / gate fields move.
 */
export function applyListMove(ctx: ListMoveContext): { next: Issue } {
  const { current, destListType, destListName, blockedPatch, authUsername, nowIso, uuid } = ctx;

  // Shallow clone — every field the helper might write is replaced here so
  // callers can compare `current` vs `next` post-move without aliasing.
  const next: Issue = {
    ...current,
    blocked: current.blocked ? { ...current.blocked } : null,
    dispatch: current.dispatch ? { ...current.dispatch } : null,
  };
  next.list_name = destListName;
  // Realign the raw `status` field with the destination type so the
  // YAML round-trips byte-stable AND `deriveStatus` rule 4's
  // `raw !== Done/Cancelled` guard does not silently block a leftward
  // move out of a terminal state (Done → In Progress, Cancelled → ToDo).
  next.status = rawStatusForListType(destListType);

  // Cross-shape input validation BEFORE the ladder decision so a
  // bad payload always 400s deterministically regardless of the
  // card's current position. `blockedPatch === {reason}` paired with
  // a non-blocked dest = client bug (the reason is meaningless on
  // a non-blocked dest); reject before any state mutation.
  if (
    blockedPatch &&
    "reason" in blockedPatch &&
    destListType !== "blocked"
  ) {
    throw new ListMoveError(
      400,
      `blocked.reason may only accompany a move into a "blocked"-type list`,
    );
  }

  // `currentLadderIndex` reads PRE-mutation state — `deriveStatus(current)`
  // projects from the on-disk triggers, then `deriveListTypeFromSemanticStatus`
  // maps to a ListType. Computing this here once + before any mutation so
  // the lateral / rightward / leftward branch decision is anchored on the
  // card's actual current position.
  const destIdx = ladderIndexForType(destListType);
  const currentIdx = currentLadderIndex(current);

  // Explicit `blocked: null` from the OUT-of-blocked dialog always wins:
  // operator explicitly cleared the block. Continue with normal ladder
  // semantics for the dest.
  if (blockedPatch === null) {
    next.blocked = null;
  }

  // Lateral move within the SAME ladder index (e.g. "Blocked" → "Stuck",
  // both blocked-type) — short-circuit BEFORE the cross-tier INTO-blocked
  // branch so a rename between two blocked-typed lists does NOT 400 with
  // "needs reason" (the operator is just moving between buckets, the
  // existing `blocked` record stays put). Same logic for any other
  // within-type lateral rename.
  if (destIdx === currentIdx) {
    return { next };
  }

  if (destListType === "blocked") {
    // INTO blocked (cross-tier): require a reason. The v10 schema's
    // `blocked` shape is `{at, reason}` — both fields non-empty.
    if (!blockedPatch || blockedPatch === null) {
      throw new ListMoveError(
        400,
        `Moving into a "blocked"-type list requires a non-empty "blocked.reason" in the patch body`,
      );
    }
    if (typeof blockedPatch.reason !== "string" || blockedPatch.reason.length === 0) {
      throw new ListMoveError(
        400,
        `blocked.reason must be a non-empty string`,
      );
    }
    next.blocked = { at: nowIso, reason: blockedPatch.reason };
    // Blocked is a gate field, not a lifecycle marker — do NOT also stamp
    // ready_at / completed_at / etc. on the way. The dispatch field is
    // cleared because rule 3 (blocked.at) beats rule 4 (dispatch), but a
    // lingering dispatch record would still consume the dispatch slot.
    next.dispatch = null;
    return { next };
  }

  // Dest is NOT blocked — auto-clear any prior block. The OUT-of-blocked
  // dialog routes here on submit; a card with a stale `blocked` record
  // (e.g. operator dragged from "Blocked" to "In Progress" via the board
  // without the confirm dialog firing) gets the same auto-clear. The
  // blockedPatch={reason} + non-blocked-dest combo was already rejected
  // at the top of the function.
  next.blocked = null;

  if (destIdx > currentIdx) {
    // Rightward: stamp missing lifecycle timestamps for types in
    // (currentIdx, destIdx]. Pass-through gates (blocked, in_progress)
    // only stamp when they ARE the dest.
    for (let i = currentIdx + 1; i <= destIdx; i++) {
      stampTriggerIfMissing(next, LADDER_ORDER[i], i === destIdx, ctx);
    }
    return { next };
  }

  // Leftward: clear every trigger whose ladder position > destIdx,
  // then stamp the dest's representative so the card derives to the
  // intended type. Stamping happens BEFORE clearing so a dest-type
  // representative the card hasn't reached yet (e.g. archive from
  // In Progress with archived_at = null) gets a fresh timestamp.
  for (let i = destIdx + 1; i < LADDER_ORDER.length; i++) {
    clearTrigger(next, LADDER_ORDER[i]);
  }
  stampTriggerIfMissing(next, destListType, true, ctx);
  return { next };
}

/**
 * Stamp the representative trigger for `type` IF it is currently null.
 * `isDest` gates the two gate-field types (blocked, in_progress) — they
 * only stamp on the destination, never on a pass-through.
 *
 * `blocked` is handled exclusively by the caller's INTO-blocked branch
 * (this function NEVER stamps blocked even when isDest=true; the
 * INTO-blocked branch returns before this function is reached for that
 * case).
 */
function stampTriggerIfMissing(
  issue: Issue,
  type: ListType,
  isDest: boolean,
  ctx: ListMoveContext,
): void {
  switch (type) {
    case "archived":
      if (!issue.archived_at) issue.archived_at = ctx.nowIso;
      return;
    case "review":
      // No timestamp — Review is the rule-7 fallthrough. The raw `status`
      // field carries it; leftward moves that land on review-type lists
      // need the raw status set to "Review" so the fallthrough hits the
      // right value. Same for rightward: passing through review (idx 1)
      // implies no card was ever review-stamped on the way (uncommon —
      // most cards start at review).
      return;
    case "ready":
      if (!issue.ready_at) issue.ready_at = ctx.nowIso;
      return;
    case "blocked":
      // Pass-through case (e.g. rightward to completed crossing the
      // blocked tier): never stamp `blocked.at` without a reason — the
      // YAML invariant requires both fields populated, and an empty
      // reason is invalid. Dest-blocked is handled in the caller; this
      // branch only fires for pass-throughs and the `isDest` flag is
      // irrelevant here.
      return;
    case "in_progress":
      // INTO in_progress: stamp dispatch with the operator's identity.
      // Pass-through (e.g. review → completed crossing in_progress
      // tier): do NOT stamp — the card was never picked up by an agent
      // or a human, only the derived state advanced.
      if (isDest && !issue.dispatch) {
        issue.dispatch = buildHumanDispatch(ctx);
      }
      return;
    case "completed":
      if (!issue.completed_at) issue.completed_at = ctx.nowIso;
      return;
    case "cancelled":
      if (!issue.cancelled_at) issue.cancelled_at = ctx.nowIso;
      return;
  }
}

/**
 * Clear the representative trigger for `type`. Leftward sweep uses this
 * to unwind every state above the destination.
 */
function clearTrigger(issue: Issue, type: ListType): void {
  switch (type) {
    case "archived":
      issue.archived_at = null;
      return;
    case "review":
      // No-op — review carries no trigger.
      return;
    case "ready":
      issue.ready_at = null;
      return;
    case "blocked":
      issue.blocked = null;
      return;
    case "in_progress":
      issue.dispatch = null;
      return;
    case "completed":
      issue.completed_at = null;
      return;
    case "cancelled":
      issue.cancelled_at = null;
      return;
  }
}

/**
 * Build a v10-compatible `IssueDispatch` record for a human-initiated
 * "move to In Progress" board action.
 *
 * AC body wording: `{kind: "human", assignee: <current-user>, ...}`. The
 * v10 schema's `IssueDispatch.kind` enum is `work | triage | recovery`;
 * widening it would require a schema bump + MCP republish + propagation
 * coordination. To keep Phase 6 scoped to the board UI, the human
 * identity is encoded into the v10-allowed `host` field as
 * `dashboard:<username>`; `kind` stays `work`. A future phase can promote
 * the encoding into a typed `assignee` field with a schema bump.
 *
 * Picker safety: the dispatched record has `pid: 0` and `kind: "work"`,
 * which prevents the orphan-reap pass from interpreting it as a runaway
 * agent process (the reaper requires a real PID + scope unit). The
 * poller's pickup filter skips ToDo cards with `dispatch != null`, so
 * this record cleanly locks the card from agent pickup while the human
 * works on it.
 */
function buildHumanDispatch(ctx: ListMoveContext): IssueDispatch {
  return {
    id: ctx.uuid(),
    pid: 0,
    host: `dashboard:${ctx.authUsername}`,
    kind: "work",
    started_at: ctx.nowIso,
    ttl_seconds: 0,
  };
}
