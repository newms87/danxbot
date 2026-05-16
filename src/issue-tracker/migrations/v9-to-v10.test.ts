import { describe, expect, it } from "vitest";
import { migrateV9ToV10 } from "./v9-to-v10.js";

describe("migrateV9ToV10", () => {
  it("stamps schema_version: 10 + defaults the five new nullable fields", () => {
    const v9 = {
      schema_version: 9,
      tracker: "memory",
      id: "DX-1",
      external_id: "",
      parent_id: null,
      children: [],
      dispatch: null,
      status: "ToDo",
      type: "Feature",
      title: "t",
      description: "d",
      priority: 3.0,
      position: null,
      triage: {},
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      assigned_agent: null,
      waiting_on: null,
      blocked: null,
      requires_human: null,
      conflict_on: [],
      effort_level: null,
      history: [],
      db_updated_at: "",
    };

    const v10 = migrateV9ToV10(v9) as Record<string, unknown>;

    expect(v10.schema_version).toBe(10);
    expect(v10.archived_at).toBeNull();
    expect(v10.ready_at).toBeNull();
    expect(v10.completed_at).toBeNull();
    expect(v10.cancelled_at).toBeNull();
    expect(v10.list_name).toBeNull();
  });

  it("renames blocked.timestamp → blocked.at when blocked is non-null", () => {
    const v9 = {
      schema_version: 9,
      blocked: { reason: "needs key", timestamp: "2026-05-10T00:00:00Z" },
    };
    const v10 = migrateV9ToV10(v9) as Record<string, unknown>;
    expect(v10.blocked).toEqual({
      reason: "needs key",
      at: "2026-05-10T00:00:00Z",
    });
  });

  it("leaves blocked: null untouched", () => {
    const v9 = { schema_version: 9, blocked: null };
    const v10 = migrateV9ToV10(v9) as Record<string, unknown>;
    expect(v10.blocked).toBeNull();
  });

  it("never mutates the input (pure function)", () => {
    const v9 = {
      schema_version: 9,
      blocked: { reason: "r", timestamp: "2026-01-01T00:00:00Z" },
    };
    const snapshot = JSON.parse(JSON.stringify(v9));
    migrateV9ToV10(v9);
    expect(v9).toEqual(snapshot);
    // Specifically: input retains `timestamp`, no `at` key added in place.
    expect(
      (v9.blocked as Record<string, unknown>).timestamp,
    ).toBe("2026-01-01T00:00:00Z");
    expect("at" in (v9.blocked as object)).toBe(false);
  });

  it("preserves existing v10-shape fields if a caller hands a partially-migrated input", () => {
    // Defensive — registry callers ought not pass mixed shapes, but the
    // migration should be idempotent for the new fields (don't overwrite
    // a non-null value with null).
    const partial = {
      schema_version: 9,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      blocked: null,
    };
    const v10 = migrateV9ToV10(partial) as Record<string, unknown>;
    expect(v10.ready_at).toBe("2026-05-01T00:00:00Z");
    expect(v10.archived_at).toBeNull();
    expect(v10.schema_version).toBe(10);
  });

  it("does not fabricate timestamp fields when blocked carries the v10 .at shape already", () => {
    const alreadyV10Shape = {
      schema_version: 9,
      blocked: { reason: "r", at: "2026-05-10T00:00:00Z" },
    };
    const v10 = migrateV9ToV10(alreadyV10Shape) as Record<string, unknown>;
    expect(v10.blocked).toEqual({ reason: "r", at: "2026-05-10T00:00:00Z" });
  });
});
