/**
 * Single canonical sort for `Issue` lists. Both the poller's dispatch
 * order (`listDispatchableYamls`) and the dashboard's per-status board
 * column ordering call `sortIssuesForStatus`; the SPA renders the
 * resulting order verbatim and never re-sorts. ISS-210 introduced the
 * unified sort to replace the former two-policy split (work-ready
 * untriaged → ICE → FIFO in the poller; updated_at DESC everywhere
 * else).
 *
 * ## Per-status order
 *
 * | Status                                 | Sort                                                             |
 * |----------------------------------------|------------------------------------------------------------------|
 * | Review, ToDo, Blocked                  | tier (not waiting/blocked first) → position ASC (nulls last) → epic phase-order (same parent Epic, children[] index ASC) → priority DESC → ICE total DESC (untriaged = +Inf) → id numeric ASC (FIFO by creation) |
 * | In Progress, Backlog, Done, Cancelled  | updated_at DESC                                                  |
 *
 * DX-582 added `Backlog` (computed-card-state derivation rule 6 —
 * `archived_at` set without a terminal timestamp). Cards in Backlog
 * are shelved / parked, so recency-bucket ordering applies — freshly
 * shelved cards top the column, oldest sink. Operators looking at a
 * parking-lot column most often want to see what was just put there.
 *
 * Priority becomes the primary sort key for Review/ToDo/Blocked in
 * DX-521 (pre-DX-521 ICE was primary and priority was the
 * tiebreaker). Rationale: the operator's priority knob is the human
 * intent signal; the triage agent's ICE score is the machine
 * heuristic. The operator's signal SHOULD outrank the machine's when
 * both are present, with ICE breaking ties among priority-equal
 * cards.
 *
 * The "tier" check considers BOTH the card's own `waiting_on` /
 * `blocked` fields AND any ancestor's. Ancestor walking re-uses the
 * shared `parentBlocksOrWaits` helper so the poller's dispatch filter
 * and the dashboard's sort tier never drift. The dashboard surfaces
 * waiting / blocked cards in the bottom tier (visually demoted but
 * visible); the poller already filters them out before sorting, so the
 * tier acts as a no-op there.
 *
 * Untriaged cards (`triage.expires_at === ""`) sort above every triaged
 * card via an effective ICE total of `+Infinity` — flushed first so an
 * operator gets a priority signal ASAP. Once the triage agent stamps an
 * ICE total, the card joins the triaged tier at its scored position.
 *
 * `updated_at` ASC on the priority bucket implements FIFO mtime — older
 * cards rise. The recency bucket (In Progress / Done / Cancelled) flips
 * to DESC so the most recently active card surfaces first.
 */

import type { Issue, IssueStatus } from "./interface.js";
import { isEffectivelyWaitingOn } from "../issue/effective-waiting-on.js";

/**
 * Subset of `Issue` fields the sort consults. The dashboard reader
 * works on raw `Issue` objects (it builds list items AFTER sorting), so
 * `Issue` is the natural input. The `updatedAtMs` accessor is
 * parameterized because the poller uses file mtime (from
 * `walkOpenIssues`) and the reader uses the same `mtimeMs` it already
 * fetched — neither stamps `updated_at` on the `Issue` directly.
 */
export interface SortInput<T> {
  issue: Issue;
  payload: T;
  updatedAtMs: number;
}

/**
 * Walk the parent chain. Return `true` when ANY ancestor is
 * **effectively** waiting (raw `waiting_on` set AND at least one dep is
 * non-terminal / missing) OR has a non-null `blocked` record. Cycle-safe
 * via a `seen` set; missing ancestors (parent_id points outside the
 * supplied map) are treated as non-blocking — closed cards live outside
 * the poller's open-only `byId`, and consumers that need to verify
 * closed-ancestor deps pre-populate the map with the relevant closed
 * rows.
 *
 * Effective-waiting (not raw) is the right gate: an ancestor whose
 * own deps are all terminal no longer blocks descendants even though
 * its YAML still carries the audit-trail `waiting_on` record.
 *
 * Public so `local-issues.ts` re-uses this single walker for its
 * dispatch filter; before ISS-210 the poller carried its own copy
 * (`ancestorBlocks`), which would silently diverge from any future
 * dashboard tier change.
 */
export function ancestorWaitingOrBlocked(
  issue: Issue,
  byId: Map<string, Issue>,
): boolean {
  const seen = new Set<string>();
  let parentId = issue.parent_id;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false;
    if (isEffectivelyWaitingOn(parent, byId)) return true;
    if (parent.blocked !== null) return true;
    parentId = parent.parent_id;
  }
  return false;
}

/** Combined check: card's own effective-waiting/blocked OR any ancestor's. */
export function isWaitingOrBlocked(
  issue: Issue,
  byId: Map<string, Issue>,
): boolean {
  if (isEffectivelyWaitingOn(issue, byId)) return true;
  if (issue.blocked !== null) return true;
  return ancestorWaitingOrBlocked(issue, byId);
}

const PRIORITY_BUCKET: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "Review",
  "ToDo",
  "Blocked",
]);

const RECENCY_BUCKET: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "In Progress",
  "Backlog",
  "Done",
  "Cancelled",
]);

/**
 * Parse the numeric tail from an `<PREFIX>-N` id (e.g. `DX-264` → 264).
 * Returns `null` for malformed input — callers fall back to a
 * deterministic string compare. IDs are allocated monotonically so
 * lower N = older card, which the FIFO tier exploits.
 */
function parseIdNumeric(id: string): number | null {
  const m = /-(\d+)$/.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Untriaged cards score as `+Infinity` so they top every triaged card. */
function effectiveIce(issue: Issue): number {
  if (issue.triage.expires_at === "") return Number.POSITIVE_INFINITY;
  return issue.triage.ice.total;
}

/**
 * Sort a slice of `SortInput<T>` rows for the given status, returning a
 * NEW array of payloads in the canonical order. Pure — never mutates
 * the input.
 *
 * `byId` must contain every issue the rows reference via `parent_id` so
 * the ancestor walk can resolve parents. Callers that already build a
 * full id-map (poller, dashboard reader) pass the same map they use for
 * `children[]` resolution.
 */
export function sortInputsForStatus<T>(
  rows: SortInput<T>[],
  status: IssueStatus,
  byId: Map<string, Issue>,
): T[] {
  const out = [...rows];
  if (RECENCY_BUCKET.has(status)) {
    out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return out.map((r) => r.payload);
  }
  if (!PRIORITY_BUCKET.has(status)) {
    // Defensive: an unknown status falls back to FIFO so the SPA still
    // gets a deterministic order rather than insertion order. Never
    // expected — every member of `IssueStatus` belongs to one bucket —
    // but cheaper than throwing on a future enum addition.
    out.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    return out.map((r) => r.payload);
  }

  out.sort((a, b) => {
    const aBlocked = isWaitingOrBlocked(a.issue, byId);
    const bBlocked = isWaitingOrBlocked(b.issue, byId);
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;

    // Position tier (DX-264) — operator manual ordering wins over the
    // triage agent's ICE tier inside the priority bucket. `position`
    // ASC, NULLs last: a card with a finite numeric position sorts
    // ahead of every `null`-positioned sibling; among non-null
    // positions, lower number first. Among `null`-position cards the
    // existing ICE / priority / FIFO chain decides. Recency-bucket
    // statuses (In Progress / Done / Cancelled) take the early DESC
    // return above and never see this branch — manual position never
    // overrides updated_at on the activity columns.
    const aPos = a.issue.position;
    const bPos = b.issue.position;
    if (aPos !== null && bPos === null) return -1;
    if (aPos === null && bPos !== null) return 1;
    if (aPos !== null && bPos !== null && aPos !== bPos) return aPos - bPos;

    // Epic phase-order tier — when two cards share the same `parent_id`
    // and the parent is `type: "Epic"`, dispatch them in the order they
    // appear in the epic's `children[]` array. Phases of an epic are
    // authored as an ordered sequence; the default expectation is that
    // Phase 1 ships before Phase 2 even when neither phase stamped
    // `waiting_on` on the next. Operator `position` (above) still wins,
    // so a manual reorder can override declared phase order.
    if (
      a.issue.parent_id !== null &&
      a.issue.parent_id === b.issue.parent_id
    ) {
      const parent = byId.get(a.issue.parent_id);
      if (parent && parent.type === "Epic") {
        const aIdx = parent.children.indexOf(a.issue.id);
        const bIdx = parent.children.indexOf(b.issue.id);
        // Both present → lower index first. One missing → present wins
        // (defensive; an epic with a phase missing from children[] is
        // already a workflow violation but we still order deterministically).
        if (aIdx !== -1 && bIdx === -1) return -1;
        if (aIdx === -1 && bIdx !== -1) return 1;
        if (aIdx !== -1 && bIdx !== -1 && aIdx !== bIdx) return aIdx - bIdx;
      }
    }

    // Priority is the PRIMARY sort key for Review/ToDo/Blocked buckets
    // (DX-521). The operator's priority knob directly drives dispatch
    // order; ICE total acts as the tiebreaker among priority-equal
    // cards. Pre-DX-521 the order was reversed (ICE primary, priority
    // tiebreaker) — the swap keeps the operator's human-intent signal
    // ranked above the triage agent's machine-derived ICE score.
    const priorityDelta = b.issue.priority - a.issue.priority;
    if (priorityDelta !== 0) return priorityDelta;

    // Both untriaged → both score +Infinity → iceDelta is NaN. Fall
    // through to FIFO. A finite delta or ±Infinity (one untriaged,
    // one triaged) is a real ordering signal and must be returned —
    // only NaN is the "no signal" case.
    const iceDelta = effectiveIce(b.issue) - effectiveIce(a.issue);
    if (!Number.isNaN(iceDelta) && iceDelta !== 0) return iceDelta;

    // FIFO by creation order — parse numeric N from `<PREFIX>-N` and
    // sort ASC. IDs are allocated monotonically so the lower number is
    // the older card. Replaces the prior `updated_at ASC` mtime tiebreak
    // (operator-edit churn shouldn't shuffle the queue). Falls back to
    // `localeCompare` when either id is malformed so a typo card still
    // resolves deterministically.
    const aN = parseIdNumeric(a.issue.id);
    const bN = parseIdNumeric(b.issue.id);
    if (aN !== null && bN !== null && aN !== bN) return aN - bN;
    return a.issue.id.localeCompare(b.issue.id);
  });
  return out.map((r) => r.payload);
}

/**
 * Convenience overload for callers who don't need to thread a separate
 * payload through. Returns the sorted `Issue[]`.
 */
export function sortIssuesForStatus(
  issues: Issue[],
  status: IssueStatus,
  byId: Map<string, Issue>,
  updatedAt: (issue: Issue) => number,
): Issue[] {
  const rows: SortInput<Issue>[] = issues.map((issue) => ({
    issue,
    payload: issue,
    updatedAtMs: updatedAt(issue),
  }));
  return sortInputsForStatus(rows, status, byId);
}
