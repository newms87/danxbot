import { describe, it, expect } from "vitest";
import {
  appendHistory,
  createEmptyIssue,
  HISTORY_CAP,
  HISTORY_NOTE_CAP,
  IssueHistoryAppendError,
  parseIssue,
  serializeIssue,
  validateIssue,
} from "../../issue-tracker/yaml.js";
import type {
  Issue,
  IssueHistoryEntry,
} from "../../issue-tracker/interface.js";

// ---------------------------------------------------------------------------
// Phase 1 of DX-138 / DX-145 — `Issue.history[]` schema lands on disk.
//
// These tests pin the on-disk shape: round-trip stability, validation rules,
// the 1000-entry rolling cap, and the `appendHistory` helper's note
// truncation. Phase 2 (worker write-paths) and Phase 3 (auto-mutation paths)
// consume the helper and add their own behaviour tests; this file owns the
// pure schema.
// ---------------------------------------------------------------------------

function fullIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 12,
    tracker: "trello",
    id: "ISS-1",
    external_id: "card-1",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Do the thing",
    description: "body",
    priority: 3.0,
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
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    ...overrides,
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };

}

describe("Issue.history round-trip", () => {
  it("round-trips a mixed-event history byte-identically", () => {
    const entries: IssueHistoryEntry[] = [
      {
        timestamp: "2026-05-08T03:14:22.500Z",
        actor: "dispatch:5b079a93-f937-4ada-8867-0b741ffcac09",
        event: "created",
        to: "ToDo",
      },
      {
        timestamp: "2026-05-08T03:20:11.812Z",
        actor: "dispatch:5b079a93-f937-4ada-8867-0b741ffcac09",
        event: "status_change",
        from: "ToDo",
        to: "In Progress",
      },
      {
        timestamp: "2026-05-08T03:42:01.144Z",
        actor: "worker:auto-derive",
        event: "status_change",
        from: "In Progress",
        to: "Done",
        note: "All children Done — derived per DX-98",
      },
      {
        timestamp: "2026-05-08T04:01:18.000Z",
        actor: "dashboard:dan",
        event: "blocked",
        to: "ToDo",
        note: "Blocked on DX-200",
      },
      {
        timestamp: "2026-05-08T04:30:00.000Z",
        actor: "worker:auto-derive",
        event: "unblocked",
      },
    ];
    const issue = fullIssue({ history: entries });
    const yaml1 = serializeIssue(issue);
    const parsed = parseIssue(yaml1, { expectedPrefix: "ISS" });
    expect(parsed.history).toEqual(entries);
    const yaml2 = serializeIssue(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("treats a missing history field as [] on parse (legacy YAMLs)", () => {
    const yamlNoHistory = serializeIssue(fullIssue()).replace(
      /\nhistory:.*?(?=\nretro:)/s,
      "\n",
    );
    expect(yamlNoHistory).not.toMatch(/^history:/m);
    const parsed = parseIssue(yamlNoHistory, { expectedPrefix: "ISS" });
    expect(parsed.history).toEqual([]);
  });

  it("emits `history` after `comments` and before `retro` (canonical order)", () => {
    const yaml = serializeIssue(fullIssue());
    const idxComments = yaml.indexOf("\ncomments:");
    const idxHistory = yaml.indexOf("\nhistory:");
    const idxRetro = yaml.indexOf("\nretro:");
    expect(idxComments).toBeGreaterThan(0);
    expect(idxHistory).toBeGreaterThan(idxComments);
    expect(idxRetro).toBeGreaterThan(idxHistory);
  });
});

describe("validateIssue history field", () => {
  it("rejects an entry with missing actor", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      // Target the OUTER history list (the inner `triage.history: []` shares
      // the literal but is indented under `triage:`). Anchor with `^…$m`
      // to match only the column-0 occurrence.
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    event: created",
        "    to: ToDo",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/history\[0\]\.actor/);
  });

  it("rejects an entry with empty actor string", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      // Target the OUTER history list (the inner `triage.history: []` shares
      // the literal but is indented under `triage:`). Anchor with `^…$m`
      // to match only the column-0 occurrence.
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: ''",
        "    event: created",
        "    to: ToDo",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/history\[0\]\.actor/);
  });

  it("rejects an entry with unknown event", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      // Target the OUTER history list (the inner `triage.history: []` shares
      // the literal but is indented under `triage:`). Anchor with `^…$m`
      // to match only the column-0 occurrence.
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: setup",
        "    event: deleted",
        "    to: ToDo",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/history\[0\]\.event/);
  });

  it("rejects an entry with non-string timestamp", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      // Target the OUTER history list (the inner `triage.history: []` shares
      // the literal but is indented under `triage:`). Anchor with `^…$m`
      // to match only the column-0 occurrence.
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: 12345",
        "    actor: setup",
        "    event: created",
        "    to: ToDo",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/history\[0\]\.timestamp/);
  });

  it("rejects an entry with non-IssueStatus value in `to`", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      // Target the OUTER history list (the inner `triage.history: []` shares
      // the literal but is indented under `triage:`). Anchor with `^…$m`
      // to match only the column-0 occurrence.
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: setup",
        "    event: created",
        "    to: NotAStatus",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/history\[0\]\.to/);
  });

  it("rejects an entry with non-IssueStatus value in `from`", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      // Target the OUTER history list (the inner `triage.history: []` shares
      // the literal but is indented under `triage:`). Anchor with `^…$m`
      // to match only the column-0 occurrence.
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: setup",
        "    event: status_change",
        "    from: Bogus",
        "    to: ToDo",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/history\[0\]\.from/);
  });

  it("rejects history field that is neither a list nor null", () => {
    // Catches the `!Array.isArray(value)` branch in validateHistory.
    // A hand-edited YAML with a stray scalar/object value here must fail
    // loud, not be silently coerced.
    const result = validateIssue({
      schema_version: 12,
      tracker: "trello",
      id: "ISS-1",
      external_id: "x",
      parent_id: null,
      children: [],
      dispatch: null,
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "",
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
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      history: "not-a-list",
    }, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("history must be a list");
    }
  });

  it("tolerates per-field nulls (`from: null`, `to: null`, `note: null`) on parse", () => {
    // Hand-edited YAMLs may emit explicit `null` for an absent optional;
    // the validator normalizes those back to `undefined`. A future tighten
    // that rejects null per-field would silently break legacy YAMLs.
    // Uses event=unblocked because that's the only event with no required
    // transition fields (status_change/created/blocked require `to`).
    const yaml = serializeIssue(fullIssue()).replace(
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: setup",
        "    event: unblocked",
        "    from: null",
        "    to: null",
        "    note: null",
      ].join("\n"),
    );
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.history.length).toBe(1);
    expect(parsed.history[0].from).toBeUndefined();
    expect(parsed.history[0].to).toBeUndefined();
    expect(parsed.history[0].note).toBeUndefined();
  });

  it("rejects status_change entry missing `from`", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: setup",
        "    event: status_change",
        "    to: ToDo",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
      /event=status_change requires both from and to/,
    );
  });

  it("rejects status_change entry missing `to`", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: setup",
        "    event: status_change",
        "    from: ToDo",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
      /event=status_change requires both from and to/,
    );
  });

  it("rejects created entry missing `to`", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: setup",
        "    event: created",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/event=created requires to/);
  });

  it("rejects blocked entry missing `to`", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: setup",
        "    event: blocked",
      ].join("\n"),
    );
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/event=blocked requires to/);
  });

  it("accepts unblocked entry without `to` (no required transition fields)", () => {
    const yaml = serializeIssue(fullIssue()).replace(
      /^history: \[\]$/m,
      [
        "history:",
        "  - timestamp: '2026-05-08T00:00:00Z'",
        "    actor: worker:auto-derive",
        "    event: unblocked",
      ].join("\n"),
    );
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.history[0].event).toBe("unblocked");
    expect(parsed.history[0].to).toBeUndefined();
  });

  it("normalizes history: null to []", () => {
    // The yaml lib emits `history: null` if a caller hand-edits the file; the
    // validator must tolerate it parallel to children/retro/triage. Anchor on
    // start-of-line to match only the OUTER history (inner `triage.history`
    // is indented 2 spaces).
    const yaml = serializeIssue(fullIssue()).replace(
      /^history: \[\]$/m,
      "history: null",
    );
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.history).toEqual([]);
  });
});

describe("serialize-side absence of optional fields", () => {
  it("omits `from`/`to`/`note` keys entirely when undefined (no synthetic null)", () => {
    // A regression that flips `if (h.from !== undefined)` to always-emit
    // would still pass deep-equal round-trip (validator tolerates `null`
    // and normalizes back to `undefined`), so we must inspect the YAML
    // string directly.
    const issue = fullIssue({
      history: [
        {
          timestamp: "2026-05-08T00:00:00Z",
          actor: "worker:auto-derive",
          event: "unblocked",
        },
      ],
    });
    const yaml = serializeIssue(issue);
    // Find the line range that belongs to the unblocked entry.
    const historyBlock = yaml.match(/^history:\n([\s\S]*?)(?=^retro:)/m)?.[1] ?? "";
    expect(historyBlock).toMatch(/timestamp:/);
    expect(historyBlock).toMatch(/actor: worker:auto-derive/);
    expect(historyBlock).toMatch(/event: unblocked/);
    // No synthetic keys for the undefined optionals.
    expect(historyBlock).not.toMatch(/^\s*from:/m);
    expect(historyBlock).not.toMatch(/^\s*to:/m);
    expect(historyBlock).not.toMatch(/^\s*note:/m);
  });
});

describe("history parse-side cap (rolling window)", () => {
  it("keeps every entry when count is exactly HISTORY_CAP (no slice at boundary)", () => {
    const entries = Array.from({ length: HISTORY_CAP }, (_, i) => ({
      timestamp: `t-${i}`,
      actor: "setup" as const,
      event: "created" as const,
      to: "ToDo" as const,
    }));
    const issue = fullIssue();
    issue.history = entries;
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.history.length).toBe(HISTORY_CAP);
    expect(parsed.history[0].timestamp).toBe("t-0");
    expect(parsed.history.at(-1)?.timestamp).toBe(`t-${HISTORY_CAP - 1}`);
  });

  it("drops exactly one entry when count is HISTORY_CAP + 1 (off-by-one guard)", () => {
    const entries = Array.from({ length: HISTORY_CAP + 1 }, (_, i) => ({
      timestamp: `t-${i}`,
      actor: "setup" as const,
      event: "created" as const,
      to: "ToDo" as const,
    }));
    const issue = fullIssue();
    issue.history = entries;
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.history.length).toBe(HISTORY_CAP);
    // Oldest dropped: index 0 was `t-0`; after one-entry slice, index 0 is `t-1`.
    expect(parsed.history[0].timestamp).toBe("t-1");
  });

  it("drops oldest entries when YAML carries more than HISTORY_CAP", () => {
    const overflow = HISTORY_CAP + 500;
    const entries: IssueHistoryEntry[] = Array.from(
      { length: overflow },
      (_, i) => ({
        timestamp: `2026-05-08T00:00:${String(i).padStart(2, "0")}Z`,
        actor: "setup",
        event: "created",
        to: "ToDo",
      }),
    );
    // We can't go through serializeIssue (which would call appendHistory's
    // helper if it pre-capped); instead build the YAML by hand around an
    // existing fullIssue and rely on validateIssue's parse-time cap.
    const issue = fullIssue();
    issue.history = entries;
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.history.length).toBe(HISTORY_CAP);
    // Oldest dropped, newest kept.
    expect(parsed.history[0].timestamp).toBe(
      `2026-05-08T00:00:${String(overflow - HISTORY_CAP).padStart(2, "0")}Z`,
    );
    expect(parsed.history.at(-1)?.timestamp).toBe(
      `2026-05-08T00:00:${String(overflow - 1).padStart(2, "0")}Z`,
    );
  });
});

describe("appendHistory helper", () => {
  it("returns [entry] when called with empty history (baseline)", () => {
    const out = appendHistory([], {
      timestamp: "t",
      actor: "setup",
      event: "created",
      to: "ToDo",
    });
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({
      timestamp: "t",
      actor: "setup",
      event: "created",
      to: "ToDo",
    });
  });

  it("does NOT slice when below HISTORY_CAP (length grows by exactly 1)", () => {
    const existing: IssueHistoryEntry[] = Array.from(
      { length: HISTORY_CAP - 1 },
      (_, i) => ({
        timestamp: `t-${i}`,
        actor: "setup",
        event: "created",
        to: "ToDo",
      }),
    );
    const out = appendHistory(existing, {
      timestamp: "t-new",
      actor: "worker:heal",
      event: "status_change",
      from: "ToDo",
      to: "In Progress",
    });
    expect(out.length).toBe(HISTORY_CAP);
    // Oldest preserved: no slice at the boundary.
    expect(out[0].timestamp).toBe("t-0");
    expect(out.at(-1)?.timestamp).toBe("t-new");
  });

  it("appends to the tail and applies the rolling cap", () => {
    const existing: IssueHistoryEntry[] = Array.from(
      { length: HISTORY_CAP },
      (_, i) => ({
        timestamp: `t-${i}`,
        actor: "setup",
        event: "created",
        to: "ToDo",
      }),
    );
    const next: IssueHistoryEntry = {
      timestamp: "t-new",
      actor: "worker:heal",
      event: "status_change",
      from: "ToDo",
      to: "In Progress",
    };
    const out = appendHistory(existing, next);
    expect(out.length).toBe(HISTORY_CAP);
    expect(out[0].timestamp).toBe("t-1"); // oldest dropped
    expect(out.at(-1)).toEqual(next); // new entry at tail
  });

  it("does not mutate the input array", () => {
    const existing: IssueHistoryEntry[] = [
      { timestamp: "t-0", actor: "setup", event: "created", to: "ToDo" },
    ];
    const out = appendHistory(existing, {
      timestamp: "t-1",
      actor: "worker:heal",
      event: "status_change",
      from: "ToDo",
      to: "In Progress",
    });
    expect(existing.length).toBe(1);
    expect(out.length).toBe(2);
    expect(out).not.toBe(existing);
  });

  it("truncates a long note to 197 chars + `…` (200 char total)", () => {
    const longNote = "x".repeat(250);
    const out = appendHistory([], {
      timestamp: "t",
      actor: "worker:auto-derive",
      event: "status_change",
      from: "ToDo",
      to: "In Progress",
      note: longNote,
    });
    expect(out[0].note?.length).toBe(HISTORY_NOTE_CAP);
    expect(out[0].note).toBe("x".repeat(HISTORY_NOTE_CAP - 1) + "…");
  });

  it("leaves a note of exactly HISTORY_NOTE_CAP chars unchanged (boundary)", () => {
    const exact = "y".repeat(HISTORY_NOTE_CAP);
    const out = appendHistory([], {
      timestamp: "t",
      actor: "worker:auto-derive",
      event: "status_change",
      from: "ToDo",
      to: "In Progress",
      note: exact,
    });
    expect(out[0].note).toBe(exact);
    expect(out[0].note?.length).toBe(HISTORY_NOTE_CAP);
  });

  it("truncates a note of HISTORY_NOTE_CAP + 1 chars (off-by-one guard)", () => {
    const overflow = "z".repeat(HISTORY_NOTE_CAP + 1);
    const out = appendHistory([], {
      timestamp: "t",
      actor: "worker:auto-derive",
      event: "status_change",
      from: "ToDo",
      to: "In Progress",
      note: overflow,
    });
    expect(out[0].note?.length).toBe(HISTORY_NOTE_CAP);
    expect(out[0].note).toBe("z".repeat(HISTORY_NOTE_CAP - 1) + "…");
  });

  it("leaves a short note unchanged", () => {
    const out = appendHistory([], {
      timestamp: "t",
      actor: "worker:auto-derive",
      event: "status_change",
      from: "ToDo",
      to: "In Progress",
      note: "short note",
    });
    expect(out[0].note).toBe("short note");
  });

  it("preserves entry without a note", () => {
    const out = appendHistory([], {
      timestamp: "t",
      actor: "setup",
      event: "created",
      to: "ToDo",
    });
    expect(out[0].note).toBeUndefined();
  });
});

describe("appendHistory actor-format enforcement", () => {
  // The interface JSDoc on IssueHistoryEntry.actor promises that format
  // enforcement happens at append-time only (parse-time stays permissive
  // so legacy YAMLs with future actor prefixes round-trip). These tests
  // pin the load-bearing implementation of that promise.

  it("accepts canonical <source>:<id> actors", () => {
    for (const actor of [
      "dispatch:5b079a93-f937-4ada-8867-0b741ffcac09",
      "dashboard:dan",
      "worker:auto-derive",
      "worker:heal",
      "tracker:trello",
    ]) {
      expect(() =>
        appendHistory([], {
          timestamp: "t",
          actor,
          event: "created",
          to: "ToDo",
        }),
      ).not.toThrow();
    }
  });

  it("accepts the bare grandfathered actors (`setup` and `unknown`)", () => {
    for (const actor of ["setup", "unknown"]) {
      expect(() =>
        appendHistory([], {
          timestamp: "t",
          actor,
          event: "created",
          to: "ToDo",
        }),
      ).not.toThrow();
    }
  });

  it("rejects an empty actor", () => {
    expect(() =>
      appendHistory([], {
        timestamp: "t",
        actor: "",
        event: "created",
        to: "ToDo",
      }),
    ).toThrow(IssueHistoryAppendError);
  });

  it("rejects an actor missing the `:` separator (non-grandfathered)", () => {
    expect(() =>
      appendHistory([], {
        timestamp: "t",
        actor: "danxbot", // not 'setup' or 'unknown'; no source prefix
        event: "created",
        to: "ToDo",
      }),
    ).toThrow(/actor must match/);
  });

  it("rejects an actor with empty source (`:dan`)", () => {
    expect(() =>
      appendHistory([], {
        timestamp: "t",
        actor: ":dan",
        event: "created",
        to: "ToDo",
      }),
    ).toThrow(IssueHistoryAppendError);
  });

  it("rejects an actor with empty id (`dashboard:`)", () => {
    expect(() =>
      appendHistory([], {
        timestamp: "t",
        actor: "dashboard:",
        event: "created",
        to: "ToDo",
      }),
    ).toThrow(IssueHistoryAppendError);
  });
});

describe("appendHistory per-event field invariants", () => {
  it("rejects a status_change entry missing `from`", () => {
    expect(() =>
      appendHistory([], {
        timestamp: "t",
        actor: "worker:auto-derive",
        event: "status_change",
        to: "Done",
      }),
    ).toThrow(/event=status_change requires both from and to/);
  });

  it("rejects a status_change entry missing `to`", () => {
    expect(() =>
      appendHistory([], {
        timestamp: "t",
        actor: "worker:auto-derive",
        event: "status_change",
        from: "ToDo",
      }),
    ).toThrow(/event=status_change requires both from and to/);
  });

  it("rejects a created entry missing `to`", () => {
    expect(() =>
      appendHistory([], {
        timestamp: "t",
        actor: "dispatch:abc",
        event: "created",
      }),
    ).toThrow(/event=created requires to/);
  });

  it("rejects a blocked entry missing `to`", () => {
    expect(() =>
      appendHistory([], {
        timestamp: "t",
        actor: "dashboard:dan",
        event: "blocked",
      }),
    ).toThrow(/event=blocked requires to/);
  });

  it("accepts an unblocked entry without `from` or `to`", () => {
    expect(() =>
      appendHistory([], {
        timestamp: "t",
        actor: "worker:auto-derive",
        event: "unblocked",
      }),
    ).not.toThrow();
  });
});

describe("pre-Phase-1 YAML migration side-effect", () => {
  it("a pre-Phase-1 YAML re-serializes with `history: []` between comments and retro on first save", () => {
    // Pre-Phase-1 YAMLs ship without `history:`. On the next save through
    // serializeIssue, the field appears in canonical position. This test
    // documents that one-shot diff explicitly so a future agent reading
    // sync logs knows to expect a single-line addition on every existing
    // card's first post-Phase-1 save.
    const legacyYaml = [
      "schema_version: 11",
      "tracker: trello",
      "id: ISS-1",
      "external_id: x",
      "parent_id: null",
      "children: []",
      "dispatch: null",
      "status: ToDo",
      "type: Feature",
      "title: legacy card",
      "description: body",
      "priority: 3.0",
      "triage:",
      "  expires_at: ''",
      "  reassess_hint: ''",
      "  last_status: ''",
      "  last_explain: ''",
      "  ice:",
      "    total: 0",
      "    i: 0",
      "    c: 0",
      "    e: 0",
      "  history: []",
      "ac: []",
      "comments: []",
      "retro:",
      "  good: ''",
      "  bad: ''",
      "  action_item_ids: []",
      "  commits: []",
      "blocked: null",
      "",
    ].join("\n");
    expect(legacyYaml).not.toMatch(/^history:/m);
    const parsed = parseIssue(legacyYaml, { expectedPrefix: "ISS" });
    expect(parsed.history).toEqual([]);
    const reSerialized = serializeIssue(parsed);
    // The one-shot diff: history: [] now appears between comments: and retro:.
    expect(reSerialized).toMatch(/\ncomments: \[\]\nhistory: \[\]\nretro:/);
  });
});

describe("createEmptyIssue history default", () => {
  it("defaults `history: []` so the resulting Issue is valid out of the box", () => {
    // Phase 2 callers use createEmptyIssue as the entry point for fresh
    // hydrated cards; if the default flips, the validator's now-required
    // `history` invariant breaks orphan adoption. Cheap insurance.
    const issue = createEmptyIssue({ id: "ISS-1", title: "T" });
    expect(issue.history).toEqual([]);
    const result = validateIssue(issue as unknown as Record<string, unknown>, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(true);
  });
});
