/**
 * DX-629 — drag-reorder priority decimal computation.
 *
 * Replaces the deleted `cardPosition.ts` (Phase 2 of DX-626 dropped the
 * `position` field entirely). The board sorts by `priority DESC, id ASC`
 * server-side; this helper picks the priority value the SPA writes when
 * the operator drops a card into the gap between two neighbors.
 *
 * Slot wiring (matches `useCardDrag.bindSlot`):
 *
 *  - `before` — the card RENDERED ABOVE the slot (higher priority in DESC).
 *  - `after`  — the card RENDERED BELOW the slot (lower priority in DESC).
 *  - Either side `null` → drop landed at the top / bottom of the column.
 *
 * The five branches below all preserve integer tier when a same-tier
 * midpoint exists; only the both-non-null cross-tier branch leaves the
 * dropped card in `before`'s tier deliberately (the operator dropping
 * across a tier boundary signals "I want this in the higher tier
 * still"). All formulas are spec'd verbatim from the DX-629 description.
 *
 * Edge cases:
 *
 *  - `before`/`after` carrying integer-boundary values (e.g. exactly
 *    `3.0`) can produce a result that collides with `before`. That is
 *    rare in practice (the rest of the system rounds to 2-decimal tier
 *    midpoints) and the next reorder re-derives a fresh decimal; no
 *    defensive jitter here.
 *  - Server clamps the post-PATCH value to `[PRIORITY_MIN, PRIORITY_MAX]`
 *    (`src/issue-tracker/yaml.ts`), so a freshly-computed value just
 *    outside the clamp range silently snaps inside. The helper does
 *    not clamp itself — that responsibility lives at the trust
 *    boundary (the server validator).
 */

// Mid-tier "high" default (`priorityTier(3.5) === "high"`, the bucket
// midpoint of `PRIORITY_TIERS[3]` in `src/issue-tracker/priority-tier.ts`).
// A future widening of `PRIORITY_MIN` / `PRIORITY_MAX` in `yaml.ts`
// should re-check this constant against the new tier table.
const EMPTY_COLUMN_DEFAULT = 3.5;

function decimalPart(n: number): number {
  return n - Math.floor(n);
}

/**
 * Compute the priority value for a card dropped into the slot between
 * `before` (rendered above, higher priority) and `after` (rendered
 * below, lower priority). Either neighbor may be `null` when the slot
 * sits at the column's edge.
 */
export function nextPriority(
  before: number | null,
  after: number | null,
): number {
  // Both null → empty-column drop. The mid-tier default (3.5 → "high")
  // is the operator-facing safe pick; the next reorder rewrites it.
  if (before === null && after === null) return EMPTY_COLUMN_DEFAULT;

  // `before` null, `after` non-null → drop at the top of a non-empty
  // column. Halfway between after's tier-floor and after.
  if (before === null && after !== null) {
    return Math.floor(after) + decimalPart(after) / 2;
  }

  // `before` non-null, `after` null → drop at the bottom of a non-empty
  // column. Halfway between before and before's tier-ceiling.
  if (before !== null && after === null) {
    return Math.floor(before) + (decimalPart(before) + 1) / 2;
  }

  // Both non-null — same-tier vs cross-tier midpoint.
  if (Math.floor(before!) === Math.floor(after!)) {
    return (before! + after!) / 2;
  }
  // Cross-tier: place at midpoint between `before` and `floor(before)`
  // so the dropped card stays in `before`'s integer tier.
  // Example (DX-629 spec): before=4.5, after=3.5 → (4.5 + 4) / 2 = 4.25.
  return (before! + Math.floor(before!)) / 2;
}
