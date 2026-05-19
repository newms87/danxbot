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
 *  - `history[].from` / `history[].to` carrying `"Blocked"` (pre-v12
 *    `status_change` entries) are remapped to the same projection.
 *    The v12 validator (yaml.ts validateHistory) rejects any non-
 *    canonical IssueStatus value in those fields; a v11 history
 *    written before the enum drop would otherwise fail every read.
 *    The projection is computed ONCE from the top-level fields and
 *    applied uniformly — per-entry timestamps don't carry enough
 *    state to reconstruct an at-the-time projection (DX-700).
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

  return healBlockedReferences(next);
}

/**
 * Heal pass — remap every `"Blocked"` literal (top-level `status` +
 * `history[].from` / `history[].to`) to the deriveStatus-without-rule-3
 * projection. Pure: never mutates the input; returns a fresh object
 * sharing references for unchanged subtrees.
 *
 * Used both by `migrateV11ToV12` (forward migration of v11 files) AND
 * by `migrate-on-boot.ts`'s at-MAX branch (to heal v12 files already
 * on disk whose history was not remapped by the v1 of the v11→v12
 * migration — DX-700). Schema-version-agnostic: it ONLY touches the
 * status fields, never the version field.
 *
 * Idempotent at v12: a file whose top-level + history are already
 * valid IssueStatus values is returned without modification.
 */
export function healBlockedReferences(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const projection = remapBlockedStatus(raw);
  const statusBad = raw.status === "Blocked";
  const historyHasBlocked =
    Array.isArray(raw.history) && historyCarriesBlocked(raw.history);
  if (!statusBad && !historyHasBlocked) return raw;
  const next: Record<string, unknown> = { ...raw };
  if (statusBad) next.status = projection;
  if (historyHasBlocked) {
    next.history = remapBlockedHistory(raw.history as unknown[], projection);
  }
  return next;
}

function historyCarriesBlocked(history: unknown[]): boolean {
  for (const entry of history) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.from === "Blocked" || e.to === "Blocked") return true;
  }
  return false;
}

/**
 * Walk a v11 `history[]` array and clone any entry whose `from` or
 * `to` carries `"Blocked"`, replacing the offending value with the
 * supplied projection. Non-Blocked entries pass through by reference
 * (still safe — the parent shallow-clone in `migrateV11ToV12` already
 * produced a fresh `next` object, and v11→v12 never mutates entry
 * internals). Returns a fresh array.
 */
function remapBlockedHistory(
  history: unknown[],
  projection: string,
): unknown[] {
  return history.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return entry;
    }
    const e = entry as Record<string, unknown>;
    const fromBad = e.from === "Blocked";
    const toBad = e.to === "Blocked";
    if (!fromBad && !toBad) return entry;
    const cloned: Record<string, unknown> = { ...e };
    if (fromBad) cloned.from = projection;
    if (toBad) cloned.to = projection;
    return cloned;
  });
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
