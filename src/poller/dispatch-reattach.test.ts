import { describe, expect, it } from "vitest";
import { buildReattachPlan } from "./dispatch-reattach.js";
import type { Issue, IssueDispatch } from "../issue-tracker/interface.js";

const HOST = "danxbot-host-a";
const NOW = Date.parse("2026-05-07T12:00:00.000Z");

function makeIssue(
  id: string,
  dispatch: IssueDispatch | null,
  status: Issue["status"] = "In Progress",
): Issue {
  const merged: Issue = {
    schema_version: 5,
    tracker: "memory",
    id,
    external_id: `ext-${id}`,
    parent_id: null,
    children: [],
    dispatch,
    status,
    type: "Feature",
    title: id,
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
    blocked: null,
    assigned_agent: null,
    waiting_on: null,
    history: [],
  };
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

function liveDispatch(overrides: Partial<IssueDispatch> = {}): IssueDispatch {
  return {
    id: "did-1",
    pid: 1234,
    host: HOST,
    kind: "work",
    started_at: new Date(NOW - 60_000).toISOString(),
    ttl_seconds: 7200,
    ...overrides,
  };
}

describe("buildReattachPlan", () => {
  it("partitions alive vs cleared by liveness verdict", () => {
    const issues: Issue[] = [
      makeIssue("ISS-1", liveDispatch()), // alive
      makeIssue("ISS-2", liveDispatch({ pid: 9999 })), // dead-pid
      makeIssue(
        "ISS-3",
        liveDispatch({
          started_at: new Date(NOW - 8000 * 1000).toISOString(),
        }),
      ), // dead-ttl
      makeIssue("ISS-4", liveDispatch({ host: "other-host" })), // cross-host
    ];
    const plan = buildReattachPlan(issues, {
      currentHost: HOST,
      now: NOW,
      isPidAlive: (pid) => pid === 1234,
    });

    expect(plan.alive.map((a) => a.issue.id)).toEqual(["ISS-1"]);
    expect(plan.cleared.map((c) => c.issue.id)).toEqual([
      "ISS-2",
      "ISS-3",
      "ISS-4",
    ]);
    expect(plan.cleared.map((c) => c.verdict.kind)).toEqual([
      "dead-pid",
      "dead-ttl",
      "cross-host",
    ]);
  });

  it("skips issues with dispatch === null", () => {
    const issues: Issue[] = [
      makeIssue("ISS-1", null),
      makeIssue("ISS-2", liveDispatch()),
    ];
    const plan = buildReattachPlan(issues, {
      currentHost: HOST,
      now: NOW,
      isPidAlive: () => true,
    });
    expect(plan.alive.map((a) => a.issue.id)).toEqual(["ISS-2"]);
    expect(plan.cleared).toEqual([]);
  });

  it("returns empty partitions for empty input", () => {
    const plan = buildReattachPlan([], {
      currentHost: HOST,
      now: NOW,
      isPidAlive: () => false,
    });
    expect(plan.alive).toEqual([]);
    expect(plan.cleared).toEqual([]);
  });

  it("never places a single issue in both partitions", () => {
    const issues = [makeIssue("ISS-1", liveDispatch())];
    const plan = buildReattachPlan(issues, {
      currentHost: HOST,
      now: NOW,
      isPidAlive: () => true,
    });
    expect(plan.alive.length + plan.cleared.length).toBe(1);
  });
});
