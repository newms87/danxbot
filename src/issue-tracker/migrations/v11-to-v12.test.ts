import { describe, expect, it } from "vitest";
import { healBlockedReferences, migrateV11ToV12 } from "./v11-to-v12.js";

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

  it("remaps history[].to: Blocked and history[].from: Blocked using the same projection (DX-700)", () => {
    // Pre-DX-657 `status_change` history entries carry "Blocked" in
    // `to` / `from`. v12 dropped "Blocked" from the IssueStatus enum,
    // so the validator (yaml.ts:1296/1305) rejects on read. The
    // migration MUST rewrite those entries using the same
    // deriveStatus-without-rule-3 projection it uses for top-level
    // status.
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: null,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: null,
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
      history: [
        {
          timestamp: "2026-05-05T00:00:00Z",
          actor: "worker:auto-derive",
          event: "status_change",
          from: "In Progress",
          to: "Blocked",
        },
        {
          timestamp: "2026-05-06T00:00:00Z",
          actor: "worker:auto-derive",
          event: "status_change",
          from: "Blocked",
          to: "ToDo",
        },
      ],
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(v12.status).toBe("ToDo");
    const history = v12.history as Array<Record<string, unknown>>;
    // Top-level projects to ToDo via ready_at → both Blocked appearances
    // remap to ToDo. The rest of the entry is preserved verbatim.
    expect(history[0].from).toBe("In Progress");
    expect(history[0].to).toBe("ToDo");
    expect(history[0].timestamp).toBe("2026-05-05T00:00:00Z");
    expect(history[0].actor).toBe("worker:auto-derive");
    expect(history[0].event).toBe("status_change");
    expect(history[1].from).toBe("ToDo");
    expect(history[1].to).toBe("ToDo");
  });

  it("history remap leaves non-Blocked entries untouched", () => {
    const v11 = {
      schema_version: 11,
      status: "ToDo",
      cancelled_at: null,
      completed_at: null,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: null,
      blocked: null,
      history: [
        {
          timestamp: "2026-05-05T00:00:00Z",
          actor: "worker:auto-derive",
          event: "status_change",
          from: "Review",
          to: "ToDo",
        },
      ],
    };
    const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
    const history = v12.history as Array<Record<string, unknown>>;
    expect(history[0].from).toBe("Review");
    expect(history[0].to).toBe("ToDo");
  });

  it("history remap is a no-op when history is missing / null / empty", () => {
    for (const hist of [undefined, null, []]) {
      const v11 = {
        schema_version: 11,
        status: "Review",
        cancelled_at: null,
        completed_at: null,
        ready_at: null,
        archived_at: null,
        dispatch: null,
        blocked: null,
        ...(hist === undefined ? {} : { history: hist }),
      };
      const v12 = migrateV11ToV12(v11) as Record<string, unknown>;
      expect(v12.schema_version).toBe(12);
    }
  });

  it("history remap never mutates input history entries", () => {
    const v11 = {
      schema_version: 11,
      status: "ToDo",
      ready_at: "2026-05-01T00:00:00Z",
      cancelled_at: null,
      completed_at: null,
      archived_at: null,
      dispatch: null,
      blocked: null,
      history: [
        {
          timestamp: "2026-05-05T00:00:00Z",
          actor: "worker:auto-derive",
          event: "status_change",
          from: "In Progress",
          to: "Blocked",
        },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(v11));
    migrateV11ToV12(v11);
    expect(v11).toEqual(snapshot);
  });

  it("healBlockedReferences: returns input by reference on a clean v12 file (no-op contract)", () => {
    // The boot sweep's at-MAX branch uses `blockedHealed === heal.value`
    // to detect "no change" and increment unchanged++ instead of
    // healed++. A clone-on-no-op would silently break that branch.
    const clean = {
      schema_version: 12,
      status: "ToDo",
      cancelled_at: null,
      completed_at: null,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: null,
      blocked: null,
      history: [
        {
          timestamp: "2026-05-05T00:00:00Z",
          actor: "worker:auto-derive",
          event: "status_change",
          from: "Review",
          to: "ToDo",
        },
      ],
    };
    const out = healBlockedReferences(clean);
    expect(out).toBe(clean);
  });

  it("healBlockedReferences: heals an at-MAX v12 input with stale history (status untouched)", () => {
    const stale = {
      schema_version: 12,
      status: "Done",
      cancelled_at: null,
      completed_at: "2026-05-10T00:00:00Z",
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: null,
      blocked: null,
      history: [
        {
          timestamp: "2026-05-05T00:00:00Z",
          actor: "worker:auto-derive",
          event: "status_change",
          from: "ToDo",
          to: "Blocked",
        },
      ],
    };
    const out = healBlockedReferences(stale);
    expect(out).not.toBe(stale);
    expect(out.status).toBe("Done"); // unchanged — was already valid
    expect(out.schema_version).toBe(12); // never bumped — version-agnostic
    const history = out.history as Array<Record<string, unknown>>;
    expect(history[0].to).toBe("Done");
  });

  it("healBlockedReferences: walks history entries regardless of event type (defensive)", () => {
    // The helper checks `e.from === "Blocked"` / `e.to === "Blocked"`
    // unconditionally — a hand-crafted entry with a non-canonical
    // event still gets remapped if its from/to carry the legacy value.
    const stale = {
      schema_version: 12,
      status: "Review",
      cancelled_at: null,
      completed_at: null,
      ready_at: null,
      archived_at: null,
      dispatch: null,
      blocked: null,
      history: [
        {
          timestamp: "2026-05-05T00:00:00Z",
          actor: "operator",
          event: "comment",
          from: "Blocked",
          to: "ToDo",
        },
      ],
    };
    const out = healBlockedReferences(stale);
    const history = out.history as Array<Record<string, unknown>>;
    // Top-level projects to Review (no triggers) → Blocked remaps to Review
    expect(history[0].from).toBe("Review");
    expect(history[0].to).toBe("ToDo");
  });

  it("round-trips byte-stable on a v12 file with already-remapped history", () => {
    // After the first migration pass the resulting v12 object should be
    // a fixed point under any future repeat of the same logic: every
    // status value (top-level + history) is now a valid IssueStatus.
    const v11 = {
      schema_version: 11,
      status: "Blocked",
      cancelled_at: null,
      completed_at: null,
      ready_at: "2026-05-01T00:00:00Z",
      archived_at: null,
      dispatch: null,
      blocked: { reason: "r", at: "2026-05-05T00:00:00Z" },
      history: [
        {
          timestamp: "2026-05-05T00:00:00Z",
          actor: "worker:auto-derive",
          event: "status_change",
          from: "In Progress",
          to: "Blocked",
        },
      ],
    };
    const once = migrateV11ToV12(v11) as Record<string, unknown>;
    expect(once.status).toBe("ToDo");
    const history = once.history as Array<Record<string, unknown>>;
    expect(history[0].to).toBe("ToDo");
    // Stable JSON-shape under the projection
    expect(JSON.parse(JSON.stringify(once))).toEqual(once);
  });
});
