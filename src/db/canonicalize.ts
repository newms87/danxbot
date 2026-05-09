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
 * the watcher will compute, so both can key into the in-process
 * `awaitMirror` registry without re-importing the mirror module.
 *
 * Hashing canonical bytes (not raw YAML text) means same-data + reordered
 * keys + reformatted whitespace all collapse to one row — exactly what
 * the spec calls for in "no-op write detection."
 */

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
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
