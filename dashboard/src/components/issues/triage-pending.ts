/**
 * DX-518 — Per-issue Triage in-flight tracking helpers.
 *
 * `IssuesPage.vue` lifts a `Map<issueId, dispatchedAtMs>` of pending
 * triage dispatches. Set on the dialog's `dispatched` event; cleared
 * when a fresh `triage.history[]` entry lands via the SSE
 * `issue:updated` topic.
 *
 * The clear predicate is load-bearing: `triage.history[]` is APPEND-
 * ONLY (oldest dropped on overflow at cap 10), so the NEWEST entry is
 * `history[history.length - 1]`, NOT `history[0]`. Reading the wrong
 * end leaves the badge stuck for any card with prior triage history
 * (the common case for Review / Blocked cards).
 *
 * These helpers are pure (immutable Map replacement, no side effects)
 * so the unit test can pin both the success and the no-op branches
 * without mounting a Vue tree.
 */

import type { Issue } from "../../types";

/** Mark a dispatch as pending against the given issue id. */
export function markPending(
  current: ReadonlyMap<string, number>,
  issueId: string,
  atMs: number,
): Map<string, number> {
  const next = new Map(current);
  next.set(issueId, atMs);
  return next;
}

/**
 * Clear the pending entry for `updated.id` IFF the latest triage
 * history entry's timestamp is `>= pendingAt`. Returns the same Map
 * reference when no change applies (Vue reactivity tolerates the
 * stable reference; a no-op replacement would still re-render).
 *
 * Defense: parses the newest entry's timestamp; an unparseable string
 * leaves the entry alone (next valid SSE clears it correctly). Cards
 * with empty `history[]` cannot satisfy the predicate, so the entry
 * waits for the first append.
 */
export function clearIfTriaged(
  current: ReadonlyMap<string, number>,
  updated: Pick<Issue, "id" | "triage">,
): Map<string, number> | ReadonlyMap<string, number> {
  const pendingAt = current.get(updated.id);
  if (pendingAt === undefined) return current;
  const history = updated.triage?.history;
  if (!history || history.length === 0) return current;
  const newest = history[history.length - 1]?.timestamp;
  if (!newest) return current;
  const parsed = Date.parse(newest);
  if (!Number.isFinite(parsed)) return current;
  if (parsed < pendingAt) return current;
  const next = new Map(current);
  next.delete(updated.id);
  return next;
}
