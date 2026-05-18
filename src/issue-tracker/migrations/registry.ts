/**
 * Schema migration registry (DX-592 / parent epic DX-591).
 *
 * The single canonical source of "how a v(N) YAML becomes v(N+1)". Every
 * forward migration registers a pure `(prev: unknown) => unknown`
 * function keyed on the source `schema_version`. `migrateForward`
 * applies the chain in sequence until the value's `schema_version`
 * equals `KNOWN_SCHEMA_MAX`.
 *
 * Design contracts:
 *  - Each migration is a PURE function. NEVER mutates its input. The
 *    chain may reuse references across migrations only when a step is a
 *    no-op; in general every step returns a fresh object.
 *  - The registry resolves at module load time (one Map<from, fn>) — no
 *    per-call build. Adding a future bump (`v10-to-v11.ts`) means:
 *    (a) import the module here, (b) `migrationsByFromVersion.set(10, fn)`.
 *  - Hard-throws on:
 *      - non-object input
 *      - missing `schema_version`
 *      - `schema_version < lowest registered key AND < KNOWN_SCHEMA_MAX`
 *        (the caller — boot sweep — must have already bumped pre-MIN
 *        files; in-process readers never see pre-MIN data)
 *      - `schema_version > KNOWN_SCHEMA_MAX` (forward-compat is the
 *        validator's job, not the registry's — a future-version input
 *        arriving here is a programming error)
 *      - a buggy migration that fails to advance `schema_version` past
 *        its source version (infinite-loop guard)
 *
 * P1 (this card) lands the framework + the first migration (`v9-to-v10`).
 * P2 wires `migrateForward` into the boot sweep that walks every open
 * YAML forward to canonical. P3 removes the validator's inline
 * legacy-version tolerance branches now that the boot sweep guarantees
 * every on-disk YAML matches `KNOWN_SCHEMA_MAX`.
 */
import { KNOWN_SCHEMA_MAX } from "../schema-versions.js";
import { migrateLegacyToV10 } from "./legacy-to-v10.js";
import { migrateV9ToV10 } from "./v9-to-v10.js";
import { migrateV10ToV11 } from "./v10-to-v11.js";

export class MigrationRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationRegistryError";
  }
}

/**
 * Map of source `schema_version` → forward migration to the next
 * version. Resolved at module load time. Adding a future v(N) → v(N+1)
 * migration = one line here (`.set(N, migrateVNToVN1)`) plus the
 * `v(N)-to-v(N+1).ts` module.
 */
export const migrationsByFromVersion: ReadonlyMap<
  number,
  (prev: unknown) => unknown
> = new Map<number, (prev: unknown) => unknown>([
  // Pre-v9 schemas use the unified `legacy-to-v10` bridge — one
  // additive function with idempotent field defaults for every shape
  // we ever shipped at v3-v8. Each registration jumps to v10; the
  // registry's loop then composes the v10 → v11 hop automatically.
  // v9 keeps its own dedicated migration because v9 carries the
  // blocked.timestamp → blocked.at rename that the legacy bridge
  // does not handle.
  [3, migrateLegacyToV10],
  [4, migrateLegacyToV10],
  [5, migrateLegacyToV10],
  [6, migrateLegacyToV10],
  [7, migrateLegacyToV10],
  [8, migrateLegacyToV10],
  [9, migrateV9ToV10],
  [10, migrateV10ToV11],
]);

/**
 * Apply registered migrations to `raw` until its `schema_version`
 * reaches `KNOWN_SCHEMA_MAX`. Returns the migrated value. Pure with
 * respect to the input (input never mutated). Throws
 * `MigrationRegistryError` on any of the failure modes documented on
 * the module header.
 *
 * Idempotent at `schema_version === KNOWN_SCHEMA_MAX`: returns the
 * input as-is (no clone) — the caller may still wrap with the
 * validator's stricter shape checks.
 */
export function migrateForward(raw: unknown): unknown {
  return __testing_runWithMigrations(migrationsByFromVersion, raw);
}

/**
 * Test-only — apply an arbitrary migration map to `raw`. Production
 * code paths always use `migrateForward` (which delegates to this
 * helper with the canonical map). Exported solely so the unit suite
 * can exercise chain-composition cases (synthetic v8→v9 hop, buggy
 * non-advancing migrations) without globally mutating the production
 * map.
 */
export function __testing_runWithMigrations(
  migrations: ReadonlyMap<number, (prev: unknown) => unknown>,
  raw: unknown,
): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MigrationRegistryError(
      `migrateForward: input must be a plain object (got ${typeof raw === "object" ? "null/array" : typeof raw})`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.schema_version !== "number") {
    throw new MigrationRegistryError(
      `migrateForward: input missing 'schema_version' or it is not a number (got ${JSON.stringify(obj.schema_version)})`,
    );
  }

  const initialVersion = obj.schema_version;
  if (initialVersion > KNOWN_SCHEMA_MAX) {
    throw new MigrationRegistryError(
      `migrateForward: schema_version ${initialVersion} exceeds KNOWN_SCHEMA_MAX ${KNOWN_SCHEMA_MAX} — forward-compat for future versions belongs in the validator, not the registry`,
    );
  }

  let current: unknown = raw;
  let safetyLoop = 0;
  while (true) {
    if (safetyLoop++ > 32) {
      // Belt-and-suspenders: a malformed chain (cycle, non-advancing
      // migration) is caught explicitly below, but if the safety net
      // ever triggers we want a recognizable diagnostic.
      throw new MigrationRegistryError(
        `migrateForward: chain exceeded 32 hops — registry has a cycle or non-advancing migration`,
      );
    }
    const currentObj = current as Record<string, unknown>;
    const version = currentObj.schema_version;
    if (typeof version !== "number") {
      throw new MigrationRegistryError(
        `migrateForward: intermediate value lost 'schema_version' — migration from ${initialVersion} did not preserve the field`,
      );
    }
    if (version === KNOWN_SCHEMA_MAX) {
      return current;
    }
    const fn = migrations.get(version);
    if (!fn) {
      throw new MigrationRegistryError(
        `migrateForward: no migration registered for schema_version ${version} (initial ${initialVersion}, target ${KNOWN_SCHEMA_MAX})`,
      );
    }
    const next = fn(current);
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new MigrationRegistryError(
        `migrateForward: migration from schema_version ${version} did not return a plain object`,
      );
    }
    const nextVersion = (next as Record<string, unknown>).schema_version;
    if (typeof nextVersion !== "number" || nextVersion <= version) {
      throw new MigrationRegistryError(
        `migrateForward: migration from schema_version ${version} did not advance the version (got ${JSON.stringify(nextVersion)})`,
      );
    }
    current = next;
  }
}
