/**
 * Tests for `buildReattachPlan` — DX-320.
 *
 * The planner is the pure-fn seam re-extracted from `bootRehydrate`'s
 * Step 1 body (the inlined version landed in DX-220). It takes an
 * `Issue[]` snapshot plus a `LivenessDeps` injection and returns the
 * `{alive, cleared}` partition — no filesystem fixtures, no module
 * mocks, no I/O.
 *
 * `bootRehydrate` retains the orchestration (loadLocal walk,
 * clearDispatchAndWrite I/O, logging) and its own integration test in
 * `boot-rehydrate.test.ts` continues to pin the wired behaviour. This
 * suite exercises the four verdicts × two partitions matrix from AC #4.
 */
import { describe, it, expect } from "vitest";
import { buildReattachPlan } from "./reattach-planner.js";
import type { Issue } from "../issue-tracker/interface.js";

function makeIssueWithDispatch(opts: {
  id: string;
  pid: number;
  host: string;
  startedAt: string;
  ttlSeconds: number;
}): Issue {
  return {
    schema_version: 10,
    tracker: "memory",
    id: opts.id,
    external_id: `ext-${opts.id}`,
    parent_id: null,
    children: [],
    dispatch: {
      id: `dispatch-${opts.id}`,
      pid: opts.pid,
      host: opts.host,
      kind: "work",
      started_at: opts.startedAt,
      ttl_seconds: opts.ttlSeconds,
    },
    status: "In Progress",
    type: "Feature",
    title: opts.id,
    description: "",
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
    assigned_agent: "agent",
    waiting_on: null,
    blocked: null,
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
  } as unknown as Issue;
}

function makeIssueNoDispatch(id: string): Issue {
  const issue = makeIssueWithDispatch({
    id,
    pid: 0,
    host: "",
    startedAt: "",
    ttlSeconds: 0,
  });
  (issue as { dispatch: null }).dispatch = null;
  return issue;
}

describe("buildReattachPlan", () => {
  const baseDeps = {
    currentHost: "local-host",
    now: Date.parse("2026-05-12T19:00:00Z"),
    isPidAlive: (pid: number) => pid === 100,
  };

  it("alive verdict routes the issue into the alive partition", () => {
    const issue = makeIssueWithDispatch({
      id: "DX-1",
      pid: 100,
      host: "local-host",
      startedAt: "2026-05-12T18:55:00Z",
      ttlSeconds: 7200,
    });

    const plan = buildReattachPlan([issue], baseDeps);

    expect(plan.alive.map((i) => i.id)).toEqual(["DX-1"]);
    expect(plan.cleared).toEqual([]);
  });

  it("dead-pid verdict routes the issue into the cleared partition", () => {
    const issue = makeIssueWithDispatch({
      id: "DX-2",
      pid: 200,
      host: "local-host",
      startedAt: "2026-05-12T18:55:00Z",
      ttlSeconds: 7200,
    });

    const plan = buildReattachPlan([issue], baseDeps);

    expect(plan.alive).toEqual([]);
    expect(plan.cleared.map((i) => i.id)).toEqual(["DX-2"]);
  });

  it("dead-ttl verdict routes the issue into the cleared partition", () => {
    const issue = makeIssueWithDispatch({
      id: "DX-3",
      pid: 100,
      host: "local-host",
      startedAt: "2026-05-12T16:00:00Z",
      ttlSeconds: 60,
    });

    const plan = buildReattachPlan([issue], baseDeps);

    expect(plan.alive).toEqual([]);
    expect(plan.cleared.map((i) => i.id)).toEqual(["DX-3"]);
  });

  it("cross-host verdict routes the issue into the cleared partition", () => {
    const issue = makeIssueWithDispatch({
      id: "DX-4",
      pid: 100,
      host: "OTHER-HOST",
      startedAt: "2026-05-12T18:55:00Z",
      ttlSeconds: 7200,
    });

    const plan = buildReattachPlan([issue], baseDeps);

    expect(plan.alive).toEqual([]);
    expect(plan.cleared.map((i) => i.id)).toEqual(["DX-4"]);
  });

  it("mixed verdict input partitions each issue independently and preserves order within each bucket", () => {
    const alive = makeIssueWithDispatch({
      id: "DX-1",
      pid: 100,
      host: "local-host",
      startedAt: "2026-05-12T18:55:00Z",
      ttlSeconds: 7200,
    });
    const deadPid = makeIssueWithDispatch({
      id: "DX-2",
      pid: 200,
      host: "local-host",
      startedAt: "2026-05-12T18:55:00Z",
      ttlSeconds: 7200,
    });
    const crossHost = makeIssueWithDispatch({
      id: "DX-3",
      pid: 100,
      host: "OTHER-HOST",
      startedAt: "2026-05-12T18:55:00Z",
      ttlSeconds: 7200,
    });
    const deadTtl = makeIssueWithDispatch({
      id: "DX-4",
      pid: 100,
      host: "local-host",
      startedAt: "2026-05-12T16:00:00Z",
      ttlSeconds: 60,
    });

    const plan = buildReattachPlan([alive, deadPid, crossHost, deadTtl], baseDeps);

    expect(plan.alive.map((i) => i.id)).toEqual(["DX-1"]);
    expect(plan.cleared.map((i) => i.id)).toEqual(["DX-2", "DX-3", "DX-4"]);
  });

  it("issues with dispatch=null are filtered out of both partitions", () => {
    const noDispatch = makeIssueNoDispatch("DX-5");
    const alive = makeIssueWithDispatch({
      id: "DX-1",
      pid: 100,
      host: "local-host",
      startedAt: "2026-05-12T18:55:00Z",
      ttlSeconds: 7200,
    });

    const plan = buildReattachPlan([noDispatch, alive], baseDeps);

    expect(plan.alive.map((i) => i.id)).toEqual(["DX-1"]);
    expect(plan.cleared).toEqual([]);
  });

  it("empty input returns empty partitions", () => {
    const plan = buildReattachPlan([], baseDeps);
    expect(plan.alive).toEqual([]);
    expect(plan.cleared).toEqual([]);
  });
});
