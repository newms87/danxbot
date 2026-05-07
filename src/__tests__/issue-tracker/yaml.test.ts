import { describe, it, expect } from "vitest";
import {
  createEmptyIssue,
  IssueParseError,
  parseIssue,
  serializeIssue,
  validateIssue,
} from "../../issue-tracker/yaml.js";
import { isTriaged } from "../../issue-tracker/interface.js";
import type { Issue } from "../../issue-tracker/interface.js";

function fullIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 3,
    tracker: "trello",
    id: "ISS-1",
    external_id: "card-1",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Do the thing",
    description: "A longer body",
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [{ check_item_id: "ac-1", title: "Returns 200", checked: false }],
    comments: [
      {
        id: "c-1",
        author: "alice",
        timestamp: "2026-05-01T12:00:00Z",
        text: "hi",
      },
      { author: "", timestamp: "", text: "local-only comment" },
    ],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    ...overrides,
  };
}

describe("serializeIssue / parseIssue", () => {
  it("round-trips a full issue with byte-identical output", () => {
    const issue = fullIssue();
    const yaml1 = serializeIssue(issue);
    const parsed = parseIssue(yaml1);
    expect(parsed).toEqual(issue);
    const yaml2 = serializeIssue(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips status: 'Needs Approval' (Phase 1 of auto-triage epic)", () => {
    // The new status must serialize, validate, and parse back without
    // schema rejection. Pinning here so a future enum-tightening change
    // can't silently drop the value.
    const issue = fullIssue({ status: "Needs Approval" });
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml);
    expect(parsed.status).toBe("Needs Approval");
    expect(serializeIssue(parsed)).toBe(yaml);
  });

  it("preserves null parent_id and dispatch through round-trip", () => {
    const issue = fullIssue({ parent_id: null, dispatch: null });
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml);
    expect(parsed.parent_id).toBeNull();
    expect(parsed.dispatch).toBeNull();
  });

  describe("blocked field", () => {
    it("round-trips blocked: null (default for unblocked cards)", () => {
      const issue = fullIssue({ blocked: null });
      const yaml = serializeIssue(issue);
      const parsed = parseIssue(yaml);
      expect(parsed.blocked).toBeNull();
      expect(serializeIssue(parsed)).toBe(yaml);
    });

    it("round-trips a populated blocked record byte-for-byte", () => {
      const issue = fullIssue({
        blocked: {
          reason: "waiting on ISS-99 to ship the migration",
          timestamp: "2026-05-04T18:00:00.000Z",
          by: ["ISS-99", "ISS-100"],
        },
      });
      const yaml = serializeIssue(issue);
      const parsed = parseIssue(yaml);
      expect(parsed.blocked).toEqual(issue.blocked);
      expect(serializeIssue(parsed)).toBe(yaml);
    });

    it("treats a missing blocked field as null on parse (back-compat for older YAMLs)", () => {
      const yamlNoBlocked = serializeIssue(fullIssue()).replace(
        /\nblocked:.*$/s,
        "\n",
      );
      // Sanity: stripped form really lacks the field.
      expect(yamlNoBlocked).not.toContain("blocked:");
      const parsed = parseIssue(yamlNoBlocked);
      expect(parsed.blocked).toBeNull();
    });

    it("rejects a blocked record missing reason", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "blocked: null\n",
        "blocked:\n  timestamp: t\n  by:\n    - ISS-1\n",
      );
      expect(() => parseIssue(yaml)).toThrow(/blocked\.reason/);
    });

    it("rejects a blocked record with empty by[]", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "blocked: null\n",
        "blocked:\n  reason: r\n  timestamp: t\n  by: []\n",
      );
      expect(() => parseIssue(yaml)).toThrow(
        /blocked\.by must contain at least one/,
      );
    });

    it("rejects a blocked.by entry that is not an ISS-N id", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "blocked: null\n",
        "blocked:\n  reason: r\n  timestamp: t\n  by:\n    - not-an-iss-id\n",
      );
      expect(() => parseIssue(yaml)).toThrow(
        /blocked\.by\[0\] must match ISS-/,
      );
    });
  });

  it("preserves string parent_id and dispatch record", () => {
    const issue = fullIssue({
      parent_id: "epic-100",
      dispatch: {
        id: "abc-uuid",
        pid: 12345,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-07T00:00:00Z",
        ttl_seconds: 600,
      },
    });
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml);
    expect(parsed.parent_id).toBe("epic-100");
    expect(parsed.dispatch).toEqual(issue.dispatch);
  });

  it("omits id field for local-only comments and preserves it for tracker-known comments", () => {
    const issue = fullIssue({
      comments: [
        { id: "remote-1", author: "alice", timestamp: "t", text: "remote" },
        { author: "", timestamp: "", text: "local" },
      ],
    });
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml);
    expect(parsed.comments[0].id).toBe("remote-1");
    expect(parsed.comments[1].id).toBeUndefined();
  });

  it("throws IssueParseError on malformed YAML", () => {
    expect(() => parseIssue(":\n  -\n :::")).toThrow(IssueParseError);
  });

  it("throws IssueParseError when required fields are missing", () => {
    const yaml = "schema_version: 3\ntracker: trello\n";
    expect(() => parseIssue(yaml)).toThrow(IssueParseError);
    expect(() => parseIssue(yaml)).toThrow(/external_id/);
  });

  it("rejects schema_version 1 with a migration pointer", () => {
    const yaml = "schema_version: 1\ntracker: trello\n";
    expect(() => parseIssue(yaml)).toThrow(/migrate-issues-to-v3/);
  });

  it("tolerates a legacy phases: [...] key on read and drops it on re-serialize (ISS-81)", () => {
    const legacyYaml = [
      "schema_version: 3",
      "tracker: trello",
      "id: ISS-1",
      'external_id: "ext-1"',
      "parent_id: null",
      "children: []",
      "dispatch: null",
      "status: ToDo",
      "type: Feature",
      "title: legacy",
      "description: body",
      "triage: { expires_at: '', reassess_hint: '', last_status: '', last_explain: '', ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] }",
      "ac: []",
      "phases:",
      "  - check_item_id: chk-1",
      "    title: Phase 1",
      "    status: Pending",
      '    notes: ""',
      "  - check_item_id: chk-2",
      "    title: Phase 2",
      "    status: Complete",
      '    notes: ""',
      "comments: []",
      "retro: { good: '', bad: '', action_item_ids: [], commits: [] }",
      "",
    ].join("\n");

    // Parse must succeed — legacy field is silently ignored.
    const issue = parseIssue(legacyYaml);
    expect(issue.id).toBe("ISS-1");
    // The Issue type no longer carries `phases`; assertion confirms it
    // never lands on the parsed object.
    expect("phases" in issue).toBe(false);

    // Round-trip: serialized form must NOT emit a `phases:` key.
    const out = serializeIssue(issue);
    expect(out).not.toMatch(/^phases:/m);
    // Re-parse round-trips clean.
    expect(() => parseIssue(out)).not.toThrow();
  });
});

describe("validateIssue", () => {
  // Build a minimal-but-fully-populated input. The validator is strict
  // (missing required fields are errors, not silently defaulted), so tests
  // start from this base and override the field they want to exercise.
  function valid(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      schema_version: 3,
      tracker: "trello",
      id: "ISS-42",
      external_id: "x1",
      parent_id: null,
      children: [],
      dispatch: null,
      status: "Review",
      type: "Bug",
      title: "T",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      ...overrides,
    };
  }

  it("succeeds on a minimal fully-populated issue", () => {
    const result = validateIssue(valid());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.ac).toEqual([]);
      expect(result.issue.comments).toEqual([]);
      expect(result.issue.retro).toEqual({
        good: "",
        bad: "",
        action_item_ids: [],
        commits: [],
      });
    }
  });

  it("reports every missing required field one-per-defect (strict)", () => {
    const result = validateIssue({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // After Fix 1 description, triage, ac, comments, retro are ALL
      // required (no silent defaults). `dispatch` is intentionally NOT
      // listed here — a missing field defaults to null at parse time
      // for back-compat with pre-rework YAMLs that pre-date the field
      // entirely. Validation enforces the structured shape only when
      // the field is present.
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("schema_version"),
          expect.stringContaining("tracker"),
          expect.stringContaining("id"),
          expect.stringContaining("external_id"),
          expect.stringContaining("parent_id"),
          expect.stringContaining("children"),
          expect.stringContaining("status"),
          expect.stringContaining("type"),
          expect.stringContaining("title"),
          expect.stringContaining("description"),
          expect.stringContaining("triage"),
          expect.stringContaining("ac"),
          expect.stringContaining("comments"),
          expect.stringContaining("retro"),
        ]),
      );
    }
  });

  it("rejects missing description specifically", () => {
    const input = valid();
    delete input.description;
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: description");
    }
  });

  it("rejects missing triage specifically", () => {
    const input = valid();
    delete input.triage;
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: triage");
    }
  });

  it("rejects a YAML carrying the legacy `triaged` field with a migration pointer", () => {
    const input = valid();
    delete input.triage;
    (input as Record<string, unknown>).triaged = {
      timestamp: "2026-04-01T00:00:00Z",
      status: "ToDo",
      explain: "legacy",
    };
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain(
        "Legacy `triaged` field is no longer supported",
      );
      expect(result.errors.join("\n")).toContain(
        "scripts/migrate-issues-to-triage-v3.ts",
      );
    }
  });

  it("rejects a YAML carrying the legacy `dispatch_id` field with a migration pointer", () => {
    const input = valid();
    (input as Record<string, unknown>).dispatch_id = "abc";
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain(
        "Legacy `dispatch_id` field is no longer supported",
      );
      expect(result.errors.join("\n")).toContain(
        "scripts/migrate-issues-to-triage-v3.ts",
      );
    }
  });

  it("rejects missing ac specifically", () => {
    const input = valid();
    delete input.ac;
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: ac");
    }
  });


  it("rejects missing comments specifically", () => {
    const input = valid();
    delete input.comments;
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: comments");
    }
  });

  it("rejects missing retro specifically", () => {
    const input = valid();
    delete input.retro;
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: retro");
    }
  });

  it("accepts empty external_id (memory tracker / pre-create draft)", () => {
    const result = validateIssue(valid({ external_id: "" }));
    expect(result.ok).toBe(true);
  });

  it("rejects empty id", () => {
    const result = validateIssue(valid({ id: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /id/.test(e))).toBe(true);
    }
  });

  it("rejects malformed id (wrong format)", () => {
    const result = validateIssue(valid({ id: "iss-1" })); // wrong case
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /ISS-/.test(e))).toBe(true);
    }
  });

  it("rejects invalid status enum", () => {
    const result = validateIssue(valid({ status: "Open" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /status/.test(e))).toBe(true);
    }
  });

  it("rejects invalid type enum", () => {
    const result = validateIssue(valid({ type: "Saga" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /type/.test(e))).toBe(true);
    }
  });


  it("rejects wrong types (array where string expected)", () => {
    const result = validateIssue(valid({ title: ["not", "a", "string"] }));
    expect(result.ok).toBe(false);
  });

  it("rejects ac as a string instead of list", () => {
    const result = validateIssue(valid({ ac: "nope" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /ac/.test(e))).toBe(true);
    }
  });

  // ---- Test gap E: pin exact validator error wording ----

  it("schema_version: 4 produces the exact error string", () => {
    const result = validateIssue(valid({ schema_version: 4 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("schema_version must be 3 (got 4)");
    }
  });

  it("schema_version: 1 produces the migration-pointer error string", () => {
    const result = validateIssue(valid({ schema_version: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes("migrate-issues-to-v3")),
      ).toBe(true);
    }
  });

  it("schema_version: 2 produces the migration-pointer error string", () => {
    const result = validateIssue(valid({ schema_version: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes("migrate-issues-to-v3")),
      ).toBe(true);
    }
  });

  it("empty tracker produces the exact error string", () => {
    const result = validateIssue(valid({ tracker: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("tracker must be a non-empty string");
    }
  });

  it("parent_id: 42 (number) produces the exact error string", () => {
    const result = validateIssue(valid({ parent_id: 42 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("parent_id must be a string or null");
    }
  });

  it("comments: [42] (non-object) produces the exact error string", () => {
    const result = validateIssue(valid({ comments: [42] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("comments[0] must be a mapping");
    }
  });

  it("rejects legacy retro.action_items with populated free-text strings", () => {
    const result = validateIssue(
      valid({
        retro: {
          good: "",
          bad: "",
          action_items: ["Migrate the X service", "Add tests for Y"],
          commits: [],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const msg = result.errors.find((e) =>
        e.includes("retro.action_items (legacy free-text shape)"),
      );
      expect(msg).toBeDefined();
      expect(msg).toContain("danx_issue_create");
      expect(msg).toContain("action_item_ids");
    }
  });

  it("accepts legacy retro.action_items: [] (empty) silently — no information lost", () => {
    const result = validateIssue(
      valid({
        retro: {
          good: "",
          bad: "",
          action_items: [],
          commits: [],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.retro.action_item_ids).toEqual([]);
    }
  });

  it("rejects retro.action_item_ids[i] not matching ISS-N format", () => {
    const result = validateIssue(
      valid({
        retro: {
          good: "",
          bad: "",
          action_item_ids: ["not-an-id"],
          commits: [],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) =>
          e.includes("retro.action_item_ids[0] must match ISS-"),
        ),
      ).toBe(true);
    }
  });
});

describe("children field (v3 epic → phase linkage)", () => {
  function valid(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      schema_version: 3,
      tracker: "trello",
      id: "ISS-100",
      external_id: "x1",
      parent_id: null,
      children: [],
      dispatch: null,
      status: "ToDo",
      type: "Epic",
      title: "T",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      ...overrides,
    };
  }

  it("requires the children field", () => {
    const input = valid();
    delete input.children;
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: children");
    }
  });

  it("accepts an empty children list", () => {
    const result = validateIssue(valid({ children: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.issue.children).toEqual([]);
  });

  it("accepts a list of valid ISS-N strings", () => {
    const result = validateIssue(
      valid({ children: ["ISS-101", "ISS-102", "ISS-103"] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.children).toEqual(["ISS-101", "ISS-102", "ISS-103"]);
    }
  });

  it("rejects children containing a non-string entry", () => {
    const result = validateIssue(valid({ children: ["ISS-101", 42] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /children\[1\]/.test(e))).toBe(true);
    }
  });

  it("rejects children containing a malformed id", () => {
    const result = validateIssue(valid({ children: ["iss-1"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /children\[0\]/.test(e) && /ISS-/.test(e)),
      ).toBe(true);
    }
  });

  it("rejects children as a string instead of a list", () => {
    const result = validateIssue(valid({ children: "ISS-1" }));
    expect(result.ok).toBe(false);
  });

  it("normalizes children: null to []", () => {
    // YAML parses a bare `children:` key (no value) as JS `null`. The
    // migration script and any hand-edited file may emit that shape, so
    // the validator MUST collapse null → empty array. Without this
    // branch every freshly-migrated YAML would re-trip the
    // missing-required-field error path.
    const result = validateIssue(valid({ children: null }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.children).toEqual([]);
    }
  });

  it("round-trips children through serialize → parse", () => {
    const issue = createEmptyIssue({ id: "ISS-1", title: "Epic" });
    issue.type = "Epic";
    issue.children = ["ISS-2", "ISS-3"];
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml);
    expect(parsed.children).toEqual(["ISS-2", "ISS-3"]);
  });
});

describe("schema_version 3 contract", () => {
  it("rejects schema_version 2 (must migrate)", () => {
    const yaml = "schema_version: 2\ntracker: trello\n";
    expect(() => parseIssue(yaml)).toThrow(/migrate-issues-to-v3/);
  });
});

describe("createEmptyIssue", () => {
  it("returns a fully-populated minimal Issue that passes validateIssue once id+title are seeded", () => {
    // `id` and `title` must be non-empty per the validator; everything
    // else (description, triaged, ac, comments, retro) is filled
    // in for free by createEmptyIssue. external_id may be empty.
    const issue = createEmptyIssue({ id: "ISS-1", title: "T" });
    const result = validateIssue(issue as unknown as Record<string, unknown>);
    expect(result.ok).toBe(true);
  });

  it("applies seeded fields without leaking missing required defaults", () => {
    const issue = createEmptyIssue({
      id: "ISS-7",
      external_id: "abc",
      status: "In Progress",
      type: "Bug",
      title: "Hello",
      description: "Body",
    });
    expect(issue.id).toBe("ISS-7");
    expect(issue.external_id).toBe("abc");
    expect(issue.status).toBe("In Progress");
    expect(issue.type).toBe("Bug");
    expect(issue.title).toBe("Hello");
    expect(issue.description).toBe("Body");
    expect(issue.parent_id).toBeNull();
    expect(issue.dispatch).toBeNull();
    expect(issue.ac).toEqual([]);
    expect(issue.comments).toEqual([]);
    expect(issue.retro).toEqual({
      good: "",
      bad: "",
      action_item_ids: [],
      commits: [],
    });
  });

  it("uses sensible defaults when no seed fields are provided", () => {
    const issue = createEmptyIssue();
    expect(issue.schema_version).toBe(3);
    expect(issue.tracker).toBe("memory");
    expect(issue.children).toEqual([]);
    expect(issue.status).toBe("ToDo");
    expect(issue.type).toBe("Feature");
    expect(issue.id).toBe("");
    expect(issue.external_id).toBe("");
    expect(issue.title).toBe("");
    expect(issue.description).toBe("");
  });
});

// ---- Test gap F: byte-stable serialized snapshot ----

describe("serializeIssue byte-stable snapshot", () => {
  it("produces deterministic YAML for a canonical fixture", () => {
    const fixture: Issue = {
      schema_version: 3,
      tracker: "trello",
      id: "ISS-99",
      external_id: "card-99",
      parent_id: null,
      children: ["ISS-100", "ISS-101"],
      dispatch: null,
      status: "In Progress",
      type: "Feature",
      title: "Canonical fixture",
      description: "First line of description.\nSecond line, with detail.",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [
        { check_item_id: "ac-1", title: "Returns 200", checked: false },
        { check_item_id: "ac-2", title: "Handles errors", checked: true },
      ],
      comments: [
        {
          id: "c-1",
          author: "alice",
          timestamp: "2026-05-01T12:00:00Z",
          text: "first comment",
        },
      ],
      retro: {
        good: "we shipped",
        bad: "took longer than expected",
        action_item_ids: ["ISS-100", "ISS-101"],
        commits: ["abc1234"],
      },
      blocked: null,
    };
    const serialized = serializeIssue(fixture);
    expect(serialized).toMatchInlineSnapshot(`
      "schema_version: 3
      tracker: trello
      id: ISS-99
      external_id: card-99
      parent_id: null
      children:
        - ISS-100
        - ISS-101
      dispatch: null
      status: In Progress
      type: Feature
      title: Canonical fixture
      description: |-
        First line of description.
        Second line, with detail.
      triage:
        expires_at: ""
        reassess_hint: ""
        last_status: ""
        last_explain: ""
        ice:
          total: 0
          i: 0
          c: 0
          e: 0
        history: []
      ac:
        - check_item_id: ac-1
          title: Returns 200
          checked: false
        - check_item_id: ac-2
          title: Handles errors
          checked: true
      comments:
        - id: c-1
          author: alice
          timestamp: 2026-05-01T12:00:00Z
          text: first comment
      retro:
        good: we shipped
        bad: took longer than expected
        action_item_ids:
          - ISS-100
          - ISS-101
        commits:
          - abc1234
      blocked: null
      "
    `);
  });
});

// ---- validateIssue: dispatch + triage branch coverage (ISS-91) ----

describe("validateIssue dispatch", () => {
  function withDispatch(value: unknown): Record<string, unknown> {
    const base = JSON.parse(JSON.stringify(fullIssue())) as Record<
      string,
      unknown
    >;
    base.dispatch = value;
    return base;
  }

  it("accepts dispatch: null explicitly", () => {
    const result = validateIssue(withDispatch(null));
    expect(result.ok).toBe(true);
  });

  it("accepts a fully-populated dispatch record", () => {
    const result = validateIssue(
      withDispatch({
        id: "abc-uuid",
        pid: 1234,
        host: "host.local",
        kind: "work",
        started_at: "2026-05-07T00:00:00Z",
        ttl_seconds: 60,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.dispatch?.id).toBe("abc-uuid");
      expect(result.issue.dispatch?.kind).toBe("work");
    }
  });

  it("accepts kind: 'triage' (Phase 2 forward-compat)", () => {
    const result = validateIssue(
      withDispatch({
        id: "x",
        pid: 0,
        host: "",
        kind: "triage",
        started_at: "",
        ttl_seconds: 0,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects empty-string dispatch.id", () => {
    const result = validateIssue(
      withDispatch({
        id: "",
        pid: 0,
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("dispatch.id must be a non-empty string");
    }
  });

  it("rejects non-string dispatch.id", () => {
    const result = validateIssue(
      withDispatch({
        id: 42,
        pid: 0,
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("dispatch.id must be a non-empty string");
    }
  });

  it("rejects non-number dispatch.pid", () => {
    const result = validateIssue(
      withDispatch({
        id: "x",
        pid: "1234",
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("dispatch.pid must be a number");
    }
  });

  it("rejects invalid dispatch.kind enum value", () => {
    const result = validateIssue(
      withDispatch({
        id: "x",
        pid: 0,
        host: "",
        kind: "wokr",
        started_at: "",
        ttl_seconds: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith("dispatch.kind must be one of")),
      ).toBe(true);
    }
  });

  it("rejects non-string dispatch.kind", () => {
    const result = validateIssue(
      withDispatch({
        id: "x",
        pid: 0,
        host: "",
        kind: 42,
        started_at: "",
        ttl_seconds: 0,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("dispatch.kind must be a string");
    }
  });

  it("rejects non-number dispatch.ttl_seconds", () => {
    const result = validateIssue(
      withDispatch({
        id: "x",
        pid: 0,
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: "60",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("dispatch.ttl_seconds must be a number");
    }
  });

  it("rejects empty dispatch object (missing required fields)", () => {
    const result = validateIssue(withDispatch({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // First missing field surfaces; subsequent checks short-circuit on
      // earlier failures, so we only assert SOMETHING was reported.
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects dispatch as a non-mapping (e.g. string)", () => {
    const result = validateIssue(withDispatch("not-an-object"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("dispatch must be a mapping or null");
    }
  });
});

describe("validateIssue triage", () => {
  function withTriage(value: unknown): Record<string, unknown> {
    const base = JSON.parse(JSON.stringify(fullIssue())) as Record<
      string,
      unknown
    >;
    base.triage = value;
    return base;
  }

  it("normalizes triage: null to a fully-empty IssueTriage", () => {
    const result = validateIssue(withTriage(null));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.triage).toEqual({
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      });
    }
  });

  it("rejects triage as a non-mapping", () => {
    const result = validateIssue(withTriage("not-an-object"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("triage must be a mapping");
    }
  });

  it("rejects non-string triage.expires_at", () => {
    const result = validateIssue(
      withTriage({
        expires_at: 42,
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("triage.expires_at must be a string");
    }
  });

  it("rejects non-number triage.ice.i", () => {
    const result = validateIssue(
      withTriage({
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: "1", c: 0, e: 0 },
        history: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("triage.ice.i must be a number");
    }
  });

  it("rejects triage.history as a non-array", () => {
    const result = validateIssue(
      withTriage({
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: "nope",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("triage.history must be a list");
    }
  });

  it("rejects history entry that isn't a mapping", () => {
    const result = validateIssue(
      withTriage({
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: ["not-an-object"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("triage.history[0] must be a mapping");
    }
  });

  it("silently slices triage.history beyond TRIAGE_HISTORY_CAP (10)", () => {
    const big = Array.from({ length: 13 }, (_, i) => ({
      timestamp: `t-${i}`,
      status: "Keep",
      explain: `decision ${i}`,
      expires_at: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
    }));
    const result = validateIssue(
      withTriage({
        expires_at: "",
        reassess_hint: "",
        last_status: "Keep",
        last_explain: "x",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: big,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Cap to 10; oldest entries (indices 0-2) dropped.
      expect(result.issue.triage.history).toHaveLength(10);
      expect(result.issue.triage.history[0].timestamp).toBe("t-3");
      expect(result.issue.triage.history[9].timestamp).toBe("t-12");
    }
  });

  it("round-trips a fully-populated triage with multiple history entries", () => {
    const populated: Issue = fullIssue({
      triage: {
        expires_at: "2026-05-08T00:00:00Z",
        reassess_hint: "if X has shipped, demote",
        last_status: "Confirm-Block",
        last_explain: "still waiting on prod deploy",
        ice: { total: 60, i: 4, c: 5, e: 3 },
        history: [
          {
            timestamp: "2026-05-01T00:00:00Z",
            status: "Keep",
            explain: "promising",
            expires_at: "2026-05-02T00:00:00Z",
            ice: { total: 30, i: 3, c: 5, e: 2 },
          },
          {
            timestamp: "2026-05-07T00:00:00Z",
            status: "Confirm-Block",
            explain: "still waiting on prod deploy",
            expires_at: "2026-05-08T00:00:00Z",
            ice: { total: 60, i: 4, c: 5, e: 3 },
          },
        ],
      },
    });
    const yaml = serializeIssue(populated);
    const parsed = parseIssue(yaml);
    expect(parsed).toEqual(populated);
  });
});

describe("isTriaged helper", () => {
  function tri(overrides: {
    last_status?: string;
    history?: Array<{
      timestamp: string;
      status: string;
      explain: string;
      expires_at: string;
      ice: { total: number; i: number; c: number; e: number };
    }>;
  } = {}) {
    return {
      expires_at: "",
      reassess_hint: "",
      last_status: overrides.last_status ?? "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: overrides.history ?? [],
    };
  }

  it("is false when last_status is empty AND history is empty", () => {
    expect(isTriaged(tri())).toBe(false);
  });

  it("is true when last_status is non-empty", () => {
    expect(isTriaged(tri({ last_status: "Keep" }))).toBe(true);
  });

  it("is true when history is non-empty (even with empty last_status — fallback path)", () => {
    expect(
      isTriaged(
        tri({
          history: [
            {
              timestamp: "t",
              status: "Keep",
              explain: "x",
              expires_at: "",
              ice: { total: 0, i: 0, c: 0, e: 0 },
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});
