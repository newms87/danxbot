/**
 * DX-635 — canonical-hash threadpool task.
 *
 * Thin wrapper around the shared `canonicalize-core.mjs` so worker_threads
 * and the main thread hash identical bytes. The shared module is `.mjs`
 * because tsx's ESM loader skips registration in worker_threads (see
 * `node_modules/tsx/dist/esm/index.mjs` — explicit `isMainThread` check),
 * so a `.ts` task file would throw `ERR_UNKNOWN_FILE_EXTENSION` inside
 * a worker.
 *
 * @typedef {{ value: unknown }} CanonicalHashInput
 * @typedef {{ canonical: string, hash: string }} CanonicalHashOutput
 */

import { canonicalize, sha256 } from "../../db/canonicalize-core.mjs";

/**
 * @param {CanonicalHashInput} input
 * @returns {CanonicalHashOutput}
 */
export default function canonicalHashTask(input) {
  const canonical = canonicalize(input.value);
  const hash = sha256(canonical);
  return { canonical, hash };
}
