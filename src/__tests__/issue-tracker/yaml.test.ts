import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildIssueIdRegex,
  createEmptyIssue,
  IssueParseError,
  KNOWN_SCHEMA_MAX,
  parseIssue as parseIssueRaw,
  serializeIssue,
  validateIssue as validateIssueRaw,
} from "../../issue-tracker/yaml.js";
import type { ParseIssueOptions } from "../../issue-tracker/yaml.js";

// Phase 4 of DX-99 made `expectedPrefix` required on every parse /
// validate call. The fixtures in this file are all `ISS-N`-shaped
// (legacy literal), so default the helper to `"ISS"` and let the few
// non-ISS tests pass an override.
const ISS_OPTS: ParseIssueOptions = { expectedPrefix: "ISS" };
function parseIssue(text: string, options: ParseIssueOptions = ISS_OPTS) {
  return parseIssueRaw(text, options);
}
function validateIssue(value: unknown, options: ParseIssueOptions = ISS_OPTS) {
  return validateIssueRaw(value, options);
}
import { isTriaged } from "../../issue-tracker/interface.js";
import type { Issue } from "../../issue-tracker/interface.js";

function fullIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 11,
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
    priority: 3.0,
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
    assigned_agent: null,
    waiting_on: null,
    requires_human: null,
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

describe("serializeIssue / parseIssue", () => {
  it("round-trips a full issue with byte-identical output", () => {
    const issue = fullIssue();
    const yaml1 = serializeIssue(issue);
    const parsed = parseIssue(yaml1, { expectedPrefix: "ISS" });
    expect(parsed).toEqual(issue);
    const yaml2 = serializeIssue(parsed);
    expect(yaml2).toBe(yaml1);
  });

  describe("position field — DROPPED in DX-628 (v10 → v11)", () => {
    it("serializeIssue never emits a `position:` key on a v11 issue", () => {
      const yaml = serializeIssue(fullIssue());
      expect(yaml).not.toMatch(/^position:/m);
    });

    it("parseIssue silently tolerates a stray `position:` key (forward-compat with unknown future fields, drop on round-trip)", () => {
      // After DX-628 ships, no on-disk YAML should carry `position` —
      // the boot sweep migrates everything forward. Defense-in-depth:
      // if a hand-edit or stale writer slips a `position` key into a
      // v11 file, parseIssue accepts it (the validator only rejects
      // unknown REQUIRED fields, not arbitrary extra keys) and
      // re-serialize drops it.
      const yaml = serializeIssue(fullIssue()) + "position: 4.25\n";
      const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
      expect("position" in parsed).toBe(false);
      const reEmitted = serializeIssue(parsed);
      expect(reEmitted).not.toMatch(/^position:/m);
    });

    it("createEmptyIssue never carries a position field on v11", () => {
      const issue = createEmptyIssue();
      expect("position" in issue).toBe(false);
    });
  });

  describe("requires_human field (DX-231 — orthogonal 'needs human action' indicator)", () => {
    it("round-trips requires_human: null (default for cards needing no human action)", () => {
      const issue = fullIssue({ requires_human: null });
      const yaml = serializeIssue(issue);
      const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
      expect(parsed.requires_human).toBeNull();
      expect(serializeIssue(parsed)).toBe(yaml);
    });

    it("round-trips a populated requires_human record byte-for-byte", () => {
      const issue = fullIssue({
        requires_human: {
          reason: "Need Stripe API key rotated",
          steps: [
            "Log into Stripe → API keys → Roll secret",
            "Update DANX_STRIPE_KEY in <repo>/.danxbot/.env",
            "Redeploy worker; toggle off this flag",
          ],
          set_by: "agent",
          set_at: "2026-05-10T12:00:00.000Z",
        },
      });
      const yaml = serializeIssue(issue);
      const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
      expect(parsed.requires_human).toEqual(issue.requires_human);
      expect(serializeIssue(parsed)).toBe(yaml);
    });

    it("treats a missing requires_human field as null on parse (back-compat for older YAMLs)", () => {
      // Cards predating DX-231 (schema_version 5 and earlier) omit the
      // field entirely. The parser must default `null` so legacy YAMLs
      // round-trip cleanly through the v6 loader.
      const yamlNoRequiresHuman = serializeIssue(fullIssue()).replace(
        /\nrequires_human:.*$/s,
        "\n",
      );
      expect(yamlNoRequiresHuman).not.toContain("requires_human:");
      const parsed = parseIssue(yamlNoRequiresHuman, { expectedPrefix: "ISS" });
      expect(parsed.requires_human).toBeNull();
    });

    it("rejects a requires_human record missing reason", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "requires_human: null\n",
        "requires_human:\n  steps: []\n  set_by: agent\n  set_at: t\n",
      );
      expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
        /requires_human\.reason/,
      );
    });

    it("rejects a requires_human record with a non-string step", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "requires_human: null\n",
        "requires_human:\n  reason: r\n  steps:\n    - 5\n  set_by: agent\n  set_at: t\n",
      );
      expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
        /requires_human\.steps\[0\]/,
      );
    });

    it("rejects a requires_human record with an invalid set_by value", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "requires_human: null\n",
        "requires_human:\n  reason: r\n  steps: []\n  set_by: robot\n  set_at: t\n",
      );
      expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
        /requires_human\.set_by/,
      );
    });

    it("rejects a requires_human record where steps is not an array", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "requires_human: null\n",
        'requires_human:\n  reason: r\n  steps: "not-a-list"\n  set_by: agent\n  set_at: t\n',
      );
      expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
        /requires_human\.steps must be a list of strings/,
      );
    });

    it("rejects a requires_human record with missing set_at", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "requires_human: null\n",
        "requires_human:\n  reason: r\n  steps: []\n  set_by: agent\n",
      );
      expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
        /requires_human\.set_at/,
      );
    });

    it("rejects a requires_human record with empty set_at", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "requires_human: null\n",
        'requires_human:\n  reason: r\n  steps: []\n  set_by: agent\n  set_at: ""\n',
      );
      expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
        /requires_human\.set_at must be a non-empty string/,
      );
    });

    it("rejects a requires_human field that is a primitive (not null or mapping)", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "requires_human: null\n",
        "requires_human: not-a-mapping\n",
      );
      expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
        /requires_human must be a mapping or null/,
      );
    });

    it("accepts requires_human alongside status: Blocked + blocked record (orthogonal field; DX-231)", () => {
      // The orthogonal "needs human" field MUST be permitted alongside
      // a self-block — they are independent dispatch gates that may
      // co-exist. A regression that adds an inadvertent invariant
      // (`requires_human != null ⟹ status: Review`-style) ships
      // unchallenged without this case.
      const issue = fullIssue({
        status: "Blocked",
        blocked: {
          reason: "self-blocked",
          at: "2026-05-10T00:00:00.000Z",
        },
        requires_human: {
          reason: "Need 3rd-party Stripe key rotation",
          steps: ["Rotate the secret in Stripe", "Update DANX_STRIPE_KEY"],
          set_by: "agent",
          set_at: "2026-05-10T12:00:00.000Z",
        },
      });
      const yaml1 = serializeIssue(issue);
      const parsed = parseIssue(yaml1, { expectedPrefix: "ISS" });
      expect(parsed).toEqual(issue);
      expect(serializeIssue(parsed)).toBe(yaml1);
    });

    it("accepts requires_human alongside status: ToDo + waiting_on record", () => {
      const issue = fullIssue({
        status: "ToDo",
        waiting_on: {
          reason: "Waiting on ISS-99 to ship",
          timestamp: "2026-05-09T00:00:00.000Z",
          by: ["ISS-99"],
        },
        requires_human: {
          reason: "Operator must clear the matching design ambiguity",
          steps: ["Read design doc DX-200", "Choose option A or B"],
          set_by: "agent",
          set_at: "2026-05-10T12:00:00.000Z",
        },
      });
      const yaml1 = serializeIssue(issue);
      const parsed = parseIssue(yaml1, { expectedPrefix: "ISS" });
      expect(parsed).toEqual(issue);
      expect(serializeIssue(parsed)).toBe(yaml1);
    });

    it("schema_version: 5 is now rejected — pre-MIN versions belong to the boot sweep, not the validator (DX-628)", () => {
      // Pre-DX-592 the validator silently accepted v3..v9; the single-
      // version tolerance window (MIN=10, MAX=11 after DX-628) tightens
      // that to the immediate predecessor + canonical only. Older
      // files are migrated forward by the boot sweep before they ever
      // reach the validator; a v5 file arriving in-process is a
      // programming error.
      const yaml1 = serializeIssue(fullIssue()).replace(
        "schema_version: 11",
        "schema_version: 5",
      );
      expect(() => parseIssue(yaml1, { expectedPrefix: "ISS" })).toThrow(
        /schema_version must be an integer >= 10/,
      );
    });

    it('parseIssue rejects status: "Needs Approval" via the canonical status enum check (DX-594)', () => {
      // DX-231 retired the parking status; DX-594 dropped the bespoke
      // migration-pointer error in favour of the generic enum-mismatch
      // path. The status field still rejects fail-loud, just without
      // the DX-231-specific pointer message.
      const yaml = serializeIssue(fullIssue()).replace(
        "status: ToDo\n",
        "status: Needs Approval\n",
      );
      expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
        /status must be one of/,
      );
    });
  });

  it("round-trips status: ToDo + waiting_on byte-stable", () => {
    // The canonical compliant shape under the new parser invariant. A
    // serialize → parse → re-serialize chain MUST be byte-identical so
    // `waiting_on != null + status: ToDo` round-trips without normalization
    // surprises (no field gets dropped, no field gets reordered).
    const issue = fullIssue({
      status: "ToDo",
      waiting_on: {
        reason: "Waiting on ISS-99 to ship",
        timestamp: "2026-05-09T00:00:00.000Z",
        by: ["ISS-99"],
      },
    });
    const yaml1 = serializeIssue(issue);
    const parsed = parseIssue(yaml1, { expectedPrefix: "ISS" });
    expect(parsed).toEqual(issue);
    const yaml2 = serializeIssue(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("preserves null parent_id and dispatch through round-trip", () => {
    const issue = fullIssue({ parent_id: null, dispatch: null });
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.parent_id).toBeNull();
    expect(parsed.dispatch).toBeNull();
  });

  describe("blocked field (self-block)", () => {
    it("round-trips blocked: null (default for unblocked cards)", () => {
      const issue = fullIssue({ blocked: null });
      const yaml = serializeIssue(issue);
      const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
      expect(parsed.blocked).toBeNull();
      expect(serializeIssue(parsed)).toBe(yaml);
    });

    it("round-trips a populated blocked record byte-for-byte", () => {
      const issue = fullIssue({
        status: "Blocked",
        blocked: {
          reason: "Blocked on external dependency",
          at: "2026-05-04T18:00:00.000Z",
        },
      });
      const yaml = serializeIssue(issue);
      const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
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
      const parsed = parseIssue(yamlNoBlocked, { expectedPrefix: "ISS" });
      expect(parsed.blocked).toBeNull();
    });

    it("rejects a blocked record missing reason", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "blocked: null\n",
        "blocked:\n  timestamp: t\n",
      );
      expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/blocked\.reason/);
    });

    it("rejects a blocked record with unexpected 'by' field (v10 has only reason + at)", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "blocked: null\n",
        "blocked:\n  reason: r\n  at: t\n  by:\n    - ISS-1\n",
      );
      // v10 invariant: the self-block field has no `by[]` (that's `waiting_on.by`).
      // Parser fails loud so a half-migrated YAML doesn't silently round-trip.
      expect(() => parseIssue(yaml)).toThrow(/blocked must NOT carry 'by'/);
    });

    it("rejects a blocked record missing the `at` field (v10 — DX-592 renamed from `timestamp`)", () => {
      const yaml = serializeIssue(fullIssue()).replace(
        "blocked: null\n",
        "blocked:\n  reason: r\n",
      );
      expect(() => parseIssue(yaml)).toThrow(/blocked\.at/);
    });
  });

  it("preserves string parent_id and dispatch record", () => {
    const issue = fullIssue({
      parent_id: "ISS-100",
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
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.parent_id).toBe("ISS-100");
    expect(parsed.dispatch).toEqual(issue.dispatch);
  });

  it("rejects parent_id that does not match the expected prefix shape", () => {
    // ISS-99 Phase 1: the validator now enforces the per-repo `<PREFIX>-<N>`
    // shape on parent_id, same as id / children / blocked.by /
    // retro.action_item_ids. Foreign-prefix or free-text parent_ids would
    // silently break Phase 2's threading of `expectedPrefix` if not caught
    // here.
    const issue = fullIssue();
    const result = validateIssue({ ...issue, parent_id: "epic-100" }, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /parent_id/.test(e))).toBe(true);
    }
  });

  it("omits id field for local-only comments and preserves it for tracker-known comments", () => {
    const issue = fullIssue({
      comments: [
        { id: "remote-1", author: "alice", timestamp: "t", text: "remote" },
        { author: "", timestamp: "", text: "local" },
      ],
    });
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.comments[0].id).toBe("remote-1");
    expect(parsed.comments[1].id).toBeUndefined();
  });

  it("throws IssueParseError on malformed YAML", () => {
    expect(() => parseIssue(":\n  -\n :::", { expectedPrefix: "ISS" })).toThrow(IssueParseError);
  });

  it("throws IssueParseError when required fields are missing", () => {
    const yaml = "schema_version: 3\ntracker: trello\n";
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(IssueParseError);
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(/external_id/);
  });

  it("rejects schema_version 1 with the canonical < MIN error (no migration-script pointer)", () => {
    // DX-594 dropped the bespoke v1/v2 migration-pointer branch in
    // favour of the canonical < KNOWN_SCHEMA_MIN error. The boot sweep
    // handles forward migration end-to-end; the validator just rejects
    // anything older than MIN with a single uniform message. DX-595
    // retired the migration scripts themselves.
    const yaml = "schema_version: 1\ntracker: trello\n";
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
      /schema_version must be an integer >= 10/,
    );
  });

  it("tolerates a prior `phases: [...]` key on read and drops it on re-serialize (ISS-81)", () => {
    const legacyYaml = [
      "schema_version: 11",
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
      "priority: 3.0",
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
    const issue = parseIssue(legacyYaml, { expectedPrefix: "ISS" });
    expect(issue.id).toBe("ISS-1");
    // The Issue type no longer carries `phases`; assertion confirms it
    // never lands on the parsed object.
    expect("phases" in issue).toBe(false);

    // Round-trip: serialized form must NOT emit a `phases:` key.
    const out = serializeIssue(issue);
    expect(out).not.toMatch(/^phases:/m);
    // Re-parse round-trips clean.
    expect(() => parseIssue(out, { expectedPrefix: "ISS" })).not.toThrow();
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
      schema_version: 11,
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
      priority: 3.0,
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      ...overrides,
    };
  }

  it("succeeds on a minimal fully-populated issue", () => {
    const result = validateIssue(valid(), { expectedPrefix: "ISS" });
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
    const result = validateIssue({}, { expectedPrefix: "ISS" });
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
          expect.stringContaining("priority"),
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
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: description");
    }
  });

  it("rejects missing triage specifically", () => {
    const input = valid();
    delete input.triage;
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: triage");
    }
  });

  it("rejects missing priority specifically (DX-594 — strict canonical reader)", () => {
    const input = valid();
    delete input.priority;
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: priority");
    }
  });

  it("silently drops a stale `triaged` key without inventing a triage record (DX-594)", () => {
    // DX-594 dropped the bespoke `triaged` migration-pointer rejection.
    // The boot sweep guarantees no on-disk YAML carries the flat block,
    // so an in-memory input with `triaged` but no `triage` is treated
    // as a missing triage field (canonical required-field error fires).
    // Anything that does have `triage` parses successfully and the
    // `triaged` key drops silently via the canonical writer key set.
    const input = valid();
    (input as Record<string, unknown>).triaged = {
      timestamp: "2026-04-01T00:00:00Z",
      status: "ToDo",
      explain: "stale flat block",
    };
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The proper `triage` record (still present on `input`) wins; the
      // stale `triaged` block leaves no trace on the built Issue.
      expect(result.issue.triage.expires_at).toBe("");
    }
  });

  it("when ONLY `triaged` is present and `triage` is absent, fires canonical `missing required field: triage` (DX-594)", () => {
    // Locks the fall-through path: the bespoke "Legacy `triaged` is no
    // longer supported" pointer was deleted; a YAML with ONLY the flat
    // block now hits the generic required-field check instead.
    const input = valid();
    delete input.triage;
    (input as Record<string, unknown>).triaged = {
      timestamp: "2026-04-01T00:00:00Z",
      status: "ToDo",
      explain: "stale flat block, no canonical triage",
    };
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: triage");
    }
  });

  it("silently drops a stale `dispatch_id` key (DX-594)", () => {
    // DX-594 dropped the bespoke legacy rejection. An unknown top-level
    // key is silently dropped on the write side via the canonical key
    // set in `serializeIssue`; on read the validator ignores it.
    const input = valid();
    (input as Record<string, unknown>).dispatch_id = "abc";
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.dispatch).toBeNull();
    }
  });

  it("rejects missing ac specifically", () => {
    const input = valid();
    delete input.ac;
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: ac");
    }
  });


  it("rejects missing comments specifically", () => {
    const input = valid();
    delete input.comments;
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: comments");
    }
  });

  it("rejects missing retro specifically", () => {
    const input = valid();
    delete input.retro;
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: retro");
    }
  });

  it("accepts empty external_id (pre-create draft / YAML-only mode)", () => {
    const result = validateIssue(valid({ external_id: "" }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(true);
  });

  it("rejects empty id", () => {
    const result = validateIssue(valid({ id: "" }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /id/.test(e))).toBe(true);
    }
  });

  it("rejects malformed id (wrong format)", () => {
    const result = validateIssue(valid({ id: "iss-1" }), { expectedPrefix: "ISS" }); // wrong case
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /ISS-/.test(e))).toBe(true);
    }
  });

  it("rejects invalid status enum", () => {
    const result = validateIssue(valid({ status: "Open" }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /status/.test(e))).toBe(true);
    }
  });

  it("rejects invalid type enum", () => {
    const result = validateIssue(valid({ type: "Saga" }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /type/.test(e))).toBe(true);
    }
  });


  it("rejects wrong types (array where string expected)", () => {
    const result = validateIssue(valid({ title: ["not", "a", "string"] }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
  });

  it("rejects ac as a string instead of list", () => {
    const result = validateIssue(valid({ ac: "nope" }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /ac/.test(e))).toBe(true);
    }
  });

  // ---- Test gap E: pin exact validator error wording ----

  it("schema_version: 11 is the canonical version (DX-592 — current writer literal)", () => {
    const result = validateIssue(valid({ schema_version: 11 }));
    expect(result.ok).toBe(true);
  });

  it("schema_version: 10 is the immediate predecessor and migrates forward via the registry (DX-628)", () => {
    // Single-version tolerance window: MIN=10, MAX=11. The validator
    // invokes `migrateForward` ahead of per-field validation for v10
    // inputs; the v10→v11 migration drops the `position` field
    // (folding any non-integer decimal into `priority`). The returned
    // Issue's `schema_version` is the canonical type literal (11), not
    // the input's 10 — same silent-downgrade discipline DX-280 set for
    // forward-compat reads.
    const result = validateIssue(valid({ schema_version: 10, position: null }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.schema_version).toBe(11);
      expect("position" in (result.issue as unknown as Record<string, unknown>)).toBe(false);
    }
  });

  it("schema_version: 9 is rejected — pre-MIN versions reach the validator only when boot sweep failed (DX-592)", () => {
    const result = validateIssue(valid({ schema_version: 9 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) =>
          /schema_version must be an integer >= 10/.test(e),
        ),
      ).toBe(true);
    }
  });

  it("schema_version: 8 is rejected for the same reason (DX-592 single-version tolerance)", () => {
    const result = validateIssue(valid({ schema_version: 8 }));
    expect(result.ok).toBe(false);
  });

  it("DX-592: archived_at must be a string or null — number rejects fail-loud", () => {
    // The five v10 fields (`archived_at`, `ready_at`, `completed_at`,
    // `cancelled_at`, `list_name`) all flow through the same helper
    // (`optionalNullableStringResult`). Exercise the non-string,
    // non-null reject path through ONE of them — a hand-typo in any
    // of the five would route the wrong type into the canonical hash
    // + the DB column, so the fail-loud branch is load-bearing.
    const result = validateIssue(valid({ archived_at: 42 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /archived_at must be a string or null/.test(e)),
      ).toBe(true);
    }
  });

  it("DX-628: validateIssue wraps a registry throw as {ok:false, errors:[\"schema migration failed: ...\"]} (does not let raw throws escape)", async () => {
    // Defense-in-depth — `validateIssue` invokes `migrateForward` for
    // v10 inputs (single-version tolerance) and the wrap-as-errors
    // contract is what callers (chokidar mirror, /api/issues, sync.ts)
    // rely on. A future regression that drops the try/catch would let
    // a raw `MigrationRegistryError` escape and bring down every save.
    // Inject a broken migration through the registry's test-only
    // injector to force the throw path.
    const registry = await import(
      "../../issue-tracker/migrations/registry.js"
    );
    const yamlMod = await import("../../issue-tracker/yaml.js");
    const original = registry.migrationsByFromVersion.get(10);
    try {
      // Swap the v10→v11 step for one that throws inside the chain.
      (registry.migrationsByFromVersion as Map<number, (prev: unknown) => unknown>).set(
        10,
        () => {
          throw new registry.MigrationRegistryError("synthetic mid-chain failure");
        },
      );
      const v10Input = valid({ schema_version: 10 });
      const result = yamlMod.validateIssue(v10Input, { expectedPrefix: "ISS" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) =>
            /schema migration failed.*synthetic mid-chain failure/.test(e),
          ),
        ).toBe(true);
      }
    } finally {
      if (original) {
        (registry.migrationsByFromVersion as Map<number, (prev: unknown) => unknown>).set(
          10,
          original,
        );
      }
    }
  });

  it("DX-628: a v10 raw YAML text round-trips end-to-end through parseIssue → serializeIssue with position dropped + priority folded", () => {
    // Operator-facing surface: on-disk v10 YAMLs continue to parse
    // (single-version tolerance window) and re-serialize as canonical
    // v11 — the `position` field is dropped, and any non-integer
    // `position` decimal is folded into `priority`'s decimal portion
    // so visible row order survives the bump. Locks the round-trip
    // contract that the boot sweep relies on.
    const v10Yaml = [
      "schema_version: 10",
      "tracker: trello",
      "id: ISS-42",
      'external_id: ""',
      "parent_id: null",
      "children: []",
      "dispatch: null",
      "status: ToDo",
      "type: Feature",
      "title: legacy",
      "description: body",
      "priority: 3.0",
      "position: 4.25",
      "triage:",
      "  expires_at: ''",
      "  reassess_hint: ''",
      "  last_status: ''",
      "  last_explain: ''",
      "  ice: {total: 0, i: 0, c: 0, e: 0}",
      "  history: []",
      "ac: []",
      "comments: []",
      "retro: { good: '', bad: '', action_item_ids: [], commits: [] }",
      "assigned_agent: null",
      "waiting_on: null",
      "blocked: null",
      "requires_human: null",
      "conflict_on: []",
      "effort_level: null",
      "history: []",
      "db_updated_at: ''",
      "archived_at: null",
      "ready_at: null",
      "completed_at: null",
      "cancelled_at: null",
      "list_name: null",
      "",
    ].join("\n");

    const parsed = parseIssue(v10Yaml, { expectedPrefix: "ISS" });
    expect(parsed.schema_version).toBe(11);
    // floor(3.0) + (4.25 - floor(4.25)) = 0.0 + 0.25... wait, floor(3.0) = 3, decimal = 0.25, sum = 3.25
    expect(parsed.priority).toBe(3.25);
    expect("position" in (parsed as unknown as Record<string, unknown>)).toBe(false);

    // Re-serialized output omits position entirely + stamps v11.
    const reEmitted = serializeIssue(parsed);
    expect(reEmitted).not.toMatch(/^position:/m);
    expect(reEmitted).toMatch(/^schema_version: 11$/m);
  });

  it("schema_version above KNOWN_SCHEMA_MAX is forward-compat accepted with a console.warn (DX-280)", () => {
    // Pre-DX-280 behavior: validator hard-rejected with "schema_version
    // must be 3, 4, 5, or 6 (got 7)" — that broke every host save when
    // the writer's stamped version bumped without a same-commit
    // `make publish-danx-issue-mcp`. DX-280 reshapes the bound: any
    // integer >= KNOWN_SCHEMA_MIN is accepted; values above
    // KNOWN_SCHEMA_MAX emit a loud warning instead of throwing.
    // Reintroducing the hard-reject form regresses this test by
    // construction.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = validateIssue(valid({ schema_version: KNOWN_SCHEMA_MAX + 1 }));
      expect(result.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toMatch(
        /forward-compat|publish-danx-issue-mcp/i,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("schema_version below KNOWN_SCHEMA_MIN (but not v1/v2) is still rejected — forward-compat is only above the max (DX-280)", () => {
    const result = validateIssue(valid({ schema_version: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /schema_version must be an integer/.test(e))).toBe(true);
    }
  });

  it("schema_version: 1 produces the canonical < MIN error (DX-594 / DX-595 — no migration-script pointer)", () => {
    const result = validateIssue(valid({ schema_version: 1 }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) =>
          /schema_version must be an integer >= 10/.test(e),
        ),
      ).toBe(true);
    }
  });

  it("schema_version: 2 produces the canonical < MIN error (DX-594)", () => {
    const result = validateIssue(valid({ schema_version: 2 }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) =>
          /schema_version must be an integer >= 10/.test(e),
        ),
      ).toBe(true);
    }
  });

  it("empty tracker produces the exact error string", () => {
    const result = validateIssue(valid({ tracker: "" }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("tracker must be a non-empty string");
    }
  });

  it("parent_id: 42 (number) produces the exact error string", () => {
    const result = validateIssue(valid({ parent_id: 42 }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("parent_id must be a string or null");
    }
  });

  it("comments: [42] (non-object) produces the exact error string", () => {
    const result = validateIssue(valid({ comments: [42] }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("comments[0] must be a mapping");
    }
  });

  it("silently drops a populated retro.action_items free-text list (DX-594)", () => {
    // DX-594 dropped the bespoke `retro.action_items` rejection. The
    // boot sweep guarantees no on-disk YAML carries the retired shape;
    // an in-memory input with the key simply silent-drops on the write
    // side (canonical key set in `serializeIssue`).
    const result = validateIssue(
      valid({
        retro: {
          good: "",
          bad: "",
          action_items: ["stale title 1", "stale title 2"],
          commits: [],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.retro.action_item_ids).toEqual([]);
    }
  });

  it("silently drops a retro.action_items: [] key (DX-594)", () => {
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

// `waiting_on` is independent of `status` — pure dispatch gate, durable
// record. Any status (ToDo, In Progress, Review, Blocked, Done, Cancelled)
// is legal with any waiting_on shape; the picker checks effective dep
// resolution and the field itself is never auto-mutated by a status change.
describe("validateIssue waiting_on is independent of status", () => {
  function withWaitingOnAndStatus(
    waitingOn: unknown,
    status: string,
    blocked: unknown = null,
  ): Record<string, unknown> {
    return {
      schema_version: 11,
      tracker: "trello",
      id: "ISS-42",
      external_id: "",
      parent_id: null,
      children: [],
      dispatch: null,
      status,
      type: "Bug",
      title: "t",
      description: "",
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
      blocked,
      waiting_on: waitingOn,
    };
  }

  const populatedWaitingOn = {
    reason: "queued behind ISS-99",
    timestamp: "2026-05-09T00:00:00.000Z",
    by: ["ISS-99"],
  };

  it("accepts waiting_on != null with every non-Blocked status", () => {
    for (const status of ["ToDo", "In Progress", "Review", "Done", "Cancelled"]) {
      const result = validateIssue(
        withWaitingOnAndStatus(populatedWaitingOn, status),
        { expectedPrefix: "ISS" },
      );
      expect(result.ok).toBe(true);
    }
  });

  it("accepts waiting_on: null with any non-Blocked status", () => {
    for (const status of ["Review", "ToDo", "In Progress", "Done", "Cancelled"]) {
      const result = validateIssue(
        withWaitingOnAndStatus(null, status),
        { expectedPrefix: "ISS" },
      );
      expect(result.ok).toBe(true);
    }
  });

  it("accepts waiting_on != null paired with status: Blocked + blocked record (self-block AND dep-chain note both legal)", () => {
    const result = validateIssue(
      withWaitingOnAndStatus(populatedWaitingOn, "Blocked", {
        reason: "stuck on auth",
        at: "2026-05-09T00:00:00.000Z",
      }),
      { expectedPrefix: "ISS" },
    );
    expect(result.ok).toBe(true);
  });

  it("parseIssue round-trips a serialized YAML carrying waiting_on + In Progress", () => {
    const yaml = [
      "schema_version: 11",
      "tracker: trello",
      "id: ISS-42",
      'external_id: ""',
      "parent_id: null",
      "children: []",
      "dispatch: null",
      "status: In Progress",
      "type: Bug",
      "title: t",
      "description: ''",
      "priority: 3",
      "triage:",
      "  expires_at: ''",
      "  reassess_hint: ''",
      "  last_status: ''",
      "  last_explain: ''",
      "  ice: { total: 0, i: 0, c: 0, e: 0 }",
      "  history: []",
      "ac: []",
      "comments: []",
      "history: []",
      "retro:",
      "  good: ''",
      "  bad: ''",
      "  action_item_ids: []",
      "  commits: []",
      "waiting_on:",
      "  reason: queued behind ISS-99",
      "  timestamp: 2026-05-09T00:00:00Z",
      "  by:",
      "    - ISS-99",
      "blocked: null",
      "",
    ].join("\n");
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).not.toThrow();
  });
});

describe("children field (epic → phase linkage)", () => {
  function valid(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      schema_version: 11,
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
      priority: 3.0,
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
    const result = validateIssue(input, { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("missing required field: children");
    }
  });

  it("accepts an empty children list", () => {
    const result = validateIssue(valid({ children: [] }), { expectedPrefix: "ISS" });
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
    const result = validateIssue(valid({ children: ["ISS-101", 42] }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /children\[1\]/.test(e))).toBe(true);
    }
  });

  it("rejects children containing a malformed id", () => {
    const result = validateIssue(valid({ children: ["iss-1"] }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /children\[0\]/.test(e) && /ISS-/.test(e)),
      ).toBe(true);
    }
  });

  it("rejects children as a string instead of a list", () => {
    const result = validateIssue(valid({ children: "ISS-1" }), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
  });

  it("normalizes children: null to []", () => {
    // YAML parses a bare `children:` key (no value) as JS `null`. The
    // migration script and any hand-edited file may emit that shape, so
    // the validator MUST collapse null → empty array. Without this
    // branch every freshly-migrated YAML would re-trip the
    // missing-required-field error path.
    const result = validateIssue(valid({ children: null }), { expectedPrefix: "ISS" });
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
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
    expect(parsed.children).toEqual(["ISS-2", "ISS-3"]);
  });
});

describe("schema_version < MIN (boot sweep escapes)", () => {
  it("rejects schema_version 2 with the canonical < MIN error", () => {
    const yaml = "schema_version: 2\ntracker: trello\n";
    expect(() => parseIssue(yaml, { expectedPrefix: "ISS" })).toThrow(
      /schema_version must be an integer >= 10/,
    );
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
    expect(issue.schema_version).toBe(KNOWN_SCHEMA_MAX);
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
      schema_version: 11,
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
      priority: 3.0,
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
      assigned_agent: null,
      waiting_on: null,
      requires_human: null,
      conflict_on: [],
      effort_level: null,
      history: [],
      db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
    };

    const serialized = serializeIssue(fixture);
    expect(serialized).toMatchInlineSnapshot(`
      "schema_version: 11
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
      priority: 3
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
      history: []
      retro:
        good: we shipped
        bad: took longer than expected
        action_item_ids:
          - ISS-100
          - ISS-101
        commits:
          - abc1234
      assigned_agent: null
      waiting_on: null
      blocked: null
      requires_human: null
      conflict_on: []
      effort_level: null
      db_updated_at: ""
      archived_at: null
      ready_at: null
      completed_at: null
      cancelled_at: null
      list_name: null
      "
    `);
  });

  it("produces deterministic YAML for a populated requires_human record (DX-231 byte-stable)", () => {
    // Pins the on-disk key order of `requires_human` (reason → steps →
    // set_by → set_at). A regression that swaps the field order, drops
    // `steps`, or inlines the array would round-trip through `parseIssue`
    // as in-memory equal but produce a different on-disk byte sequence
    // — broken for diffing + git history. The companion test for the
    // `null` shape pins the same field's absence-from-payload contract.
    const fixture: Issue = {
      schema_version: 11,
      tracker: "trello",
      id: "ISS-99",
      external_id: "card-99",
      parent_id: null,
      children: [],
      dispatch: null,
      status: "ToDo",
      type: "Feature",
      title: "Needs human",
      description: "Body",
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
      assigned_agent: null,
      waiting_on: null,
      requires_human: {
        reason: "Need Stripe API key rotated",
        steps: [
          "Log into Stripe → API keys → Roll secret",
          "Update DANX_STRIPE_KEY in <repo>/.danxbot/.env",
          "Redeploy worker; toggle off this flag",
        ],
        set_by: "agent",
        set_at: "2026-05-10T12:00:00.000Z",
      },
      conflict_on: [],
      effort_level: null,
      history: [],
      db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
    };

    const serialized = serializeIssue(fixture);
    expect(serialized).toMatchInlineSnapshot(`
      "schema_version: 11
      tracker: trello
      id: ISS-99
      external_id: card-99
      parent_id: null
      children: []
      dispatch: null
      status: ToDo
      type: Feature
      title: Needs human
      description: Body
      priority: 3
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
      ac: []
      comments: []
      history: []
      retro:
        good: ""
        bad: ""
        action_item_ids: []
        commits: []
      assigned_agent: null
      waiting_on: null
      blocked: null
      requires_human:
        reason: Need Stripe API key rotated
        steps:
          - Log into Stripe → API keys → Roll secret
          - Update DANX_STRIPE_KEY in <repo>/.danxbot/.env
          - Redeploy worker; toggle off this flag
        set_by: agent
        set_at: 2026-05-10T12:00:00.000Z
      conflict_on: []
      effort_level: null
      db_updated_at: ""
      archived_at: null
      ready_at: null
      completed_at: null
      cancelled_at: null
      list_name: null
      "
    `);
    // Round-trip — the snapshot is the canonical on-disk form; parsing
    // it and re-emitting MUST produce the same bytes.
    const parsed = parseIssue(serialized, { expectedPrefix: "ISS" });
    expect(serializeIssue(parsed)).toBe(serialized);
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
    const result = validateIssue(withDispatch(null), { expectedPrefix: "ISS" });
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
    const result = validateIssue(withDispatch({}), { expectedPrefix: "ISS" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // First missing field surfaces; subsequent checks short-circuit on
      // earlier failures, so we only assert SOMETHING was reported.
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects dispatch as a non-mapping (e.g. string)", () => {
    const result = validateIssue(withDispatch("not-an-object"), { expectedPrefix: "ISS" });
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
    const result = validateIssue(withTriage(null), { expectedPrefix: "ISS" });
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
    const result = validateIssue(withTriage("not-an-object"), { expectedPrefix: "ISS" });
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
    const parsed = parseIssue(yaml, { expectedPrefix: "ISS" });
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

// ---- ISS-99 Phase 1: prefix-aware id validation ----

describe("buildIssueIdRegex", () => {
  it("matches DX-12 with prefix DX", () => {
    expect(buildIssueIdRegex("DX").test("DX-12")).toBe(true);
  });

  it("matches SG-1 with prefix SG", () => {
    expect(buildIssueIdRegex("SG").test("SG-1")).toBe(true);
  });

  it("matches FD-9999 with prefix FD", () => {
    expect(buildIssueIdRegex("FD").test("FD-9999")).toBe(true);
  });

  it("matches ISS-1 with prefix ISS (legacy default)", () => {
    expect(buildIssueIdRegex("ISS").test("ISS-1")).toBe(true);
  });

  it("rejects DX-12 with prefix SG (cross-repo mismatch)", () => {
    expect(buildIssueIdRegex("SG").test("DX-12")).toBe(false);
  });

  it("rejects ISS-12 with prefix DX (pre-migration filename)", () => {
    expect(buildIssueIdRegex("DX").test("ISS-12")).toBe(false);
  });

  it("rejects malformed ids regardless of prefix", () => {
    const r = buildIssueIdRegex("DX");
    expect(r.test("dx-12")).toBe(false);
    expect(r.test("DX12")).toBe(false);
    expect(r.test("DX-")).toBe(false);
    expect(r.test("DX-abc")).toBe(false);
    expect(r.test("")).toBe(false);
  });
});

describe("validateIssue with options.expectedPrefix", () => {
  function valid(overrides: Partial<Issue> = {}): Record<string, unknown> {
    const base = JSON.parse(JSON.stringify(fullIssue(overrides))) as Record<
      string,
      unknown
    >;
    return base;
  }

  it("accepts a DX-prefixed id when expectedPrefix is DX", () => {
    const result = validateIssue(valid({ id: "DX-12" }), {
      expectedPrefix: "DX",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.issue.id).toBe("DX-12");
  });

  it("rejects an ISS-prefixed id when expectedPrefix is DX", () => {
    const result = validateIssue(valid({ id: "ISS-12" }), {
      expectedPrefix: "DX",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /DX-/.test(e))).toBe(true);
    }
  });

  it("accepts an SG-prefixed id when expectedPrefix is SG", () => {
    const result = validateIssue(valid({ id: "SG-7" }), {
      expectedPrefix: "SG",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an FD-prefixed id when expectedPrefix is FD", () => {
    const result = validateIssue(valid({ id: "FD-100" }), {
      expectedPrefix: "FD",
    });
    expect(result.ok).toBe(true);
  });

  it("validates parent_id against the expected prefix", () => {
    const result = validateIssue(
      valid({ id: "DX-1", parent_id: "DX-99" }),
      { expectedPrefix: "DX" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.issue.parent_id).toBe("DX-99");
  });

  it("rejects parent_id with mismatched prefix", () => {
    const result = validateIssue(
      valid({ id: "DX-1", parent_id: "ISS-99" }),
      { expectedPrefix: "DX" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /parent_id/.test(e) && /DX-/.test(e)),
      ).toBe(true);
    }
  });

  it("accepts parent_id: null with any prefix", () => {
    const result = validateIssue(
      valid({ id: "DX-1", parent_id: null }),
      { expectedPrefix: "DX" },
    );
    expect(result.ok).toBe(true);
  });

  it("validates children[] against the expected prefix", () => {
    const result = validateIssue(
      valid({ id: "DX-1", children: ["DX-2", "DX-3"] }),
      { expectedPrefix: "DX" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.children).toEqual(["DX-2", "DX-3"]);
    }
  });

  it("rejects children[] entries with the wrong prefix", () => {
    const result = validateIssue(
      valid({ id: "DX-1", children: ["SG-2"] }),
      { expectedPrefix: "DX" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /children\[0\]/.test(e) && /DX-/.test(e)),
      ).toBe(true);
    }
  });

  it("validates blocked.by[] against the expected prefix", () => {
    const result = validateIssue(
      valid({
        id: "DX-1",
        waiting_on: {
          reason: "waiting on DX-2",
          timestamp: "2026-05-07T00:00:00Z",
          by: ["DX-2"],
        },
      }),
      { expectedPrefix: "DX" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.issue.waiting_on) {
      expect(result.issue.waiting_on.by).toEqual(["DX-2"]);
    }
  });

  it("rejects waiting_on.by[] with mismatched prefix", () => {
    const result = validateIssue(
      valid({
        id: "DX-1",
        waiting_on: {
          reason: "x",
          timestamp: "2026-05-07T00:00:00Z",
          by: ["ISS-2"],
        },
      }),
      { expectedPrefix: "DX" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /waiting_on\.by\[0\]/.test(e) && /DX-/.test(e)),
      ).toBe(true);
    }
  });

  it("validates retro.action_item_ids[] against the expected prefix", () => {
    const result = validateIssue(
      valid({
        id: "DX-1",
        retro: {
          good: "",
          bad: "",
          action_item_ids: ["DX-9", "DX-10"],
          commits: [],
        },
      }),
      { expectedPrefix: "DX" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issue.retro.action_item_ids).toEqual(["DX-9", "DX-10"]);
    }
  });

  it("rejects retro.action_item_ids[] with mismatched prefix", () => {
    const result = validateIssue(
      valid({
        id: "DX-1",
        retro: {
          good: "",
          bad: "",
          action_item_ids: ["SG-9"],
          commits: [],
        },
      }),
      { expectedPrefix: "DX" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => /retro\.action_item_ids\[0\]/.test(e) && /DX-/.test(e),
        ),
      ).toBe(true);
    }
  });

  it("requires expectedPrefix at the type level (Phase 4 of DX-99 — no default)", () => {
    // Compile-time check: passing only the value should be a type error.
    // Runtime check: passing an explicit ISS prefix still validates.
    const result = validateIssueRaw(valid({ id: "ISS-1" }), {
      expectedPrefix: "ISS",
    });
    expect(result.ok).toBe(true);
  });
});

describe("parseIssue with options.expectedPrefix", () => {
  it("parses a DX-prefixed YAML body when expectedPrefix is DX", () => {
    const issue = createEmptyIssue({ id: "DX-1", title: "Prefixed" });
    issue.children = ["DX-2"];
    const yaml = serializeIssue(issue);
    const parsed = parseIssue(yaml, { expectedPrefix: "DX" });
    expect(parsed.id).toBe("DX-1");
    expect(parsed.children).toEqual(["DX-2"]);
  });

  it("rejects an ISS-prefixed body when expectedPrefix is DX", () => {
    const issue = createEmptyIssue({ id: "ISS-1", title: "Prefixed" });
    const yaml = serializeIssue(issue);
    expect(() => parseIssue(yaml, { expectedPrefix: "DX" })).toThrow(
      /DX-/,
    );
  });

  it("error message pins the resolved <PREFIX>-<positive integer> shape", () => {
    const issue = createEmptyIssue({ id: "ISS-1", title: "Prefixed" });
    const yaml = serializeIssue(issue);
    expect(() => parseIssue(yaml, { expectedPrefix: "DX" })).toThrow(
      /DX-<positive integer>/,
    );
  });
});

describe("buildIssueIdRegex shape validation (fail-loud)", () => {
  it("throws on a lowercase prefix", () => {
    expect(() => buildIssueIdRegex("dx")).toThrow(
      /buildIssueIdRegex: invalid prefix "dx"/,
    );
  });

  it("throws on a 1-letter prefix", () => {
    expect(() => buildIssueIdRegex("D")).toThrow(/invalid prefix "D"/);
  });

  it("throws on a 5-letter prefix", () => {
    expect(() => buildIssueIdRegex("ABCDE")).toThrow(/invalid prefix "ABCDE"/);
  });

  it("accepts the boundary shapes XX (2 letters) and ABCD (4 letters)", () => {
    expect(buildIssueIdRegex("XX").test("XX-1")).toBe(true);
    expect(buildIssueIdRegex("ABCD").test("ABCD-9999")).toBe(true);
  });
});

describe("issue-tracker barrel re-exports (DX-99 Phase 4 surface)", () => {
  it("re-exports buildIssueIdRegex + ISSUE_PREFIX_SHAPE from issue-tracker/index", async () => {
    const mod = await import("../../issue-tracker/index.js");
    expect(typeof mod.buildIssueIdRegex).toBe("function");
    expect(mod.ISSUE_PREFIX_SHAPE).toBeInstanceOf(RegExp);
    expect(mod.buildIssueIdRegex("DX")).toBeInstanceOf(RegExp);
  });
});
