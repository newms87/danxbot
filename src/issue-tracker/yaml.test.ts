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
import { parseIssue, IssueParseError } from "./yaml.js";

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
