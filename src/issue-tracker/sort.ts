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
 * | Status                          | Sort                                                             |
 * |---------------------------------|------------------------------------------------------------------|
 * | Review, ToDo, Blocked           | tier (not waiting/blocked first) → ICE total DESC (untriaged = +Inf) → priority DESC → updated_at ASC (FIFO) |
 * | In Progress, Done, Cancelled    | updated_at DESC                                                   |
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
  "Done",
  "Cancelled",
]);

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

    // Both untriaged → both score +Infinity → iceDelta is NaN. Fall
    // through to priority + FIFO tiebreaks. A finite delta or
    // ±Infinity (one untriaged, one triaged) is a real ordering signal
    // and must be returned — only NaN is the "no signal" case.
    const iceDelta = effectiveIce(b.issue) - effectiveIce(a.issue);
    if (!Number.isNaN(iceDelta) && iceDelta !== 0) return iceDelta;

    const priorityDelta = b.issue.priority - a.issue.priority;
    if (priorityDelta !== 0) return priorityDelta;

    // FIFO: older mtime first.
    if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs - b.updatedAtMs;
    // Final stable tiebreak so two rows with identical mtime resolve
    // deterministically across runs.
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
