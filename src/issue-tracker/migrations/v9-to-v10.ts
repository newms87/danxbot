import { MigrationRegistryError } from "./registry.js";

/**
 * v9 → v10 forward migration (DX-592 / parent epic DX-591).
 *
 * Pure function: input v9 shape, output v10 shape. NEVER mutates the
 * input — every nested object the migration touches is cloned. The
 * caller (the registry or the boot sweep) passes the raw parsed YAML
 * object; this function returns the next-version-up object.
 *
 * Contract: input MUST be a plain object. Non-object input throws a
 * `MigrationRegistryError` — programming error at the call site,
 * never a silently-pass-through pathway. The registry's own
 * `migrateForward` gates this at the boundary, but the function is
 * exported, so the type check sits here too as defense-in-depth for
 * any future direct caller.
 *
 * v10 delta over v9:
 *  - Adds five required-nullable fields on `Issue`: `archived_at`,
 *    `ready_at`, `completed_at`, `cancelled_at`, `list_name`. Each
 *    defaults to `null` for cards migrated from v9 — the boot sweep
 *    runs ahead of any reader so the defaults are observable; the
 *    dispatch/picker code that consumes the timestamps (DX-575 phase
 *    cards, downstream of this epic) interprets `null` as "value not
 *    yet recorded for this card's lifetime".
 *  - Renames `blocked.timestamp` → `blocked.at` (parent epic's
 *    single-canonical-shape invariant — every parking timestamp on the
 *    schema uses `at` as the suffix once v10 lands).
 *  - Bumps `schema_version` to `10`.
 *
 * Idempotent for the new v10 fields: if the input already carries a
 * non-null `ready_at` (e.g. a partially-migrated record), the function
 * preserves it rather than overwriting with `null`. Same idempotence
 * for the `blocked.at` field — if the input already carries `.at` the
 * function passes it through verbatim. This guards a defensive caller
 * who hands a partial shape; production callers always hand a clean v9.
 */
export function migrateV9ToV10(prev: unknown): unknown {
  if (typeof prev !== "object" || prev === null || Array.isArray(prev)) {
    throw new MigrationRegistryError(
      `migrateV9ToV10: input must be a plain object (got ${prev === null ? "null" : Array.isArray(prev) ? "array" : typeof prev})`,
    );
  }
  const v = prev as Record<string, unknown>;

  let nextBlocked: unknown = v.blocked;
  if (
    v.blocked !== null &&
    v.blocked !== undefined &&
    typeof v.blocked === "object" &&
    !Array.isArray(v.blocked)
  ) {
    const b = v.blocked as Record<string, unknown>;
    // If the input already carries `.at`, pass it through. Otherwise
    // rename `.timestamp` → `.at` (the v9 field name).
    const at = "at" in b ? b.at : b.timestamp;
    const cloned: Record<string, unknown> = { ...b, at };
    delete cloned.timestamp;
    nextBlocked = cloned;
  }

  return {
    ...v,
    archived_at: pickExisting(v, "archived_at"),
    ready_at: pickExisting(v, "ready_at"),
    completed_at: pickExisting(v, "completed_at"),
    cancelled_at: pickExisting(v, "cancelled_at"),
    list_name: pickExisting(v, "list_name"),
    blocked: nextBlocked,
    schema_version: 10,
  };
}

function pickExisting(v: Record<string, unknown>, key: string): unknown {
  if (key in v) return v[key];
  return null;
}
