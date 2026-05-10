import { describe, expect, it } from "vitest";
import type { Issue, IssueStatus, WaitingOn } from "../../issue-tracker/interface.js";
import { decideWaitingOnClear } from "./waiting-on.js";

function makeIssue(waiting_on: WaitingOn | null): Issue {
  return {
    schema_version: 5,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Title",
    description: "Body",
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
    assigned_agent: null,
    waiting_on,
    history: [],
  };
}

function map(entries: Record<string, IssueStatus | null>): Map<string, IssueStatus | null> {
  return new Map(Object.entries(entries));
}

describe("decideWaitingOnClear — pure helper (DX-217)", () => {
  it("returns false when waiting_on is null", () => {
    const issue = makeIssue(null);
    expect(decideWaitingOnClear(issue, new Map())).toBe(false);
  });

  it("returns true when single dep is Done", () => {
    const issue = makeIssue({
      reason: "waits on DX-2",
      timestamp: "2026-01-01T00:00:00.000Z",
      by: ["DX-2"],
    });
    expect(decideWaitingOnClear(issue, map({ "DX-2": "Done" }))).toBe(true);
  });

  it("returns true when single dep is Cancelled", () => {
    const issue = makeIssue({
      reason: "waits on DX-2",
      timestamp: "2026-01-01T00:00:00.000Z",
      by: ["DX-2"],
    });
    expect(decideWaitingOnClear(issue, map({ "DX-2": "Cancelled" }))).toBe(true);
  });

  it("returns true when ALL deps are terminal (mix of Done + Cancelled)", () => {
    const issue = makeIssue({
      reason: "waits on DX-2 and DX-3",
      timestamp: "2026-01-01T00:00:00.000Z",
      by: ["DX-2", "DX-3"],
    });
    expect(
      decideWaitingOnClear(
        issue,
        map({ "DX-2": "Done", "DX-3": "Cancelled" }),
      ),
    ).toBe(true);
  });

  it("returns false when ANY dep is non-terminal", () => {
    const issue = makeIssue({
      reason: "waits on DX-2 and DX-3",
      timestamp: "2026-01-01T00:00:00.000Z",
      by: ["DX-2", "DX-3"],
    });
    expect(
      decideWaitingOnClear(
        issue,
        map({ "DX-2": "Done", "DX-3": "In Progress" }),
      ),
    ).toBe(false);
  });

  const nonTerminal: IssueStatus[] = [
    "Review",
    "ToDo",
    "In Progress",
    "Blocked",
    "Needs Approval",
  ];

  for (const status of nonTerminal) {
    it(`returns false when single dep is ${status}`, () => {
      const issue = makeIssue({
        reason: "waits on DX-2",
        timestamp: "2026-01-01T00:00:00.000Z",
        by: ["DX-2"],
      });
      expect(decideWaitingOnClear(issue, map({ "DX-2": status }))).toBe(false);
    });
  }

  it("returns false when a dep is missing from the byStatuses map", () => {
    const issue = makeIssue({
      reason: "waits on DX-2 and DX-3",
      timestamp: "2026-01-01T00:00:00.000Z",
      by: ["DX-2", "DX-3"],
    });
    // DX-3 omitted from the map entirely.
    expect(decideWaitingOnClear(issue, map({ "DX-2": "Done" }))).toBe(false);
  });

  it("returns false when a dep status is null (DB row missing)", () => {
    const issue = makeIssue({
      reason: "waits on DX-2",
      timestamp: "2026-01-01T00:00:00.000Z",
      by: ["DX-2"],
    });
    expect(decideWaitingOnClear(issue, map({ "DX-2": null }))).toBe(false);
  });

  it("returns true on EMPTY by[] (vacuous truth — no deps means nothing blocks)", () => {
    // Defensive contract pin: a non-null `waiting_on` with `by: []` is
    // a degenerate state (parser allows it; agents shouldn't write
    // it). The vacuous-truth path returns true so the malformed record
    // auto-clears on next reconcile rather than sticking forever.
    const issue = makeIssue({
      reason: "no deps somehow",
      timestamp: "2026-01-01T00:00:00.000Z",
      by: [],
    });
    expect(decideWaitingOnClear(issue, new Map())).toBe(true);
  });
});
