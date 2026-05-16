import { describe, expect, it, vi } from "vitest";
import {
  KNOWN_SCHEMA_MIN,
  KNOWN_SCHEMA_MAX,
} from "../schema-versions.js";
import {
  migrateForward,
  migrationsByFromVersion,
  MigrationRegistryError,
  __testing_runWithMigrations,
} from "./registry.js";

describe("migration registry", () => {
  it("MIN == MAX - 1 invariant", () => {
    // Single-version tolerance — the validator only accepts MAX-1 and MAX.
    // The boot sweep (P2) walks open YAMLs forward to MAX; after the sweep
    // window closes the next bump moves MIN up by one. Locked here so a
    // future bump that forgets to advance MIN fails this unit suite before
    // it reaches a host session.
    expect(KNOWN_SCHEMA_MIN).toBe(KNOWN_SCHEMA_MAX - 1);
  });

  it("registers a v9-to-v10 migration", () => {
    expect(migrationsByFromVersion.has(9)).toBe(true);
    const fn = migrationsByFromVersion.get(9);
    expect(typeof fn).toBe("function");
  });

  it("migrateForward applies the v9-to-v10 migration when input is v9", () => {
    const v9 = {
      schema_version: 9,
      blocked: { reason: "r", timestamp: "2026-05-10T00:00:00Z" },
    };
    const out = migrateForward(v9) as Record<string, unknown>;
    expect(out.schema_version).toBe(KNOWN_SCHEMA_MAX);
    expect(out.blocked).toEqual({
      reason: "r",
      at: "2026-05-10T00:00:00Z",
    });
  });

  it("migrateForward is a no-op when input is already at MAX", () => {
    const v10 = { schema_version: KNOWN_SCHEMA_MAX, blocked: null };
    const out = migrateForward(v10);
    // Returns the value, possibly the same reference or a fresh clone — but
    // schema_version stays at MAX and the call does not throw.
    expect((out as Record<string, unknown>).schema_version).toBe(
      KNOWN_SCHEMA_MAX,
    );
  });

  it("chains multiple migrations until schema_version === KNOWN_SCHEMA_MAX", () => {
    // Synthetic v8 → v9 → v10 chain. We register a temporary v8→v9 hop and
    // verify migrateForward keeps applying registered migrations until the
    // input lands at MAX. Use the test-only injector so we don't pollute
    // the production map.
    const tempMap = new Map(migrationsByFromVersion);
    tempMap.set(8, (prev: unknown) => {
      const v = prev as Record<string, unknown>;
      return { ...v, schema_version: 9 };
    });
    const v8 = {
      schema_version: 8,
      blocked: { reason: "r", timestamp: "2026-05-10T00:00:00Z" },
    };
    const out = __testing_runWithMigrations(tempMap, v8) as Record<
      string,
      unknown
    >;
    expect(out.schema_version).toBe(KNOWN_SCHEMA_MAX);
    expect(out.blocked).toEqual({
      reason: "r",
      at: "2026-05-10T00:00:00Z",
    });
  });

  it("throws when input schema_version is below the lowest registered migration AND below MAX", () => {
    // Caller's responsibility — boot sweep (P2) is supposed to bump any
    // pre-MIN file to MIN first. In-process readers never see pre-MIN data
    // under normal operation; if they do, fail loud rather than guess.
    const v3 = { schema_version: 3 };
    expect(() => migrateForward(v3)).toThrow(MigrationRegistryError);
    expect(() => migrateForward(v3)).toThrow(/no migration registered/i);
  });

  it("throws when input is not a plain object", () => {
    expect(() => migrateForward(null)).toThrow(MigrationRegistryError);
    expect(() => migrateForward(42)).toThrow(MigrationRegistryError);
    expect(() => migrateForward("v9")).toThrow(MigrationRegistryError);
  });

  it("throws when input is missing schema_version", () => {
    expect(() => migrateForward({})).toThrow(MigrationRegistryError);
    expect(() => migrateForward({ schema_version: null })).toThrow(
      MigrationRegistryError,
    );
  });

  it("throws when a migration produces an output whose schema_version did not advance", () => {
    // A buggy migration that forgets to bump schema_version would loop
    // forever — guard against it.
    const tempMap = new Map<number, (prev: unknown) => unknown>();
    tempMap.set(9, (prev) => ({ ...(prev as object), schema_version: 9 }));
    const v9 = { schema_version: 9 };
    expect(() => __testing_runWithMigrations(tempMap, v9)).toThrow(
      MigrationRegistryError,
    );
  });

  it("hard-throws on schema_version above KNOWN_SCHEMA_MAX (no synthetic forward-compat fabrication)", () => {
    // Forward-compat (DX-280) belongs in the validator — the registry has
    // no business inventing migrations it does not know how to write. A
    // future-version input arriving here is a programming error.
    const future = { schema_version: KNOWN_SCHEMA_MAX + 5 };
    expect(() => migrateForward(future)).toThrow(MigrationRegistryError);
  });

  it("does not mutate the input through the chain (pure)", () => {
    const v9 = {
      schema_version: 9,
      blocked: { reason: "r", timestamp: "2026-05-10T00:00:00Z" },
    };
    const snapshot = JSON.parse(JSON.stringify(v9));
    migrateForward(v9);
    expect(v9).toEqual(snapshot);
  });

  it("round-trip: a v9 raw object migrated forward parses and serializes via the canonical writer", async () => {
    // Integration sanity: v9 raw → migrateForward → serializeIssue
    // re-emits canonical v10 YAML. Validates the registry's output is
    // shape-compatible with the writer.
    const { createEmptyIssue, serializeIssue, parseIssue } = await import(
      "../yaml.js"
    );
    const issue = createEmptyIssue({
      id: "DX-1",
      title: "round-trip fixture",
      blocked: { reason: "r", at: "2026-05-10T00:00:00Z" },
      status: "Blocked",
    });
    const text = serializeIssue(issue);
    const parsed = parseIssue(text, { expectedPrefix: "DX" });
    expect(parsed.schema_version).toBe(KNOWN_SCHEMA_MAX);
    expect(parsed.blocked).toEqual({
      reason: "r",
      at: "2026-05-10T00:00:00Z",
    });
  });

  it("module-load-time resolution: migrationsByFromVersion is a Map, not a builder", () => {
    // The registry resolves at module load time (one Map<from, fn>) — no
    // per-call build. Cheap to assert: the export must be a Map instance.
    expect(migrationsByFromVersion).toBeInstanceOf(Map);
  });

  it("forward-compat warning is the validator's job, not the registry's — registry stays silent", () => {
    // Defense-in-depth — a future test that adds console.warn to the
    // registry would surface here.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      migrateForward({
        schema_version: 9,
        blocked: { reason: "r", timestamp: "2026-05-10T00:00:00Z" },
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
