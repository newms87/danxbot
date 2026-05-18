import { describe, expect, it } from "vitest";
import { migrateV11ToV12 } from "./v11-to-v12.js";

describe("migrateV11ToV12", () => {
  it("stamps schema_version: 12 and remaps status: Blocked -> Cancelled when cancelled_at is populated", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: "2026-05-10T00:00:00Z",
      completed_at: null,
      ready_at: null,
      archived_at: null,
      dispatch: null,
      blocked: { reason: "human action", at: "2026-05-09T00:00:00Z" },
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.schema_version).toBe(12);
    expect(v12.status).toBe("Cancelled");
    expect(v12.blocked).toEqual({
      reason: "human action",
      at: "2026-05-09T00:00:00Z",
    });
  });

  it("remaps status: Blocked -> Done when completed_at is populated (no cancelled_at)", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      completed_at: "2026-05-10T00:00:00Z",
      cancelled_at: null,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: null,
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.status).toBe("Done");
  });

  it("remaps status: Blocked -> In Progress when dispatch is non-null (no terminal trigger)", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: null,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: {
        id: "abc",
        pid: 1,
        host: "h",
        kind: "work",
        started_at: "2026-05-09T00:00:00Z",
        ttl_seconds: 7200,
      },
      blocked: { reason: "r", at: "2026-05-08T00:00:00Z" },
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.status).toBe("In Progress");
  });

  it("remaps status: Blocked -> ToDo when ready_at is populated (no terminal/dispatch trigger)", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: null,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: null,
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.status).toBe("ToDo");
  });

  it("remaps status: Blocked -> Backlog when only archived_at is populated", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: null,
      ready_at: null,
      archived_at: "2026-05-01T00:00:00Z",
      dispatch: null,
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.status).toBe("Backlog");
  });

  it("remaps status: Blocked -> Review when no lifecycle trigger fired (raw fallthrough)", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: null,
      ready_at: null,
      archived_at: null,
      dispatch: null,
      blocked: { reason: "ambiguous spec", at: "2026-05-05T00:00:00Z" },
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.status).toBe("Review");
  });

  it("preserves blocked.at and blocked.reason verbatim through the remap", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: null,
      ready_at: null,
      archived_at: null,
      dispatch: null,
      blocked: { reason: "credentials", at: "2026-04-30T12:34:56Z" },
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.blocked).toEqual({
      reason: "credentials",
      at: "2026-04-30T12:34:56Z",
    });
  });

  it("precedence: completed_at beats dispatch (rule 2 wins over rule 4)", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: "2026-05-10T00:00:00Z",
      ready_at: null,
      archived_at: null,
      dispatch: {
        id: "abc",
        pid: 1,
        host: "h",
        kind: "work",
        started_at: "2026-05-09T00:00:00Z",
        ttl_seconds: 7200,
      },
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
    };
    expect((migrateV11ToV12(v11) as Record<string, unknown>).status).toBe("Done");
  });

  it("precedence: dispatch beats ready_at (rule 4 wins over rule 5)", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: null,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: {
        id: "abc",
        pid: 1,
        host: "h",
        kind: "work",
        started_at: "2026-05-09T00:00:00Z",
        ttl_seconds: 7200,
      },
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
    };
    expect((migrateV11ToV12(v11) as Record<string, unknown>).status).toBe(
      "In Progress",
    );
  });

  it("isPopulatedTimestamp: empty-string sentinel does not count as populated (older YAMLs)", () => {
    // Some pre-v10 readers wrote `""` instead of `null` for unset
    // timestamps; the migration treats both equivalently. Without this
    // guard a `cancelled_at: ""` would otherwise short-circuit the rule
    // chain and project to Cancelled despite carrying no real timestamp.
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: "",
      completed_at: "2026-05-10T00:00:00Z",
      ready_at: null,
      archived_at: null,
      dispatch: null,
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
    };
    expect((migrateV11ToV12(v11) as Record<string, unknown>).status).toBe("Done");
  });

  it("precedence: cancelled_at beats completed_at beats dispatch beats ready_at beats archived_at", () => {
    // All triggers populated — cancelled wins.
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: "2026-05-10T00:00:00Z",
      completed_at: "2026-05-09T00:00:00Z",
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: "2026-04-01T00:00:00Z",
      dispatch: {
        id: "abc",
        pid: 1,
        host: "h",
        kind: "work",
        started_at: "2026-05-09T00:00:00Z",
        ttl_seconds: 7200,
      },
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
    };
    expect((migrateV11ToV12(v11) as Record<string, unknown>).status).toBe(
      "Cancelled",
    );
  });

  it("is a no-op on non-Blocked status — preserves status verbatim", () => {
    for (const status of [
      "Review",
      "ToDo",
      "In Progress",
      "Backlog",
      "Done",
      "Cancelled",
    ]) {
      const v11 = {
        schema_version: 11,
        status,
        cancelled_at: null,
        completed_at: null,
        ready_at: null,
        archived_at: null,
        dispatch: null,
        blocked: null,
      };
      const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
      expect(v12.status).toBe(status);
      expect(v12.schema_version).toBe(12);
    }
  });

  it("never mutates the input (pure function)", () => {
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: null,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: null,
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
    };
    const snapshot = JSON.parse(JSON.stringify(v11));
    migrateV11ToV12(v11);
    expect(v11).toEqual(snapshot);
    expect(v11.status).toBe("Blocked");
    expect(v11.schema_version).toBe(11);
  });

  it("preserves every unrelated v11 field verbatim", () => {
    const v11 = {
      schema_version: 11,
      tracker: "memory",
      id: "DX-42",
      external_id: "abc",
      parent_id: null,
      children: ["DX-43"],
      status: "Blocked",
      type: "Feature",
      title: "Title",
      description: "Body",
      priority: 3.0,
      ac: [{ check_item_id: "", title: "ac", checked: false }],
      blocked: { reason: "r", at: "2026-05-10T00:00:00Z" },
      ready_at: "2026-05-01T00:00:00Z",
      completed_at: null,
      cancelled_at: null,
      archived_at: null,
      dispatch: null,
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.tracker).toBe("memory");
    expect(v12.id).toBe("DX-42");
    expect(v12.external_id).toBe("abc");
    expect(v12.parent_id).toBeNull();
    expect(v12.children).toEqual(["DX-43"]);
    expect(v12.type).toBe("Feature");
    expect(v12.title).toBe("Title");
    expect(v12.description).toBe("Body");
    expect(v12.priority).toBe(3.0);
    expect(v12.ac).toEqual([{ check_item_id: "", title: "ac", checked: false }]);
    expect(v12.status).toBe("ToDo"); // Blocked remapped via ready_at trigger
    expect(v12.schema_version).toBe(12);
  });

  it("throws on non-object input", () => {
    expect(() => migrateV11ToV12(null)).toThrow(/plain object/);
    expect(() => migrateV11ToV12([])).toThrow(/plain object/);
    expect(() => migrateV11ToV12("string")).toThrow(/plain object/);
  });

  it("handles missing optional trigger fields (treats as null)", () => {
    // Defensive — pre-migration YAMLs in the wild may omit some trigger
    // fields entirely rather than carrying explicit nulls. Treat absent
    // as null so the rule chain still terminates.
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.status).toBe("Review");
    expect(v12.schema_version).toBe(12);
  });
});
