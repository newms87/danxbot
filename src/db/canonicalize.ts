import { createHash } from "node:crypto";

/**
 * Pure helpers for the issues-mirror's content-addressed dedup.
 *
 * `canonicalize` produces a JSON string with object keys sorted recursively
 * so two semantically-equal parsed YAMLs always yield the same bytes,
 * regardless of key ordering on disk. `sha256` is the content hash the
 * mirror stores in `issues.content_hash` and chains through
 * `issue_history.{prev_hash, next_hash}`.
 *
 * Splitting these out of `issues-mirror.ts` lets the writer side
 * (`writeIssue` in `src/poller/yaml-lifecycle.ts`) compute the same hash
 * the watcher will compute, so the watcher's skip-match dedup
 * recognises the writer's own pre-populated row without re-importing
 * the mirror module.
 *
 * Hashing canonical bytes (not raw YAML text) means same-data + reordered
 * keys + reformatted whitespace all collapse to one row — exactly what
 * the spec calls for in "no-op write detection."
 */

/**
 * Top-level Issue keys excluded from the canonical content hash. The set
 * MUST stay tiny and intentional — every exclusion is a field where two
 * writes that differ ONLY in this field are semantically a no-op for the
 * mirror's dedup / history-bloat-avoidance purposes.
 *
 * - `db_updated_at` (DX-547 Phase 2): the writer stamps this on every
 *   save. Including it in the hash would mean every re-save of identical
 *   content produces a new history row (the canonical no-op short-circuit
 *   never fires). Excluding lets the writer's `upsertIssueRowNow` use the
 *   spec's `existing.content_hash === contentHash` check correctly: two
 *   back-to-back `writeIssue` calls with the same content produce one
 *   history row, not two.
 */
const HASH_EXCLUDED_TOP_KEYS = new Set<string>(["db_updated_at"]);

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value, /*isTopLevel=*/ true));
}

function canonicalizeValue(value: unknown, isTopLevel = false): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => canonicalizeValue(v));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (isTopLevel && HASH_EXCLUDED_TOP_KEYS.has(key)) continue;
      out[key] = canonicalizeValue(obj[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Convenience: canonicalize then hash. The mirror upsert path uses this
 * as the single content-hash entry point so writer + watcher cannot
 * disagree on the bytes they're hashing.
 */
export function hashCanonical(value: unknown): string {
  return sha256(canonicalize(value));
}
