import { MigrationRegistryError } from "./registry.js";

/**
 * v10 → v11 forward migration (DX-628, priority cascade Phase 2).
 *
 * Pure function: input v10 shape, output v11 shape. NEVER mutates the
 * input — every nested object the migration touches is cloned.
 *
 * v11 delta over v10:
 *  - Drops the `position` field. After DX-627 (priority canon, Phase 1)
 *    `position` no longer participates in dispatch ordering; Phase 3
 *    moves drag-reorder onto `priority`'s decimal portion. This phase
 *    folds any non-integer `position` decimal that was carrying ordering
 *    intent into `priority`'s decimal so the migration preserves the
 *    operator's visible row order across the schema bump, then strips
 *    the field entirely.
 *  - Bumps `schema_version` to `11`.
 *
 * Fold rule (when `position` is a finite number with a non-zero decimal
 * portion):
 *
 *   new_priority = floor(priority) + (position - floor(position))
 *
 * Tier (the floor) is preserved; the decimal becomes the within-tier
 * ordering. The fold is idempotent: a card whose priority already
 * carried an in-tier decimal is overwritten by the position decimal,
 * because `position` was the prior canonical ordering knob.
 *
 * Skip rule (preserve priority verbatim, just delete the field):
 *  - `position` missing
 *  - `position` is `null`
 *  - `position` is a finite integer (`pos - Math.floor(pos) === 0`)
 *  - `position` is non-finite / non-number (defensive — shouldn't reach
 *    the migration since v10's reader rejects these, but malformed-on-
 *    disk files round-trip the migration as no-op rather than throw).
 *
 * Idempotent at v11: this migration is never called on a v11 input
 * (the registry's loop terminates the moment `schema_version` hits
 * `KNOWN_SCHEMA_MAX`). Defense-in-depth: if a caller hands a v11 input
 * the function still throws via the registry's "did not advance the
 * version" guard.
 */
export function migrateV10ToV11(prev: unknown): unknown {
  if (typeof prev !== "object" || prev === null || Array.isArray(prev)) {
    throw new MigrationRegistryError(
      `migrateV10ToV11: input must be a plain object (got ${prev === null ? "null" : Array.isArray(prev) ? "array" : typeof prev})`,
    );
  }
  const v = prev as Record<string, unknown>;

  const pos = v.position;
  const priorityRaw = v.priority;
  const priority = typeof priorityRaw === "number" && Number.isFinite(priorityRaw)
    ? priorityRaw
    : null;

  let nextPriority: unknown = priorityRaw;
  if (
    priority !== null &&
    typeof pos === "number" &&
    Number.isFinite(pos)
  ) {
    const decimal = pos - Math.floor(pos);
    if (decimal !== 0) {
      nextPriority = Math.floor(priority) + decimal;
    }
  }

  const next: Record<string, unknown> = {
    ...v,
    priority: nextPriority,
    schema_version: 11,
  };
  delete next.position;
  return next;
}
