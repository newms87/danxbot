import { describe, it, expect } from "vitest";
import { migrateLegacyToV10 } from "./legacy-to-v10.js";
import { MigrationRegistryError } from "./registry.js";

const v6Sample = {
  schema_version: 6,
  tracker: "trello",
  id: "DX-31",
  external_id: "abc",
  parent_id: null,
  children: [],
  dispatch: null,
  status: "Review",
  type: "Feature",
  title: "sample",
  description: "body",
  priority: 3,
  position: null,
  triage: {
    expires_at: "",
    reassess_hint: "",
    last_status: "",
    last_explain: "",
    ice: { total: 0, i: 0, c: 0, e: 0 },
    history: [],
  },
  ac: [],
  comments: [],
  history: [],
  retro: { good: "", bad: "", action_item_ids: [], commits: [] },
  assigned_agent: null,
  waiting_on: null,
  blocked: null,
  requires_human: null,
};

const v7Sample = { ...v6Sample, schema_version: 7, conflict_on: [] };
const v8Sample = {
  ...v7Sample,
  schema_version: 8,
  effort_level: null,
};

describe("migrateLegacyToV10", () => {
  it("migrates a v6 card to v10 with every v10 field defaulted", () => {
    const out = migrateLegacyToV10(v6Sample) as Record<string, unknown>;
    expect(out.schema_version).toBe(10);
    expect(out.conflict_on).toEqual([]);
    expect(out.effort_level).toBeNull();
    expect(out.db_updated_at).toBe("");
    expect(out.archived_at).toBeNull();
    expect(out.ready_at).toBeNull();
    expect(out.completed_at).toBeNull();
    expect(out.cancelled_at).toBeNull();
    expect(out.list_name).toBeNull();
    // sanity: preserved fields
    expect(out.id).toBe("DX-31");
    expect(out.title).toBe("sample");
  });

  it("migrates a v7 card to v10; preserves existing conflict_on", () => {
    const out = migrateLegacyToV10({
      ...v7Sample,
      conflict_on: [{ id: "DX-99", reason: "files" }],
    }) as Record<string, unknown>;
    expect(out.schema_version).toBe(10);
    expect(out.conflict_on).toEqual([{ id: "DX-99", reason: "files" }]);
    expect(out.effort_level).toBeNull();
    expect(out.list_name).toBeNull();
  });

  it("migrates a v8 card to v10; preserves existing effort_level", () => {
    const out = migrateLegacyToV10({
      ...v8Sample,
      effort_level: "high",
    }) as Record<string, unknown>;
    expect(out.schema_version).toBe(10);
    expect(out.effort_level).toBe("high");
    expect(out.db_updated_at).toBe("");
  });

  it("renames blocked.timestamp → blocked.at when blocked is populated", () => {
    const out = migrateLegacyToV10({
      ...v6Sample,
      status: "Blocked",
      blocked: { reason: "x", timestamp: "2026-01-01T00:00:00Z" },
    }) as Record<string, unknown>;
    const blocked = out.blocked as Record<string, unknown>;
    expect(blocked.at).toBe("2026-01-01T00:00:00Z");
    expect(blocked.reason).toBe("x");
    expect("timestamp" in blocked).toBe(false);
  });

  it("idempotent on blocked.at when already migrated", () => {
    const out = migrateLegacyToV10({
      ...v6Sample,
      status: "Blocked",
      blocked: { reason: "x", at: "2026-01-01T00:00:00Z" },
    }) as Record<string, unknown>;
    const blocked = out.blocked as Record<string, unknown>;
    expect(blocked.at).toBe("2026-01-01T00:00:00Z");
  });

  it("does NOT mutate the input", () => {
    const input = { ...v7Sample };
    const snapshot = JSON.stringify(input);
    migrateLegacyToV10(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("migrates a v3 card to v10; supplies every missing field", () => {
    const v3Card = {
      schema_version: 3,
      tracker: "trello",
      id: "SG-126",
      external_id: "abc",
      parent_id: null,
      children: [],
      dispatch: null,
      status: "Review",
      type: "Feature",
      title: "v3 sample",
      description: "body",
      triage: v6Sample.triage,
      ac: [],
      comments: [],
      retro: v6Sample.retro,
      blocked: null,
    };
    const out = migrateLegacyToV10(v3Card) as Record<string, unknown>;
    expect(out.schema_version).toBe(10);
    expect(out.priority).toBe(3);
    expect(out.position).toBeNull();
    expect(out.history).toEqual([]);
    expect(out.assigned_agent).toBeNull();
    expect(out.waiting_on).toBeNull();
    expect(out.requires_human).toBeNull();
    expect(out.conflict_on).toEqual([]);
    expect(out.effort_level).toBeNull();
    expect(out.db_updated_at).toBe("");
    expect(out.list_name).toBeNull();
  });

  it("maps retired 'Needs Help' status to Blocked + synth blocked record", () => {
    const v3Card = {
      schema_version: 3,
      tracker: "trello",
      id: "SG-99",
      external_id: "",
      parent_id: null,
      children: [],
      dispatch: null,
      status: "Needs Help",
      type: "Feature",
      title: "needs-help",
      description: "x",
      triage: v6Sample.triage,
      ac: [],
      comments: [],
      retro: v6Sample.retro,
      blocked: null,
    };
    const out = migrateLegacyToV10(v3Card) as Record<string, unknown>;
    expect(out.status).toBe("Blocked");
    const blocked = out.blocked as Record<string, unknown>;
    expect(typeof blocked.reason).toBe("string");
    expect(typeof blocked.at).toBe("string");
    expect(blocked.reason).toMatch(/Needs Help/);
  });

  it("throws on schema_version 9 (out of scope; v9 has its own migration)", () => {
    expect(() =>
      migrateLegacyToV10({ ...v8Sample, schema_version: 9 }),
    ).toThrow(MigrationRegistryError);
  });

  it("throws on schema_version 2 (below registry floor)", () => {
    expect(() =>
      migrateLegacyToV10({ ...v6Sample, schema_version: 2 }),
    ).toThrow(MigrationRegistryError);
  });

  it("throws on schema_version 10 (already canonical)", () => {
    expect(() =>
      migrateLegacyToV10({ ...v8Sample, schema_version: 10 }),
    ).toThrow(MigrationRegistryError);
  });

  it("throws on non-object input", () => {
    expect(() => migrateLegacyToV10(null)).toThrow(MigrationRegistryError);
    expect(() => migrateLegacyToV10("not an object")).toThrow(
      MigrationRegistryError,
    );
    expect(() => migrateLegacyToV10([])).toThrow(MigrationRegistryError);
  });
});
