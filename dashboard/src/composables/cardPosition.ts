/**
 * Fractional-indexing helper (DX-264) — compute a new `position` value
 * for an issue card dropped into a column between two neighbors.
 *
 * The backend sort uses `position` ASC inside the priority bucket
 * (Review / ToDo / Blocked). A finite number ranks ahead of every
 * `null`-position sibling; among non-null positions, lower number first.
 * The fractional-indexing midpoint algorithm lets the operator reorder
 * the column with a SINGLE-card PATCH — the rest of the column keeps
 * its existing values:
 *
 *   - Insert at top (no `before`):    position = `after - 1`
 *   - Insert at bottom (no `after`):  position = `before + 1`
 *   - Insert between two neighbors:   position = `(before + after) / 2`
 *   - Empty column (no neighbors):    position = `0`
 *   - Neighbor has `null` position:   treat as "no neighbor" on that side
 *     (the null-positioned card hasn't been manually ordered, so we
 *     skip it when computing the midpoint and fall back to top / bottom
 *     insertion semantics).
 *
 * The float-midpoint approach has finite precision (~53 bits of
 * mantissa). For card columns with <50 cards and rare reorders, this
 * is far beyond what we'll exhaust. A future regression test guards
 * the precision floor; if it ever trips, the fix is a column-wide
 * renumber (out of scope for this skill).
 */

/**
 * Compute the new `position` for a card inserted between `before` and
 * `after`. `null` arguments indicate "no neighbor on that side."
 * Returns a finite number guaranteed strictly between the neighbors
 * (when both are present and ordered) or +/- 1 of the single neighbor.
 *
 * Caller is responsible for ordering — `before.position` MUST be less
 * than `after.position` when both are non-null. We do NOT assert this
 * at runtime because the caller (IssueBoard's drop-slot binding) reads
 * positions in canonical sort order; an out-of-order call indicates a
 * sort-tier bug upstream and should fail loud there, not here.
 */
export function nextPosition(
  before: number | null,
  after: number | null,
): number {
  if (before === null && after === null) return 0;
  if (before === null && after !== null) return after - 1;
  if (before !== null && after === null) return before + 1;
  // Both non-null. TypeScript narrows `before` + `after` to `number` here
  // because the prior branches return.
  return (before! + after!) / 2;
}
