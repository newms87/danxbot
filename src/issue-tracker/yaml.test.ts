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

import { describe, it, expect } from "vitest";
import { parseIssue, serializeIssue, IssueParseError } from "./yaml.js";
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
