import { MigrationRegistryError } from "./registry.js";

/**
 * v3 / v4 / v5 / v6 / v7 / v8 → v10 unified forward migration
 * (DX-591 epic bootstrap).
 *
 * Bridges every pre-v9 schema version we ever shipped to canonical v10
 * in one hop. Registered for source versions 3-8 in the registry; each
 * invocation jumps straight to v10 by additively supplying every field
 * the source shape was missing. Skips v9 (which has its own dedicated
 * `migrateV9ToV10` — v9 is in active circulation and may grow
 * version-specific conditional logic before the next bump).
 *
 * Field defaults are applied with `pickExisting`: if the input already
 * carries the field, it passes through verbatim; only truly-missing
 * fields take their default. This means a v6 card and a v3 card both
 * end up at v10 through the same code path; the v6 card just happens
 * to already carry more of the keys.
 *
 * Status-name normalization: `"Needs Help"` (a v3-era Trello list name
 * that got stamped onto the YAML before the schema settled on the six
 * canonical statuses) is rewritten to `"Blocked"` with a synthesized
 * `blocked: {reason, at}` record. Without the synth the
 * status===Blocked ⟺ blocked!=null invariant would fail validation.
 *
 * Blocked-record rename (`blocked.timestamp` → `blocked.at`) applies to
 * every source version where blocked is non-null. Idempotent — a record
 * already carrying `.at` passes through unchanged.
 *
 * Pure function — never mutates `prev`. Returns a fresh object with
 * `schema_version: 10`.
 */
export function migrateLegacyToV10(prev: unknown): unknown {
  if (typeof prev !== "object" || prev === null || Array.isArray(prev)) {
    throw new MigrationRegistryError(
      `migrateLegacyToV10: input must be a plain object (got ${prev === null ? "null" : Array.isArray(prev) ? "array" : typeof prev})`,
    );
  }
  const v = prev as Record<string, unknown>;
  const sourceVersion = v.schema_version;
  if (
    typeof sourceVersion !== "number" ||
    sourceVersion < 3 ||
    sourceVersion > 8
  ) {
    throw new MigrationRegistryError(
      `migrateLegacyToV10: only handles schema_version 3-8 (got ${JSON.stringify(sourceVersion)})`,
    );
  }

  // Normalize retired status name from v3-era Trello list-name leak.
  let nextStatus: unknown = v.status;
  let synthBlocked = false;
  if (v.status === "Needs Help") {
    nextStatus = "Blocked";
    synthBlocked = true;
  }

  let nextBlocked: unknown = v.blocked;
  if (
    v.blocked !== null &&
    v.blocked !== undefined &&
    typeof v.blocked === "object" &&
    !Array.isArray(v.blocked)
  ) {
    const b = v.blocked as Record<string, unknown>;
    const at = "at" in b ? b.at : b.timestamp;
    const cloned: Record<string, unknown> = { ...b, at };
    delete cloned.timestamp;
    nextBlocked = cloned;
  } else if (synthBlocked) {
    nextBlocked = {
      reason:
        "Migrated from retired 'Needs Help' status — review and either clear or specify human action",
      at: new Date().toISOString(),
    };
  }

  return {
    ...v,
    status: nextStatus,
    priority: pickExisting(v, "priority", 3),
    position: pickExisting(v, "position", null),
    history: pickExisting(v, "history", []),
    assigned_agent: pickExisting(v, "assigned_agent", null),
    waiting_on: pickExisting(v, "waiting_on", null),
    requires_human: pickExisting(v, "requires_human", null),
    conflict_on: pickExisting(v, "conflict_on", []),
    effort_level: pickExisting(v, "effort_level", null),
    db_updated_at: pickExisting(v, "db_updated_at", ""),
    archived_at: pickExisting(v, "archived_at", null),
    ready_at: pickExisting(v, "ready_at", null),
    completed_at: pickExisting(v, "completed_at", null),
    cancelled_at: pickExisting(v, "cancelled_at", null),
    list_name: pickExisting(v, "list_name", null),
    blocked: nextBlocked,
    schema_version: 10,
  };
}

function pickExisting(
  v: Record<string, unknown>,
  key: string,
  fallback: unknown,
): unknown {
  if (key in v) return v[key];
  return fallback;
}
