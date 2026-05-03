import { describe, it, expect } from "vitest";
import {
  createEmptyIssue,
  IssueParseError,
  parseIssue,
  serializeIssue,
  validateIssue,
} from "../../issue-tracker/yaml.js";
import type { Issue } from "../../issue-tracker/interface.js";

function fullIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 1,
    tracker: "trello",
    external_id: "card-1",
    parent_id: null,
    dispatch_id: null,
    status: "ToDo",
    type: "Feature",
    title: "Do the thing",
    description: "A longer body",
    triaged: { timestamp: "", status: "", explain: "" },
    ac: [
      { check_item_id: "ac-1", title: "Returns 200", checked: false },
    ],
    phases: [
      {
        check_item_id: "ph-1",
        title: "Wire it up",
        status: "Pending",
        notes: "be careful with X",
      },
    ],
    comments: [
      { id: "c-1", author: "alice", timestamp: "2026-05-01T12:00:00Z", text: "hi" },
      { author: "", timestamp: "", text: "local-only comment" },
    ],
    retro: { good: "", bad: "", action_items: [], commits: [] },
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

  it("preserves null parent_id and dispatch_id through round-trip", () => {
    const issue = fullIssue({ parent_id: null, dispatch_id: null });
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml);
    expect(parsed.parent_id).toBeNull();
    expect(parsed.dispatch_id).toBeNull();
  });

  it("preserves string parent_id and dispatch_id", () => {
    const issue = fullIssue({
      parent_id: "epic-100",
      dispatch_id: "abc-uuid",
    });
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml);
    expect(parsed.parent_id).toBe("epic-100");
    expect(parsed.dispatch_id).toBe("abc-uuid");
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
    const yaml = "schema_version: 1\ntracker: trello\n";
    expect(() => parseIssue(yaml)).toThrow(IssueParseError);
    expect(() => parseIssue(yaml)).toThrow(/external_id/);
  });
});

describe("validateIssue", () => {
  // Build a minimal-but-fully-populated input. The validator is strict
  // (missing required fields are errors, not silently defaulted), so tests
  // start from this base and override the field they want to exercise.
  function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: 1,
      tracker: "trello",
      external_id: "x1",
      parent_id: null,
      dispatch_id: null,
      status: "Review",
      type: "Bug",
      title: "T",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
      ...overrides,
    };
  }

  it("succeeds on a minimal fully-populated issue", () => {
    const result = validateIssue(valid());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.ac).toEqual([]);
      expect(result.issue.phases).toEqual([]);
      expect(result.issue.comments).toEqual([]);
      expect(result.issue.retro).toEqual({
        good: "",
        bad: "",
        action_items: [],
        commits: [],
      });
    }
  });

  it("reports every missing required field one-per-defect (strict)", () => {
    const result = validateIssue({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // After Fix 1 description, triaged, ac, phases, comments, retro are
      // ALL required (no silent defaults).
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("schema_version"),
          expect.stringContaining("tracker"),
          expect.stringContaining("external_id"),
          expect.stringContaining("parent_id"),
          expect.stringContaining("dispatch_id"),
          expect.stringContaining("status"),
          expect.stringContaining("type"),
          expect.stringContaining("title"),
          expect.stringContaining("description"),
          expect.stringContaining("triaged"),
          expect.stringContaining("ac"),
          expect.stringContaining("phases"),
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

  it("rejects missing triaged specifically", () => {
    const input = valid();
    delete input.triaged;
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: triaged");
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

  it("rejects missing phases specifically", () => {
    const input = valid();
    delete input.phases;
    const result = validateIssue(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: phases");
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

  it("rejects empty external_id", () => {
    const result = validateIssue(valid({ external_id: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /external_id/.test(e))).toBe(true);
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

  it("rejects invalid phase status", () => {
    const result = validateIssue(
      valid({
        phases: [{ check_item_id: "p1", title: "x", status: "Wibble", notes: "" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /phases\[0\]\.status/.test(e))).toBe(true);
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

  it("schema_version: 2 produces the exact error string", () => {
    const result = validateIssue(valid({ schema_version: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("schema_version must be 1 (got 2)");
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

  it("parseIssue throws IssueParseError when YAML source carries '→' in retro.action_items", () => {
    const yaml = `schema_version: 1
tracker: trello
external_id: x1
parent_id: null
dispatch_id: null
status: ToDo
type: Feature
title: T
description: ""
triaged:
  timestamp: ""
  status: ""
  explain: ""
ac: []
phases: []
comments: []
retro:
  good: ""
  bad: ""
  action_items:
    - "broken → already-spawned"
  commits: []
`;
    expect(() => parseIssue(yaml)).toThrow(/'→'/);
  });

  it("rejects retro.action_items entries containing the '→' separator", () => {
    const result = validateIssue(
      valid({
        retro: {
          good: "",
          bad: "",
          action_items: ["legit", "broken → already-spawned"],
          commits: [],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) =>
          e.includes("retro.action_items[1]") && e.includes("→"),
        ),
        `expected '→' rejection error; got ${JSON.stringify(result.errors)}`,
      ).toBe(true);
    }
  });
});

describe("createEmptyIssue", () => {
  it("returns a fully-populated minimal Issue that passes validateIssue once external_id+title are seeded", () => {
    // external_id and title must be non-empty per the validator; everything
    // else (description, triaged, ac, phases, comments, retro) is filled in
    // for free by createEmptyIssue.
    const issue = createEmptyIssue({ external_id: "x", title: "T" });
    const result = validateIssue(issue as unknown as Record<string, unknown>);
    expect(result.ok).toBe(true);
  });

  it("applies seeded fields without leaking missing required defaults", () => {
    const issue = createEmptyIssue({
      external_id: "abc",
      status: "In Progress",
      type: "Bug",
      title: "Hello",
      description: "Body",
    });
    expect(issue.external_id).toBe("abc");
    expect(issue.status).toBe("In Progress");
    expect(issue.type).toBe("Bug");
    expect(issue.title).toBe("Hello");
    expect(issue.description).toBe("Body");
    expect(issue.parent_id).toBeNull();
    expect(issue.dispatch_id).toBeNull();
    expect(issue.ac).toEqual([]);
    expect(issue.phases).toEqual([]);
    expect(issue.comments).toEqual([]);
    expect(issue.retro).toEqual({
      good: "",
      bad: "",
      action_items: [],
      commits: [],
    });
  });

  it("uses sensible defaults when no seed fields are provided", () => {
    const issue = createEmptyIssue();
    expect(issue.schema_version).toBe(1);
    expect(issue.tracker).toBe("memory");
    expect(issue.status).toBe("ToDo");
    expect(issue.type).toBe("Feature");
    expect(issue.external_id).toBe("");
    expect(issue.title).toBe("");
    expect(issue.description).toBe("");
  });
});

// ---- Test gap F: byte-stable serialized snapshot ----

describe("serializeIssue byte-stable snapshot", () => {
  it("produces deterministic YAML for a canonical fixture", () => {
    const fixture: Issue = {
      schema_version: 1,
      tracker: "trello",
      external_id: "card-99",
      parent_id: null,
      dispatch_id: null,
      status: "In Progress",
      type: "Feature",
      title: "Canonical fixture",
      description: "First line of description.\nSecond line, with detail.",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [
        { check_item_id: "ac-1", title: "Returns 200", checked: false },
        { check_item_id: "ac-2", title: "Handles errors", checked: true },
      ],
      phases: [
        {
          check_item_id: "ph-1",
          title: "Wire it up",
          status: "Pending",
          notes: "watch out for X",
        },
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
        action_items: ["follow-up A", "follow-up B"],
        commits: ["abc1234"],
      },
    };
    const serialized = serializeIssue(fixture);
    expect(serialized).toMatchInlineSnapshot(`
      "schema_version: 1
      tracker: trello
      external_id: card-99
      parent_id: null
      dispatch_id: null
      status: In Progress
      type: Feature
      title: Canonical fixture
      description: |-
        First line of description.
        Second line, with detail.
      triaged:
        timestamp: ""
        status: ""
        explain: ""
      ac:
        - check_item_id: ac-1
          title: Returns 200
          checked: false
        - check_item_id: ac-2
          title: Handles errors
          checked: true
      phases:
        - check_item_id: ph-1
          title: Wire it up
          status: Pending
          notes: watch out for X
      comments:
        - id: c-1
          author: alice
          timestamp: 2026-05-01T12:00:00Z
          text: first comment
      retro:
        good: we shipped
        bad: took longer than expected
        action_items:
          - follow-up A
          - follow-up B
        commits:
          - abc1234
      "
    `);
  });
});
