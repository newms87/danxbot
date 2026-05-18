import { describe, expect, it } from "vitest";
import { migrateV10ToV11 } from "./v10-to-v11.js";

describe("migrateV10ToV11", () => {
  it("stamps schema_version: 11 and drops the position key (null position)", () => {
    const v10 = {
      schema_version: 10,
      tracker: "memory",
      id: "DX-1",
      priority: 3,
      position: null,
    };
    const v11 = migrateV10ToV11(v10) as Record<string, unknown>;
    expect(v11.schema_version).toBe(11);
    expect("position" in v11).toBe(false);
    expect(v11.priority).toBe(3);
  });

  it("folds a non-zero position decimal into priority within the same tier", () => {
    const v10 = {
      schema_version: 10,
      priority: 4.9,
      position: 4.25,
    };
    const v11 = migrateV10ToV11(v10) as Record<string, unknown>;
    // floor(4.9) + (4.25 - floor(4.25)) = 4 + 0.25 = 4.25
    expect(v11.priority).toBe(4.25);
    expect("position" in v11).toBe(false);
    expect(v11.schema_version).toBe(11);
  });

  it("leaves priority unchanged when position is an integer", () => {
    const v10 = {
      schema_version: 10,
      priority: 3.7,
      position: 4,
    };
    const v11 = migrateV10ToV11(v10) as Record<string, unknown>;
    expect(v11.priority).toBe(3.7);
    expect("position" in v11).toBe(false);
  });

  it("is a no-op on priority when the position field is missing", () => {
    const v10 = {
      schema_version: 10,
      priority: 2.5,
    };
    const v11 = migrateV10ToV11(v10) as Record<string, unknown>;
    expect(v11.priority).toBe(2.5);
    expect("position" in v11).toBe(false);
    expect(v11.schema_version).toBe(11);
  });

  it("handles negative position decimals (Math.floor convention)", () => {
    // floor(-0.5) = -1, decimal = -0.5 - (-1) = 0.5.
    // priorities are clamped to (0, 6) at parse-time but the migration
    // itself doesn't clamp — the fold preserves whatever priority was.
    const v10 = {
      schema_version: 10,
      priority: 3.1,
      position: -0.5,
    };
    const v11 = migrateV10ToV11(v10) as Record<string, unknown>;
    expect(v11.priority).toBe(3.5);
    expect("position" in v11).toBe(false);
  });

  it("preserves priority verbatim when position is non-finite (defensive)", () => {
    const v10 = {
      schema_version: 10,
      priority: 2.5,
      position: Number.NaN,
    };
    const v11 = migrateV10ToV11(v10) as Record<string, unknown>;
    expect(v11.priority).toBe(2.5);
    expect("position" in v11).toBe(false);
  });

  it("never mutates the input (pure function)", () => {
    const v10 = {
      schema_version: 10,
      priority: 4.9,
      position: 4.25,
    };
    const snapshot = JSON.parse(JSON.stringify(v10));
    migrateV10ToV11(v10);
    expect(v10).toEqual(snapshot);
    // Specifically: input retains `position`.
    expect("position" in v10).toBe(true);
    expect(v10.position).toBe(4.25);
  });

  it("throws on non-object input", () => {
    expect(() => migrateV10ToV11(null)).toThrow(/plain object/);
    expect(() => migrateV10ToV11([])).toThrow(/plain object/);
    expect(() => migrateV10ToV11("string")).toThrow(/plain object/);
  });

  it("preserves every unrelated v10 field verbatim", () => {
    const v10 = {
      schema_version: 10,
      tracker: "memory",
      id: "DX-42",
      external_id: "abc",
      parent_id: null,
      children: ["DX-43"],
      title: "Title",
      description: "Body",
      priority: 3.0,
      position: null,
      ac: [{ check_item_id: "", title: "ac", checked: false }],
      blocked: { reason: "r", at: "2026-05-10T00:00:00Z" },
      ready_at: "2026-05-01T00:00:00Z",
    };
    const v11 = migrateV10ToV11(v10) as Record<string, unknown>;
    expect(v11.tracker).toBe("memory");
    expect(v11.id).toBe("DX-42");
    expect(v11.external_id).toBe("abc");
    expect(v11.parent_id).toBeNull();
    expect(v11.children).toEqual(["DX-43"]);
    expect(v11.title).toBe("Title");
    expect(v11.description).toBe("Body");
    expect(v11.ac).toEqual([{ check_item_id: "", title: "ac", checked: false }]);
    expect(v11.blocked).toEqual({ reason: "r", at: "2026-05-10T00:00:00Z" });
    expect(v11.ready_at).toBe("2026-05-01T00:00:00Z");
  });
});
