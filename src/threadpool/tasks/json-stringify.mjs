/**
 * DX-635 — JSON.stringify threadpool task.
 *
 * Offloads `JSON.stringify` of large objects (audit-error payloads,
 * reconcile diff details, system-error sample payloads with whole-
 * issue snapshots). A multi-KB stringify is sync and CPU-bound; running
 * it in a worker keeps the audit pass's `recordSystemError` chain off
 * the main loop.
 *
 * `.mjs` (not `.ts`) so worker_threads load it natively — see
 * `canonical-hash.mjs` header for rationale.
 *
 * REJECTS `value === undefined` fail-loud — `JSON.stringify(undefined)`
 * returns the value `undefined` (not a string), which the
 * `recordError` caller would then pass to pg's jsonb parameter,
 * crashing with a type error. The wrapper in `pool.ts` also
 * pre-rejects; this is the defense-in-depth boundary check.
 *
 * Propagates JSON.stringify's circular-ref TypeError unchanged — caller
 * is responsible for passing serializable data. The audit paths in this
 * codebase already produce plain RFC-6902 patches + primitive maps.
 *
 * @typedef {{ value: unknown }} JsonStringifyInput
 *
 * @param {JsonStringifyInput} input
 * @returns {string}
 */
export default function jsonStringifyTask(input) {
  if (input.value === undefined) {
    throw new Error(
      "jsonStringifyTask: value must be defined — pg jsonb cannot accept undefined. Wrap in {} or use null at the boundary.",
    );
  }
  return JSON.stringify(input.value);
}
