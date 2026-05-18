/**
 * Boot-sweep heal for v10 YAMLs missing required fields.
 *
 * Fail-loud is the runtime contract (`CLAUDE.md` "Single Canonical Schema —
 * Fail Loud, No Legacy"): readers throw on missing required fields and the
 * boot sweep is the ONE writer-side authority that brings disk to canonical
 * before any reader runs.
 *
 * The legacy migrations (`legacy-to-v10.ts` + `v9-to-v10.ts`) fill in the
 * fields they know about, but two paths leak malformed v10 onto disk:
 *
 *   - `v9-to-v10.ts` only fills the FIVE new v10 fields with null; a v9
 *     YAML already missing a v9-required field (e.g. `priority`) survives
 *     migration with the field still absent. The strict v10 validator then
 *     rejects it fail-loud at read time.
 *   - A writer regression (hand-edit, buggy MCP write path, partial save)
 *     can produce a `schema_version: 11` file that lacks one of the
 *     required-with-default fields. Boot sweep currently sees the version
 *     at MAX and short-circuits to `unchanged++`, masking the writer bug
 *     until first read.
 *
 * `healV10MissingFields` fills any of the canonical "required with safe
 * default" fields that are absent. The heal is **writer-side only** — the
 * boot sweep applies it, writes back to disk via atomic temp+rename, and
 * counts each heal. After the sweep, on-disk YAMLs round-trip cleanly
 * through the strict reader — no reader-side tolerance, no parse-time
 * silent defaults.
 *
 * Fields NOT in the heal table (e.g. `title`, `description`, `id`,
 * `tracker`, `status`, `type`, `schema_version`) have no safe default —
 * a YAML missing those is still a hard `failed[]` entry in the sweep.
 *
 * Idempotent: applying the heal twice produces the same output as once.
 */

/**
 * Canonical defaults for v10 fields that have a safe, structural default.
 * Lines up with `migrateLegacyToV10`'s `pickExisting` defaults so the
 * heal-after-migrate path and the heal-at-MAX path agree on what
 * "canonical for a missing field" means.
 */
const V10_DEFAULTS: Record<string, () => unknown> = {
  priority: () => 3,
  history: () => [],
  assigned_agent: () => null,
  waiting_on: () => null,
  requires_human: () => null,
  conflict_on: () => [],
  effort_level: () => null,
  db_updated_at: () => "",
  archived_at: () => null,
  ready_at: () => null,
  completed_at: () => null,
  cancelled_at: () => null,
  list_name: () => null,
};

export interface HealResult {
  /** Names of fields the heal filled in. Empty when input was already canonical. */
  applied: string[];
  /** The heal output. Pointer-equal to `input` when nothing was filled. */
  value: Record<string, unknown>;
}

/**
 * Walk the canonical v10 default table, fill any missing fields with the
 * canonical default, return a fresh object when anything was filled.
 *
 * Pure: never mutates `input`. When no field needed filling, returns the
 * input object verbatim (pointer-equal) so callers can branch on
 * `result.value === input` instead of comparing payloads.
 */
export function healV10MissingFields(
  input: Record<string, unknown>,
): HealResult {
  const applied: string[] = [];
  let out: Record<string, unknown> | null = null;
  for (const [key, defaultFn] of Object.entries(V10_DEFAULTS)) {
    if (!(key in input)) {
      if (out === null) out = { ...input };
      out[key] = defaultFn();
      applied.push(key);
    }
  }
  return { applied, value: out ?? input };
}
