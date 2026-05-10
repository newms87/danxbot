/**
 * Last-pushed-hash cache for the reconcile step 7 outbound push (DX-216
 * Phase 1 + DX-218 Phase 3).
 *
 * Lives in its own module so BOTH callers — reconcile.ts (which gates
 * `pushTrelloDiff` on a cache miss) AND `retry-queue.ts`'s
 * `attemptPush` (which writes the cache after a successful timer-driven
 * retry) — can read + write a single source of truth without a circular
 * import. `reconcile.ts` → `trello.ts` → `retry-queue.ts` already form
 * an arrow chain; if `retry-queue.ts` had to call back into
 * `reconcile.ts` to update the cache the chain would close. This module
 * is import-cycle-free (only stdlib + no domain deps), so both ends
 * import from here.
 *
 * Semantics: the cache key is `(repoName, id)`. The value is the hash
 * of the canonical YAML the LAST successful push committed to the
 * tracker. reconcile step 7 reads it to decide whether the new YAML's
 * hash differs (push) or matches (skip — tracker is already up to date).
 *
 * Two write paths now keep the cache fresh:
 *   1. `reconcile.ts` step 7 — on synchronous push success, stamps the
 *      cache with the just-pushed hash.
 *   2. `retry-queue.ts` `attemptPush` — when a timer-armed retry
 *      succeeds, stamps the cache so the NEXT reconcile for that card
 *      (which would have re-fired pushTrelloDiff because the cache
 *      missed) sees a hit and skips the call entirely.
 *
 * Without path 2, every reconcile after a transient Trello outage would
 * waste a `getCard` round-trip until the next chokidar event happened
 * to flow through the synchronous push path. `syncIssue`'s remote diff
 * makes the wasted call functionally idempotent (zero-write at the
 * tracker), but the network cost compounds across hundreds of
 * reconciles per dispatch.
 */

const cache = new Map<string, string>();

function key(repoName: string, id: string): string {
  return `${repoName}\x00${id}`;
}

export function getLastPushedHash(
  repoName: string,
  id: string,
): string | undefined {
  return cache.get(key(repoName, id));
}

export function setLastPushedHash(
  repoName: string,
  id: string,
  hash: string,
): void {
  cache.set(key(repoName, id), hash);
}

/** Visible for tests — drain the cache between cases. */
export function _resetPushHashCache(): void {
  cache.clear();
}
