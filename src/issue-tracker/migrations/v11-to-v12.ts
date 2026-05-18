import { MigrationRegistryError } from "./registry.js";

/**
 * v11 → v12 forward migration (DX-657, parent epic DX-656).
 *
 * Pure function: input v11 shape, output v12 shape. NEVER mutates the
 * input — every nested object the migration touches is cloned.
 *
 * v12 delta over v11:
 *  - Cards with `status: "Blocked"` are remapped to the column they
 *    semantically belong to. This is Phase 1 of "Blocked becomes a
 *    dispatch gate, not a status": after this migration `blocked.at`
 *    is the SOLE signal for self-block (Phase 2 retires
 *    `deriveStatus` rule 3 + drops `"Blocked"` from the `IssueStatus`
 *    union). `blocked.at` and `blocked.reason` survive verbatim so
 *    the Phase-2 gate logic still has the data it needs.
 *  - Bumps `schema_version` to `12`.
 *
 * Remap rule for `status: "Blocked"` — pick the projection that
 * `deriveStatus` WOULD return if rule 3 (`blocked != null → Blocked`)
 * did not exist. Priority order matches `deriveStatus` rules 1, 2, 4,
 * 5, 6, 7:
 *
 *   1. `cancelled_at` populated → `"Cancelled"`
 *   2. `completed_at` populated → `"Done"`
 *   3. `dispatch != null`       → `"In Progress"`
 *   4. `ready_at` populated     → `"ToDo"`
 *   5. `archived_at` populated  → `"Backlog"`
 *   6. else                     → `"Review"`
 *
 * Non-Blocked statuses pass through verbatim — the migration is a
 * no-op on every column except Blocked. Lifecycle triggers are read
 * but never written; the migration only touches `status` and
 * `schema_version`.
 *
 * Idempotent at v12: this migration is never called on a v12 input
 * (the registry's loop terminates the moment `schema_version` hits
 * `KNOWN_SCHEMA_MAX`). Defense-in-depth: if a caller hands a v12 input
 * the function still throws via the registry's "did not advance the
 * version" guard.
 */
export function migrateV11ToV12(prev: unknown): unknown {
  if (typeof prev !== "object" || prev === null || Array.isArray(prev)) {
    throw new MigrationRegistryError(
      `migrateV11ToV12: input must be a plain object (got ${prev === null ? "null" : Array.isArray(prev) ? "array" : typeof prev})`,
    );
  }
  const v = prev as Record<string, unknown>;

  const next: Record<string, unknown> = {
    ...v,
    schema_version: 12,
  };

  if (v.status === "Blocked") {
    next.status = remapBlockedStatus(v);
  }

  return next;
}

function remapBlockedStatus(v: Record<string, unknown>): string {
  if (isPopulatedTimestamp(v.cancelled_at)) return "Cancelled";
  if (isPopulatedTimestamp(v.completed_at)) return "Done";
  if (v.dispatch !== null && v.dispatch !== undefined) return "In Progress";
  if (isPopulatedTimestamp(v.ready_at)) return "ToDo";
  if (isPopulatedTimestamp(v.archived_at)) return "Backlog";
  return "Review";
}

function isPopulatedTimestamp(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
