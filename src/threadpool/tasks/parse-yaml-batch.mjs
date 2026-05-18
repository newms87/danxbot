/**
 * DX-635 — bulk YAML parse threadpool task.
 *
 * Cold-boot scan reads every YAML under `<repo>/.danxbot/issues/{open,
 * closed}/` and calls `yaml.parse` on each text. On a 100+-card repo
 * the synchronous parse burst sits on the main loop long enough to
 * starve pg-pool's 15s `connectionTimeoutMillis` (DX-633 root cause
 * class). Batching the parse phase into a worker keeps the boot
 * sweep IO-bound on the main thread (readFileSync per file) and CPU-
 * bound off-thread (parse the resulting strings).
 *
 * `.mjs` (not `.ts`) so worker_threads load it natively — see
 * `canonical-hash.mjs` header for rationale.
 *
 * Returns one settled-result per input text — a single malformed YAML
 * in the batch does NOT abort the rest. The caller decides per-entry
 * what to do (the mirror's pre-existing malformed-YAML branch in
 * `readAndParse` covers the on-disk handling).
 *
 * @typedef {{ texts: string[] }} ParseYamlBatchInput
 * @typedef {{ ok: true, data: unknown } | { ok: false, error: string }} ParseYamlBatchEntry
 *
 * @param {ParseYamlBatchInput} input
 * @returns {ParseYamlBatchEntry[]}
 */

import { parse as parseYamlText } from "yaml";

export default function parseYamlBatchTask(input) {
  return input.texts.map((text) => {
    try {
      return { ok: true, data: parseYamlText(text) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
