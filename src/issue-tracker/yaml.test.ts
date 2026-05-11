/**
 * Issue YAML parser robustness tests.
 *
 * Bare git SHAs (e.g. `9828791`) parsed by yaml.js as numeric scalars.
 * Schema requires `string`. Without coercion, one slipped int in
 * `retro.commits[]` 500s the dashboard's `/api/issues` endpoint and
 * masks every other issue in the same repo (per design: corrupt YAML
 * is never silent-skip territory). Parser MUST coerce numeric scalars
 * in `retro.commits[]` to strings so a small operator slip doesn't
 * take down the list.
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseIssue,
  serializeIssue,
  createEmptyIssue,
  issueToCreateInput,
  IssueParseError,
  KNOWN_SCHEMA_MAX,
  KNOWN_SCHEMA_MIN,
} from "./yaml.js";
import type { Issue } from "./interface.js";

const BASE = `schema_version: 4
tracker: trello
id: DX-1
external_id: ""
parent_id: null
children: []
dispatch: null
status: ToDo
type: Feature
title: t
description: d
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
ac: []
comments: []
waiting_on: null
`;

function withRetro(retroBlock: string): string {
  return BASE + retroBlock;
}

describe("parseIssue — retro.commits coercion", () => {
  it("accepts string SHAs as-is", () => {
    const txt = withRetro(`retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits:
    - "9828791"
    - "abc1234"
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    expect(issue.retro.commits).toEqual(["9828791", "abc1234"]);
  });

  it("coerces all-digit SHAs (yaml-parsed as int) to strings", () => {
    const txt = withRetro(`retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits:
    - 9828791
    - 1234567
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    expect(issue.retro.commits).toEqual(["9828791", "1234567"]);
    expect(issue.retro.commits.every((c) => typeof c === "string")).toBe(true);
  });

  it("accepts a mix of numeric + string entries (real-world: int slipped between quoted SHAs)", () => {
    const txt = withRetro(`retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits:
    - "deadbeef"
    - 9828791
    - "abc1234"
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    expect(issue.retro.commits).toEqual(["deadbeef", "9828791", "abc1234"]);
  });

  it("rejects non-string-non-number entries (object, bool, null) loudly", () => {
    const txt = withRetro(`retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits:
    - "abc"
    - true
`);
    expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
      IssueParseError,
    );
    expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
      /retro\.commits\[1\]/,
    );
  });

  it("empty commits list parses fine", () => {
    const txt = withRetro(`retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    expect(issue.retro.commits).toEqual([]);
  });
});

describe("AGENT_NAME_SHAPE — local copy stays in sync with settings-file", () => {
  it("yaml.ts's local AGENT_NAME_SHAPE source matches settings-file's export", async () => {
    // The local copy in `yaml.ts` exists to validate `assigned_agent`
    // (DX-200) without forcing a heavy import of `settings-file.ts`
    // (which pulls fs/path/logger). The two definitions MUST stay
    // byte-identical or hand-edited YAMLs may pass parse + fail the
    // dashboard agent CRUD validator (or vice versa). This test pins
    // the invariant.
    const settings = await import("../settings-file.js");
    // Both regexes are anchored, byte-equal sources: re-create from the
    // exported regex source string so we compare structurally.
    const expected = settings.AGENT_NAME_SHAPE.source;
    // Round-trip a known-good value to exercise the local copy:
    const txt = `schema_version: 5
tracker: trello
id: DX-7
external_id: ""
parent_id: null
children: []
dispatch: null
status: ToDo
type: Feature
title: "T"
description: ""
priority: 3.0
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
ac: []
comments: []
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
assigned_agent: alice
waiting_on: null
blocked: null
history: []
`;
    const ok = parseIssue(txt, { expectedPrefix: "DX" });
    expect(ok.assigned_agent).toBe("alice");
    // Pin source so a divergence test fails loudly. If the regex needs
    // to change, update both definitions in lockstep.
    expect(expected).toBe("^[a-z][a-z0-9_-]{0,31}$");
  });

  it("rejects an assigned_agent value that violates the shape", () => {
    const txt = `schema_version: 5
tracker: trello
id: DX-7
external_id: ""
parent_id: null
children: []
dispatch: null
status: ToDo
type: Feature
title: "T"
description: ""
priority: 3.0
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
ac: []
comments: []
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
assigned_agent: "BadName!"
waiting_on: null
blocked: null
history: []
`;
    expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(/assigned_agent/);
  });
});

describe("serializeIssue — requires_human tolerates undefined", () => {
  /**
   * Regression: pre-DX-231 YAMLs lack the `requires_human` field
   * entirely. If anything upstream of `serializeIssue` produced an
   * `Issue` object with `requires_human: undefined` (rather than
   * `null`), the strict `=== null` check fell through to read
   * `.reason` of undefined → `TypeError: Cannot read properties of
   * undefined (reading 'reason')`. Boot reattach hit this every time
   * a legacy YAML had a dead `dispatch:` block to clear, so the
   * stamps accumulated and the multi-agent picker filtered every ToDo
   * card with `dispatch !== null`. Worker idled with a populated ToDo
   * queue until an operator manually cleared the YAMLs.
   *
   * Loose `== null` covers both null and undefined; treat absent the
   * same as null and round-trip cleanly.
   */
  function legacyIssueWithoutRequiresHuman(): Issue {
    return {
      schema_version: 6,
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
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requires_human: undefined as any,
      assigned_agent: null,
      waiting_on: null,
      history: [],
    };
  }

  it("serializes an Issue with `requires_human: undefined` as `null` (round-trips)", () => {
    const issue = legacyIssueWithoutRequiresHuman();
    const yaml = serializeIssue(issue);
    expect(yaml).toMatch(/requires_human:\s*null/);
    const reparsed = parseIssue(yaml, { expectedPrefix: "DX" });
    expect(reparsed.requires_human).toBeNull();
  });

  it("does not throw `Cannot read properties of undefined (reading 'reason')`", () => {
    const issue = legacyIssueWithoutRequiresHuman();
    expect(() => serializeIssue(issue)).not.toThrow();
  });
});

/**
 * DX-280 — Forward-compatible schema_version bound.
 *
 * The bug this prevents: the writer in `serializeIssue` /
 * `createEmptyIssue` stamps `schema_version: N` on every save; the
 * published `@thehammer/danx-issue-mcp` package bundles a validator
 * snapshot at publish time. Before DX-280 the validator's allowlist
 * was an explicit `!== 3 && !== 4 && !== 5 && !== 6` set — a writer
 * bump to 7 committed without a same-commit `make
 * publish-danx-issue-mcp` made every host save fail with
 * `schema_version must be 3, 4, 5, or 6 (got 7)`.
 *
 * Forward-compat soft-degrades that into a `console.warn`: cards still
 * parse, saves still round-trip, the operator gets a loud signal to
 * republish. These tests pin the behavior so a future hand-edit cannot
 * regress to the hard-reject form.
 *
 * Concretely the test simulates the drift class by writing a YAML whose
 * `schema_version` is `KNOWN_SCHEMA_MAX + 1` — a future writer's stamp
 * the current validator does NOT know about — and asserts that
 * `parseIssue` accepts it instead of throwing.
 */
function yamlWithSchemaVersion(version: number | string): string {
  return `schema_version: ${version}
tracker: trello
id: DX-1
external_id: ""
parent_id: null
children: []
dispatch: null
status: ToDo
type: Feature
title: t
description: d
priority: 3.0
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
ac: []
comments: []
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
waiting_on: null
blocked: null
history: []
`;
}

describe("DX-280 — schema_version forward-compat bound", () => {
  // Vitest's `restoreMocks: true` (vitest.config.ts) handles vi.spyOn
  // cleanup between tests automatically — NO afterEach needed.
  //
  // The forward-compat warn in yaml.ts is dedup-keyed on the unknown
  // version (module-level Set, intentionally not exported as a test
  // seam). Each `it` below uses a UNIQUE `KNOWN_SCHEMA_MAX + N` so the
  // Set state from earlier tests in the file does not bleed in.
  // Different test files run in separate vitest fork workers, so the
  // Set is fresh across files.

  it("accepts a future schema_version (writer-N / validator-N-1 drift) without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const futureVersion = KNOWN_SCHEMA_MAX + 1;
    const txt = yamlWithSchemaVersion(futureVersion);
    expect(() => parseIssue(txt, { expectedPrefix: "DX" })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(
      /forward-compat|make publish-danx-issue-mcp/i,
    );
  });

  it("warns loudly enough that the operator notices the lag", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseIssue(yamlWithSchemaVersion(KNOWN_SCHEMA_MAX + 2), {
      expectedPrefix: "DX",
    });
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain(`schema_version ${KNOWN_SCHEMA_MAX + 2}`);
    expect(msg).toContain(String(KNOWN_SCHEMA_MAX));
    expect(msg).toContain("publish-danx-issue-mcp");
  });

  it("does NOT warn on a known schema_version (KNOWN_SCHEMA_MAX itself)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseIssue(yamlWithSchemaVersion(KNOWN_SCHEMA_MAX), {
      expectedPrefix: "DX",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("dedup: repeated parses of the SAME future version emit exactly one warning (chokidar mirror amplification guard)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = KNOWN_SCHEMA_MAX + 3;
    parseIssue(yamlWithSchemaVersion(v), { expectedPrefix: "DX" });
    parseIssue(yamlWithSchemaVersion(v), { expectedPrefix: "DX" });
    parseIssue(yamlWithSchemaVersion(v), { expectedPrefix: "DX" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("dedup: DIFFERENT future versions each emit their own warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseIssue(yamlWithSchemaVersion(KNOWN_SCHEMA_MAX + 4), {
      expectedPrefix: "DX",
    });
    parseIssue(yamlWithSchemaVersion(KNOWN_SCHEMA_MAX + 5), {
      expectedPrefix: "DX",
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("silent-downgrade: forward-compat-accepted YAMLs return Issue.schema_version = KNOWN_SCHEMA_MAX (type-stable for downstream consumers)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const issue = parseIssue(yamlWithSchemaVersion(KNOWN_SCHEMA_MAX + 6), {
      expectedPrefix: "DX",
    });
    expect(issue.schema_version).toBe(KNOWN_SCHEMA_MAX);
  });

  it("downgrade-on-write: parse(future) → serialize() re-stamps KNOWN_SCHEMA_MAX and drops unknown future fields", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Inject an unknown future top-level field; the writer's fixed key
    // set must NOT re-emit it — forward-compat is READ-ONLY, never
    // round-trip-faithful for fields the validator did not parse.
    const txt = yamlWithSchemaVersion(KNOWN_SCHEMA_MAX + 7).replace(
      /^title: t$/m,
      'title: t\nfuture_only_field: "should not survive round-trip"',
    );
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    const reSerialized = serializeIssue(issue);
    expect(reSerialized).toMatch(
      new RegExp(`^schema_version:\\s*${KNOWN_SCHEMA_MAX}\\b`),
    );
    expect(reSerialized).not.toContain("future_only_field");
  });

  it("rejects schema_version below KNOWN_SCHEMA_MIN with a clear error (not silent forward-accept)", () => {
    const txt = yamlWithSchemaVersion(KNOWN_SCHEMA_MIN - 1);
    expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
      IssueParseError,
    );
  });

  it("rejects non-integer schema_version (e.g. string, float, null)", () => {
    expect(() =>
      parseIssue(yamlWithSchemaVersion('"6"'), { expectedPrefix: "DX" }),
    ).toThrow(/schema_version must be an integer/);
    expect(() =>
      parseIssue(yamlWithSchemaVersion(3.5), { expectedPrefix: "DX" }),
    ).toThrow(/schema_version must be an integer/);
  });

  it("rejects YAML that omits schema_version entirely", () => {
    const txt = yamlWithSchemaVersion(KNOWN_SCHEMA_MAX).replace(
      /^schema_version: .+\n/,
      "",
    );
    expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
      /missing required field: schema_version/,
    );
  });

  it("lockstep invariant: every writer site stamps KNOWN_SCHEMA_MAX (bump them all together when adding a schema version)", () => {
    // The drift class this card prevents is exactly: ONE of the three
    // writer sites bumps; the validator's KNOWN_SCHEMA_MAX does not.
    // Exercise all three writer sites so a one-sided bump fails this
    // test loudly before it reaches a host session.
    //
    // Writer site 1 — createEmptyIssue (the schema_version literal on
    // the returned Issue).
    const fresh = createEmptyIssue();
    expect(fresh.schema_version).toBe(KNOWN_SCHEMA_MAX);

    // Writer site 2 — issueToCreateInput (the schema_version literal
    // on the CreateCardInput shape pushed to the tracker).
    const created = issueToCreateInput({
      ...fresh,
      id: "DX-1",
      title: "t",
      description: "d",
    });
    expect(created.schema_version).toBe(KNOWN_SCHEMA_MAX);

    // Writer site 3 — validateIssue's built Issue (the schema_version
    // literal that round-trips through parseIssue, including the
    // forward-compat silent-downgrade path). Exercised by writing
    // canonical YAML and re-parsing.
    const issue: Issue = {
      ...fresh,
      id: "DX-1",
      title: "t",
      description: "d",
      status: "ToDo",
      type: "Feature",
    };
    const yaml = serializeIssue(issue);
    expect(yaml).toMatch(
      new RegExp(`^schema_version:\\s*${KNOWN_SCHEMA_MAX}\\b`),
    );
    const reparsed = parseIssue(yaml, { expectedPrefix: "DX" });
    expect(reparsed.schema_version).toBe(KNOWN_SCHEMA_MAX);
  });
});
