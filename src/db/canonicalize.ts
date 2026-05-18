/**
 * Pure helpers for the issues-mirror's content-addressed dedup.
 *
 * `canonicalize` produces a JSON string with object keys sorted recursively
 * so two semantically-equal parsed YAMLs always yield the same bytes,
 * regardless of key ordering on disk. `sha256` is the content hash the
 * mirror stores in `issues.content_hash` and chains through
 * `issue_history.{prev_hash, next_hash}`.
 *
 * Implementation lives in `./canonicalize-core.mjs` so the worker_threads
 * canonical-hash task (`src/threadpool/tasks/canonical-hash.mjs`) can
 * import the same bytes without duplicating logic. tsx's ESM loader
 * doesn't register inside worker_threads, so the shared source has to be
 * `.mjs` — this `.ts` file is a thin typed re-export. The single canonical
 * source eliminates the DX-635 drift risk between sync + pool paths.
 *
 * Hashing canonical bytes (not raw YAML text) means same-data + reordered
 * keys + reformatted whitespace all collapse to one row — exactly what
 * the spec calls for in "no-op write detection."
 *
 * Top-level Issue keys excluded from the canonical content hash live in
 * `canonicalize-core.mjs`. The set MUST stay tiny and intentional — every
 * exclusion is a field where two writes that differ ONLY in this field
 * are semantically a no-op for the mirror's dedup / history-bloat-
 * avoidance purposes (currently: `db_updated_at`).
 */

export { canonicalize, sha256, hashCanonical } from "./canonicalize-core.mjs";
