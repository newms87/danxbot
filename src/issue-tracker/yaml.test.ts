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

const BASE = `schema_version: 10
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
    const txt = `schema_version: 10
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
    const txt = `schema_version: 10
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

/**
 * DX-347 — ac[].check_item_id auto-heal on read.
 *
 * `check_item_id` is a sync-layer-only Trello checkItem id; it carries
 * zero semantic meaning to agents. Before DX-347 the validator
 * hard-rejected any ac item whose `check_item_id` was absent / null /
 * non-string, which meant a single missing field unparseably-corrupted
 * the entire YAML: the orphan-heal scan skipped it, chokidar mirrored
 * `{_malformed: true}`, the poller went blind to the card, and the
 * dashboard 500'd. The schema's own docstring already promised "new
 * items use `check_item_id: ""` and the worker assigns" — yet the
 * validator did not honor that contract on the read side.
 *
 * The auto-heal: any non-string / missing `check_item_id` materializes
 * as `""`. The sync layer (`src/issue-tracker/sync.ts:346`) already
 * treats empty `check_item_id` as "new item" → `addAcItem` stamps the
 * tracker-assigned id back onto the local YAML on the next sync.
 * Auto-heal is purely a read-side relaxation; the tracker still owns
 * id assignment.
 */
describe("validateAcList — DX-347 check_item_id auto-heal", () => {
  function yamlWithAc(acBlock: string): string {
    return `schema_version: 10
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
priority: 3
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
${acBlock}comments: []
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
waiting_on: null
blocked: null
requires_human: null
conflict_on: []
history: []
`;
  }

  it("ac item missing check_item_id parses with check_item_id = '' (no reject)", () => {
    const txt = yamlWithAc(`ac:
  - title: AC1 — new item the agent wrote without the optional field
    checked: false
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    expect(issue.ac).toHaveLength(1);
    expect(issue.ac[0]).toEqual({
      check_item_id: "",
      title: "AC1 — new item the agent wrote without the optional field",
      checked: false,
    });
  });

  it("ac item with explicit `check_item_id: null` auto-heals to ''", () => {
    const txt = yamlWithAc(`ac:
  - check_item_id: null
    title: AC1
    checked: true
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    expect(issue.ac[0]?.check_item_id).toBe("");
    expect(issue.ac[0]?.title).toBe("AC1");
    expect(issue.ac[0]?.checked).toBe(true);
  });

  it("ac item with numeric check_item_id (yaml-parsed int) auto-heals to ''", () => {
    // Real-world case: a hand-edit or stale-format tracker import that
    // emits an integer where a string is expected.
    const txt = yamlWithAc(`ac:
  - check_item_id: 12345
    title: AC1
    checked: false
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    expect(issue.ac[0]?.check_item_id).toBe("");
  });

  it("ac item with boolean check_item_id auto-heals to ''", () => {
    const txt = yamlWithAc(`ac:
  - check_item_id: false
    title: AC1
    checked: false
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    expect(issue.ac[0]?.check_item_id).toBe("");
  });

  it("preserves existing non-empty check_item_id values untouched", () => {
    const txt = yamlWithAc(`ac:
  - check_item_id: "chk-tracker-real-id-abc"
    title: AC1
    checked: true
  - title: AC2
    checked: false
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    expect(issue.ac[0]?.check_item_id).toBe("chk-tracker-real-id-abc");
    // Second item with no field → healed to empty.
    expect(issue.ac[1]?.check_item_id).toBe("");
  });

  it("still rejects non-mapping ac entries (auto-heal does NOT cover shape errors)", () => {
    const txt = yamlWithAc(`ac:
  - "just a string, not a mapping"
`);
    expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
      /ac\[0\] must be a mapping/,
    );
  });

  it("still rejects ac items missing required title / checked (auto-heal scope is narrow)", () => {
    const missingTitle = yamlWithAc(`ac:
  - checked: false
`);
    expect(() => parseIssue(missingTitle, { expectedPrefix: "DX" })).toThrow(
      /ac\[0\]\.title must be a string/,
    );
    const missingChecked = yamlWithAc(`ac:
  - title: AC1
`);
    expect(() => parseIssue(missingChecked, { expectedPrefix: "DX" })).toThrow(
      /ac\[0\]\.checked must be a boolean/,
    );
  });

  it("round-trip: parse(yaml-with-missing-check_item_id) → serialize → parse — stable empty check_item_id, no synthetic value leak", () => {
    const txt = yamlWithAc(`ac:
  - title: AC1
    checked: false
  - title: AC2
    checked: true
`);
    const issue = parseIssue(txt, { expectedPrefix: "DX" });
    const serialized = serializeIssue(issue);
    // Serializer emits `check_item_id: ""` explicitly so a second
    // reader sees the healed value without re-running the heal.
    expect(serialized).toMatch(/check_item_id:\s*['"]{2}/);
    const reparsed = parseIssue(serialized, { expectedPrefix: "DX" });
    expect(reparsed.ac).toHaveLength(2);
    expect(reparsed.ac[0]?.check_item_id).toBe("");
    expect(reparsed.ac[1]?.check_item_id).toBe("");
    expect(reparsed.ac[0]?.title).toBe("AC1");
    expect(reparsed.ac[1]?.title).toBe("AC2");
    expect(reparsed.ac[1]?.checked).toBe(true);
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
      schema_version: 10,
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
      conflict_on: [],
      effort_level: null,
      assigned_agent: null,
      waiting_on: null,
      history: [],
      db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
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

/**
 * DX-511 — `effort_level` field (schema v7 → v8 bump).
 *
 * The DX-508 epic's per-card effort hint. One of seven canonical
 * `EffortLevelName` literals or `null` (inherit-default semantics).
 * The validator rejects unknown values fail-loud — a typo would
 * silently route the dispatch through the wrong model/effort tier.
 *
 * Migration shape from v7: the field is optional. v7 YAMLs without
 * the key parse as `effort_level: null` (same shape as a fresh card).
 * On round-trip the writer emits explicit `null` so a second reader
 * sees the healed value without re-running the migration.
 */
function yamlV7WithoutEffortLevel(): string {
  return `schema_version: 10
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
requires_human: null
conflict_on: []
history: []
`;
}

function yamlV8WithEffortLevel(value: string): string {
  return `schema_version: 10
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
requires_human: null
conflict_on: []
effort_level: ${value}
history: []
`;
}

describe("DX-511 — effort_level field (v8)", () => {
  it("v7 fixture without effort_level parses with effort_level: null (forward migration)", () => {
    const issue = parseIssue(yamlV7WithoutEffortLevel(), {
      expectedPrefix: "DX",
    });
    expect(issue.effort_level).toBeNull();
  });

  it("v8 fixture with explicit effort_level: null parses as null", () => {
    const issue = parseIssue(yamlV8WithEffortLevel("null"), {
      expectedPrefix: "DX",
    });
    expect(issue.effort_level).toBeNull();
  });

  it.each([
    "min",
    "very_low",
    "low",
    "medium",
    "high",
    "very_high",
    "max",
  ] as const)("v8 fixture with effort_level: %s round-trips losslessly + byte-stable re-serialize", (name) => {
    const issue = parseIssue(yamlV8WithEffortLevel(name), {
      expectedPrefix: "DX",
    });
    expect(issue.effort_level).toBe(name);
    const reSerialized = serializeIssue(issue);
    expect(reSerialized).toContain(`effort_level: ${name}`);
    const reparsed = parseIssue(reSerialized, { expectedPrefix: "DX" });
    expect(reparsed.effort_level).toBe(name);
    // Non-null byte-stability — parse → serialize → parse → serialize
    // must produce identical bytes (canonical key order + explicit YAML
    // emission for the field). Without this, an integer-coerce or
    // quoting-inconsistency regression would diverge between save round-trips.
    expect(serializeIssue(reparsed)).toBe(reSerialized);
  });

  it("rejects an invalid effort_level value fail-loud (typo guard)", () => {
    expect(() =>
      parseIssue(yamlV8WithEffortLevel("bogus"), { expectedPrefix: "DX" }),
    ).toThrow(/effort_level must be null or one of/);
  });

  it("rejects a non-string effort_level (number, boolean, list, mapping) fail-loud", () => {
    // Every plausible hand-edit / external-tool failure mode that yaml.js
    // can produce. The canonical names are lowercase + snake_case; anything
    // else must surface as a parse error rather than silently coerce
    // through the validator. Without this defense-in-depth coverage a
    // future relaxation could leak `effort_level: Medium` through with
    // an unintended downcast.
    expect(() =>
      parseIssue(yamlV8WithEffortLevel("42"), { expectedPrefix: "DX" }),
    ).toThrow(/effort_level/);
    expect(() =>
      parseIssue(yamlV8WithEffortLevel("true"), { expectedPrefix: "DX" }),
    ).toThrow(/effort_level/);
    expect(() =>
      parseIssue(yamlV8WithEffortLevel("[low]"), { expectedPrefix: "DX" }),
    ).toThrow(/effort_level/);
    expect(() =>
      parseIssue(yamlV8WithEffortLevel("{name: low}"), { expectedPrefix: "DX" }),
    ).toThrow(/effort_level/);
  });

  it("rejects mixed-case + empty-string effort_level (canonical names are lowercase + snake_case)", () => {
    expect(() =>
      parseIssue(yamlV8WithEffortLevel("Medium"), { expectedPrefix: "DX" }),
    ).toThrow(/effort_level must be null or one of/);
    expect(() =>
      parseIssue(yamlV8WithEffortLevel('""'), { expectedPrefix: "DX" }),
    ).toThrow(/effort_level must be null or one of/);
  });

  it("serializeIssue emits effort_level: null as explicit YAML null, not absent key (round-trip stable)", () => {
    const issue = parseIssue(yamlV7WithoutEffortLevel(), {
      expectedPrefix: "DX",
    });
    const yaml = serializeIssue(issue);
    // Explicit `effort_level: null` so a second reader sees the healed
    // value without re-running the v7-without-field migration.
    expect(yaml).toMatch(/effort_level:\s*null/);
  });

  it("createEmptyIssue stamps effort_level: null by default", () => {
    const fresh = createEmptyIssue();
    expect(fresh.effort_level).toBeNull();
    expect(fresh.schema_version).toBe(KNOWN_SCHEMA_MAX);
  });

  it("createEmptyIssue accepts an explicit effort_level seed", () => {
    const fresh = createEmptyIssue({ effort_level: "high" });
    expect(fresh.effort_level).toBe("high");
  });

  it("issueToCreateInput mirrors effort_level (null and non-null)", () => {
    const fresh = createEmptyIssue({ id: "DX-1", title: "t", description: "d" });
    expect(issueToCreateInput(fresh).effort_level).toBeNull();
    const withLevel = createEmptyIssue({
      id: "DX-2",
      title: "t",
      description: "d",
      effort_level: "very_high",
    });
    expect(issueToCreateInput(withLevel).effort_level).toBe("very_high");
  });

  it("KNOWN_SCHEMA_MAX bumped to 10 (DX-280 lockstep invariant: writer == KNOWN_SCHEMA_MAX)", () => {
    expect(KNOWN_SCHEMA_MAX).toBe(10);
    const fresh = createEmptyIssue();
    expect(fresh.schema_version).toBe(KNOWN_SCHEMA_MAX);
    expect(issueToCreateInput(fresh).schema_version).toBe(KNOWN_SCHEMA_MAX);
  });
});

/**
 * DX-546 — `db_updated_at` field (schema v8 → v9 bump).
 *
 * Phase 1 of the DB-mirror sync (DX-545) introduces a string field that
 * tracks when the canonical content was last upserted to the DB. Phase 1
 * lands the schema only; Phase 2 wires the synchronous mirror write.
 *
 * Migration shape from v8: the field is optional on parse. v8 YAMLs
 * without the key parse as `db_updated_at: ""` ("never-mirrored"
 * sentinel) so legacy cards continue to load.
 */
describe("DX-546 — db_updated_at field (v9)", () => {
  function yamlWithoutDbUpdatedAt(): string {
    return `schema_version: 10
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
requires_human: null
conflict_on: []
effort_level: null
history: []
`;
  }

  function yamlWithDbUpdatedAt(value: string): string {
    return `schema_version: 10
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
requires_human: null
conflict_on: []
effort_level: null
history: []
db_updated_at: ${value}
`;
  }

  it("v8 fixture without db_updated_at parses with db_updated_at: '' (forward migration)", () => {
    const issue = parseIssue(yamlWithoutDbUpdatedAt(), { expectedPrefix: "DX" });
    expect(issue.db_updated_at).toBe("");
  });

  it("v9 fixture with explicit db_updated_at: null parses as ''", () => {
    const issue = parseIssue(yamlWithDbUpdatedAt("null"), { expectedPrefix: "DX" });
    expect(issue.db_updated_at).toBe("");
  });

  it("v9 fixture with ISO timestamp round-trips losslessly", () => {
    const stamp = "2026-05-15T06:30:00.000Z";
    const issue = parseIssue(yamlWithDbUpdatedAt(`"${stamp}"`), {
      expectedPrefix: "DX",
    });
    expect(issue.db_updated_at).toBe(stamp);
    const reSerialized = serializeIssue(issue);
    expect(reSerialized).toContain(`db_updated_at: ${stamp}`);
    const reparsed = parseIssue(reSerialized, { expectedPrefix: "DX" });
    expect(reparsed.db_updated_at).toBe(stamp);
  });

  it("rejects non-string db_updated_at fail-loud (numeric / boolean / mapping)", () => {
    expect(() =>
      parseIssue(yamlWithDbUpdatedAt("42"), { expectedPrefix: "DX" }),
    ).toThrow(/db_updated_at must be a string/);
    expect(() =>
      parseIssue(yamlWithDbUpdatedAt("true"), { expectedPrefix: "DX" }),
    ).toThrow(/db_updated_at must be a string/);
    expect(() =>
      parseIssue(yamlWithDbUpdatedAt("{ts: 1}"), { expectedPrefix: "DX" }),
    ).toThrow(/db_updated_at must be a string/);
  });

  it("serializeIssue emits db_updated_at on every save (no missing-key path)", () => {
    const issue = parseIssue(yamlWithoutDbUpdatedAt(), { expectedPrefix: "DX" });
    const yaml = serializeIssue(issue);
    expect(yaml).toMatch(/db_updated_at:/);
  });

  it("createEmptyIssue stamps db_updated_at to current ISO 8601 timestamp", () => {
    const before = Date.now();
    const fresh = createEmptyIssue();
    const after = Date.now();
    expect(fresh.db_updated_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    const stamped = Date.parse(fresh.db_updated_at);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("byte-stable round-trip with a non-empty db_updated_at value", () => {
    // Pre-Phase-2 the field is stamped only by createEmptyIssue, but the
    // serializer must still produce a byte-identical YAML on
    // parse → serialize → parse → serialize. A regression that quotes
    // the timestamp differently (single vs double quotes, timezone
    // normalization, trailing newline drift) would diverge between
    // round-trips and break diff hygiene for the per-card history.
    const stamp = "2026-05-15T06:30:00.000Z";
    const issue = parseIssue(yamlWithDbUpdatedAt(`"${stamp}"`), {
      expectedPrefix: "DX",
    });
    const yaml1 = serializeIssue(issue);
    const reparsed = parseIssue(yaml1, { expectedPrefix: "DX" });
    const yaml2 = serializeIssue(reparsed);
    expect(yaml2).toBe(yaml1);
  });
});

describe("parseIssue — priority bounds widened to (0.01, 5.99) (DX-521)", () => {
  function withPriority(priorityYamlLiteral: string): string {
    return `schema_version: 10
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
priority: ${priorityYamlLiteral}
position: null
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
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
requires_human: null
conflict_on: []
effort_level: null
`;
  }

  it("accepts priority: 0.5 (in widened range, was rejected pre-DX-521)", () => {
    const issue = parseIssue(withPriority("0.5"), { expectedPrefix: "DX" });
    expect(issue.priority).toBe(0.5);
  });

  it("accepts priority: 5.99 (in widened range)", () => {
    const issue = parseIssue(withPriority("5.99"), { expectedPrefix: "DX" });
    expect(issue.priority).toBe(5.99);
  });

  it("clamps priority: 0 to PRIORITY_MIN (0.01)", () => {
    const issue = parseIssue(withPriority("0"), { expectedPrefix: "DX" });
    expect(issue.priority).toBe(0.01);
  });

  it("clamps priority: 6 to PRIORITY_MAX (5.99)", () => {
    const issue = parseIssue(withPriority("6"), { expectedPrefix: "DX" });
    expect(issue.priority).toBe(5.99);
  });

  it("clamps priority: -1 to PRIORITY_MIN", () => {
    const issue = parseIssue(withPriority("-1"), { expectedPrefix: "DX" });
    expect(issue.priority).toBe(0.01);
  });

  it("defaults priority: .nan (non-finite) to PRIORITY_DEFAULT (3.0)", () => {
    // yaml.js parses `.nan` as the float NaN — the clamp guards against
    // non-finite numbers and falls back to PRIORITY_DEFAULT.
    const issue = parseIssue(withPriority(".nan"), { expectedPrefix: "DX" });
    expect(issue.priority).toBe(3.0);
  });

  it("AC #5 — existing on-disk priority: 3 round-trips unchanged (regression guard)", () => {
    // Bounds widen must not silently migrate existing values. Every YAML
    // on disk today carries priority: 3 (the default); after the widen
    // those values must still round-trip as exactly 3.0.
    const issue = parseIssue(withPriority("3"), { expectedPrefix: "DX" });
    expect(issue.priority).toBe(3.0);
    const reSerialized = serializeIssue(issue);
    const reParsed = parseIssue(reSerialized, { expectedPrefix: "DX" });
    expect(reParsed.priority).toBe(3.0);
  });
});

/**
 * DX-594 — strict canonical reader.
 *
 * Phase 3 of the schema-invariant epic (DX-591) deletes every legacy
 * reader branch from `yaml.ts`. The boot sweep (DX-593) guarantees every
 * on-disk YAML is canonical-v(MAX) by the time any in-process reader
 * sees it, so the validator no longer carries:
 *
 *   - schema_version 1/2 rejection with a migration-script pointer
 *   - `dispatch_id` legacy field rejection
 *   - `triaged` legacy block rejection
 *   - `"Needs Approval"` status branch (DX-231 retired)
 *   - `"Needs Help"` → `"Blocked"` v3 auto-migrate
 *   - v3 `blocked: {by[]}` → `waiting_on` auto-migrate
 *   - `retro.action_items` (legacy free-text) rejection
 *   - Priority defaulting on read
 *
 * Each test below pins the strict-rejection (or silent-drop) behavior
 * that replaces the deleted branch.
 */
describe("DX-594 — strict canonical reader", () => {
  function strictCanonical(overrides: Record<string, string> = {}): string {
    const lines: Record<string, string> = {
      schema_version: "10",
      tracker: "trello",
      id: "DX-1",
      external_id: '""',
      parent_id: "null",
      children: "[]",
      dispatch: "null",
      status: "ToDo",
      type: "Feature",
      title: "t",
      description: "d",
      priority: "3.0",
      position: "null",
      triage:
        "\n  expires_at: ''\n  reassess_hint: ''\n  last_status: ''\n  last_explain: ''\n  ice: {total: 0, i: 0, c: 0, e: 0}\n  history: []",
      ac: "[]",
      comments: "[]",
      retro:
        "\n  good: ''\n  bad: ''\n  action_item_ids: []\n  commits: []",
      assigned_agent: "null",
      waiting_on: "null",
      blocked: "null",
      requires_human: "null",
      conflict_on: "[]",
      effort_level: "null",
      history: "[]",
      db_updated_at: '""',
      ...overrides,
    };
    return Object.entries(lines)
      .map(([k, v]) => `${k}:${v.startsWith("\n") ? v : ` ${v}`}`)
      .join("\n") + "\n";
  }

  describe("schema_version", () => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
      "rejects schema_version %s (below KNOWN_SCHEMA_MIN) with the canonical < MIN error",
      (version) => {
        const txt = strictCanonical({ schema_version: String(version) });
        expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
          new RegExp(`schema_version must be an integer >= ${KNOWN_SCHEMA_MIN}`),
        );
      },
    );

    it("accepts schema_version === KNOWN_SCHEMA_MIN via migrateForward (defense-in-depth)", () => {
      // v9 → v10 migration: the registry stamps schema_version: 10 + adds
      // the five v10 computed-timestamp fields. The boot sweep handles
      // this before any reader sees a v9 file, but the inline registry
      // call remains as a safety net.
      const v9Txt = `schema_version: 9
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
position: null
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
assigned_agent: null
waiting_on: null
blocked: null
requires_human: null
conflict_on: []
effort_level: null
history: []
db_updated_at: ""
`;
      const issue = parseIssue(v9Txt, { expectedPrefix: "DX" });
      expect(issue.schema_version).toBe(KNOWN_SCHEMA_MAX);
      // v10's computed-timestamp fields default to null on migration.
      expect(issue.archived_at).toBeNull();
      expect(issue.ready_at).toBeNull();
      expect(issue.completed_at).toBeNull();
      expect(issue.cancelled_at).toBeNull();
      expect(issue.list_name).toBeNull();
    });
  });

  describe("dispatch_id (retired field)", () => {
    it("silently drops dispatch_id — no `dispatch_id is no longer supported` rejection", () => {
      // The validator no longer carries the legacy rejection. An on-disk
      // file with a stale dispatch_id key is treated as an unknown top-
      // level field — silently dropped on the write side via the
      // canonical key set in `serializeIssue`.
      const txt = strictCanonical().replace(
        "dispatch: null",
        "dispatch: null\ndispatch_id: stale-uuid-from-old-schema",
      );
      const issue = parseIssue(txt, { expectedPrefix: "DX" });
      expect(issue.dispatch).toBeNull();
      // Round-trip drops the unknown key.
      expect(serializeIssue(issue)).not.toContain("dispatch_id");
    });
  });

  describe("triaged (retired field)", () => {
    it("silently drops triaged — no `triaged is no longer supported` rejection", () => {
      const txt = strictCanonical().replace(
        /triage:[\s\S]*?history: \[\]\n/,
        `triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice: {total: 0, i: 0, c: 0, e: 0}
  history: []
triaged:
  timestamp: "2024-01-01"
  status: approved
  explain: stale flat block from prior schema
`,
      );
      const issue = parseIssue(txt, { expectedPrefix: "DX" });
      expect(issue.triage.expires_at).toBe("");
      // Round-trip drops the unknown key.
      expect(serializeIssue(issue)).not.toContain("triaged:");
    });
  });

  describe("status: Needs Approval / Needs Help (retired)", () => {
    it("rejects status: 'Needs Approval' via the generic enum check (no DX-231 specific pointer)", () => {
      const txt = strictCanonical({ status: "'Needs Approval'" });
      expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
        /status must be one of/,
      );
      expect(() => parseIssue(txt, { expectedPrefix: "DX" })).not.toThrow(
        /DX-231/,
      );
    });

    it("rejects status: 'Needs Help' — no v3-to-v4 auto-migration", () => {
      // Previously a v3 YAML with status: "Needs Help" was auto-migrated
      // to "Blocked" with a synthesized epoch-stamped blocked record. Now
      // the field is rejected via the canonical status enum check.
      const txt = strictCanonical({ status: "'Needs Help'" });
      expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
        /status must be one of/,
      );
    });
  });

  describe("blocked / waiting_on (no v3 auto-migration)", () => {
    it("rejects a canonical-v(MAX) file whose `blocked` carries the legacy `by[]` payload", () => {
      // v3 schema had `blocked: {reason, timestamp, by[]}` (dep-chain).
      // v10 splits that into `waiting_on` (dep-chain) + `blocked`
      // (self-block, no by[]). A v10 file with `by[]` on `blocked` is
      // half-migrated; validateBlocked rejects it fail-loud.
      const txt = strictCanonical({
        status: "Blocked",
        blocked: '\n  reason: "test"\n  at: "2026-05-16T00:00:00Z"\n  by: [DX-2]',
      });
      expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
        /blocked must NOT carry 'by'/,
      );
    });

    it("rejects `blocked.timestamp` (renamed to `blocked.at` in v10)", () => {
      const txt = strictCanonical({
        status: "Blocked",
        blocked: '\n  reason: "test"\n  timestamp: "2026-05-16T00:00:00Z"',
      });
      expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
        /blocked\.at must be a non-empty string/,
      );
    });
  });

  describe("retro.action_items (retired)", () => {
    it("silently drops retro.action_items — no `legacy free-text shape` rejection", () => {
      // Previously a non-empty `action_items: ["title1", "title2"]` was
      // rejected fail-loud with a danx_issue_create migration pointer.
      // The boot sweep guarantees no on-disk YAML carries the legacy
      // shape, so the validator just silently drops it on read; the
      // canonical writer key set in `serializeIssue` only emits
      // `action_item_ids`.
      const txt = strictCanonical({
        retro:
          "\n  good: ''\n  bad: ''\n  action_items: ['title1', 'title2']\n  action_item_ids: []\n  commits: []",
      });
      const issue = parseIssue(txt, { expectedPrefix: "DX" });
      expect(issue.retro.action_item_ids).toEqual([]);
      expect(serializeIssue(issue)).not.toContain("action_items:");
    });
  });

  describe("priority (REQUIRED — no read-time default)", () => {
    it("rejects a file that omits priority", () => {
      const txt = strictCanonical().replace(/^priority: 3\.0\n/m, "");
      expect(() => parseIssue(txt, { expectedPrefix: "DX" })).toThrow(
        /missing required field: priority/,
      );
    });
  });

  describe("DX-582 — parseIssue applies deriveStatus on every read", () => {
    function buildAndParse(mutate: (issue: Issue) => void): Issue {
      const base = createEmptyIssue({
        id: "DX-1",
        type: "Feature",
        title: "t",
        description: "d",
      });
      mutate(base);
      return parseIssue(serializeIssue(base), { expectedPrefix: "DX" });
    }

    it("on-disk Review + completed_at populated → parsed.status === 'Done' (derivation overrides raw)", () => {
      const issue = buildAndParse((i) => {
        i.status = "Review";
        i.completed_at = "2026-05-16T10:00:00Z";
      });
      expect(issue.status).toBe("Done");
    });

    it("on-disk ToDo + cancelled_at populated → parsed.status === 'Cancelled'", () => {
      const issue = buildAndParse((i) => {
        i.status = "ToDo";
        i.cancelled_at = "2026-05-16T10:00:00Z";
      });
      expect(issue.status).toBe("Cancelled");
    });

    it("on-disk Review + archived_at populated → parsed.status === 'Backlog'", () => {
      const issue = buildAndParse((i) => {
        i.status = "Review";
        i.archived_at = "2026-05-16T10:00:00Z";
      });
      expect(issue.status).toBe("Backlog");
    });

    it("all-null timestamps → parsed.status falls through to raw on-disk value (rule-7 deviation)", () => {
      // Pin the migration-safety deviation at the loader boundary:
      // every v10 card currently on disk has all-null timestamps;
      // the derivation MUST NOT flip them to Review.
      const issue = buildAndParse((i) => {
        i.status = "In Progress";
      });
      expect(issue.status).toBe("In Progress");
    });
  });
});
