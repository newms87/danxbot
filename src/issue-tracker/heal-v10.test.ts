import { describe, expect, it } from "vitest";
import { healV10MissingFields } from "./heal-v10.js";

describe("healV10MissingFields", () => {
  it("fills priority with canonical default 3 when missing", () => {
    const input = { id: "DX-1", schema_version: 10 };
    const r = healV10MissingFields(input);
    expect(r.applied).toContain("priority");
    expect(r.value.priority).toBe(3);
  });

  it("fills every required-with-default v10 field when input is minimal", () => {
    const input = { id: "DX-1", schema_version: 10 };
    const r = healV10MissingFields(input);
    expect(r.applied.sort()).toEqual(
      [
        "archived_at",
        "assigned_agent",
        "cancelled_at",
        "completed_at",
        "conflict_on",
        "db_updated_at",
        "effort_level",
        "history",
        "list_name",
        "position",
        "priority",
        "ready_at",
        "requires_human",
        "waiting_on",
      ].sort(),
    );
    expect(r.value.waiting_on).toBeNull();
    expect(r.value.conflict_on).toEqual([]);
    expect(r.value.history).toEqual([]);
    expect(r.value.db_updated_at).toBe("");
  });

  it("returns pointer-equal input when nothing needed filling (idempotent)", () => {
    const input: Record<string, unknown> = {
      id: "DX-1",
      schema_version: 10,
      priority: 4.2,
      position: 7,
      history: [],
      assigned_agent: null,
      waiting_on: null,
      requires_human: null,
      conflict_on: [],
      effort_level: "medium",
      db_updated_at: "",
      archived_at: null,
      ready_at: null,
      completed_at: null,
      cancelled_at: null,
      list_name: null,
    };
    const r = healV10MissingFields(input);
    expect(r.applied).toEqual([]);
    expect(r.value).toBe(input);
  });

  it("does NOT overwrite a field that exists with falsy/zero/empty values", () => {
    const input: Record<string, unknown> = {
      id: "DX-1",
      schema_version: 10,
      priority: 0,
      position: 0,
      history: [],
      conflict_on: [],
      db_updated_at: "",
      effort_level: null,
    };
    const r = healV10MissingFields(input);
    expect(r.value.priority).toBe(0);
    expect(r.value.position).toBe(0);
    expect(r.value.effort_level).toBeNull();
  });

  it("does not mutate the input object", () => {
    const input: Record<string, unknown> = { id: "DX-1", schema_version: 10 };
    const before = Object.keys(input).slice();
    healV10MissingFields(input);
    expect(Object.keys(input)).toEqual(before);
  });
});
