import { describe, expect, it } from "vitest";
import type {
  Issue,
  IssueStatus,
  WaitingOn,
} from "../issue-tracker/interface.js";
import {
  effectiveWaitingOn,
  isEffectivelyWaitingOn,
} from "./effective-waiting-on.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 7,
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
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
    history: [],
    ...overrides,
  };
}

function depIssue(id: string, status: IssueStatus): Issue {
  return makeIssue({ id, status });
}

function waitingOn(by: string[]): WaitingOn {
  return { reason: `waits on ${by.join(", ")}`, timestamp: "", by };
}

function byIdMap(deps: Issue[]): Map<string, Issue> {
  const m = new Map<string, Issue>();
  for (const d of deps) m.set(d.id, d);
  return m;
}

describe("effectiveWaitingOn", () => {
  it("returns null when raw waiting_on is null", () => {
    const issue = makeIssue();
    expect(effectiveWaitingOn(issue, new Map())).toBeNull();
  });

  it("returns null when every dep is Done", () => {
    const issue = makeIssue({ waiting_on: waitingOn(["DX-2"]) });
    const map = byIdMap([depIssue("DX-2", "Done")]);
    expect(effectiveWaitingOn(issue, map)).toBeNull();
  });

  it("returns null when every dep is Cancelled", () => {
    const issue = makeIssue({ waiting_on: waitingOn(["DX-2"]) });
    const map = byIdMap([depIssue("DX-2", "Cancelled")]);
    expect(effectiveWaitingOn(issue, map)).toBeNull();
  });

  it("returns null when all deps mix Done and Cancelled", () => {
    const issue = makeIssue({ waiting_on: waitingOn(["DX-2", "DX-3"]) });
    const map = byIdMap([
      depIssue("DX-2", "Done"),
      depIssue("DX-3", "Cancelled"),
    ]);
    expect(effectiveWaitingOn(issue, map)).toBeNull();
  });

  it.each<IssueStatus>(["Review", "ToDo", "In Progress", "Blocked"])(
    "returns raw waiting_on when a dep is %s (non-terminal)",
    (status) => {
      const raw = waitingOn(["DX-2"]);
      const issue = makeIssue({ waiting_on: raw });
      const map = byIdMap([depIssue("DX-2", status)]);
      expect(effectiveWaitingOn(issue, map)).toBe(raw);
    },
  );

  it("returns raw waiting_on when one of many deps is non-terminal", () => {
    const raw = waitingOn(["DX-2", "DX-3"]);
    const issue = makeIssue({ waiting_on: raw });
    const map = byIdMap([
      depIssue("DX-2", "Done"),
      depIssue("DX-3", "In Progress"),
    ]);
    expect(effectiveWaitingOn(issue, map)).toBe(raw);
  });

  it("returns raw waiting_on when a dep is missing from byId (fail-safe)", () => {
    const raw = waitingOn(["DX-2"]);
    const issue = makeIssue({ waiting_on: raw });
    expect(effectiveWaitingOn(issue, new Map())).toBe(raw);
  });

  it("returns raw waiting_on when one of many deps is missing", () => {
    const raw = waitingOn(["DX-2", "DX-3"]);
    const issue = makeIssue({ waiting_on: raw });
    const map = byIdMap([depIssue("DX-2", "Done")]);
    expect(effectiveWaitingOn(issue, map)).toBe(raw);
  });

  it("does NOT mutate issue.waiting_on when deps terminal", () => {
    const raw = waitingOn(["DX-2"]);
    const issue = makeIssue({ waiting_on: raw });
    const map = byIdMap([depIssue("DX-2", "Done")]);
    effectiveWaitingOn(issue, map);
    expect(issue.waiting_on).toBe(raw);
  });
});

describe("isEffectivelyWaitingOn", () => {
  it("false when waiting_on null", () => {
    expect(isEffectivelyWaitingOn(makeIssue(), new Map())).toBe(false);
  });

  it("false when every dep terminal", () => {
    const issue = makeIssue({ waiting_on: waitingOn(["DX-2"]) });
    const map = byIdMap([depIssue("DX-2", "Done")]);
    expect(isEffectivelyWaitingOn(issue, map)).toBe(false);
  });

  it("true when dep open", () => {
    const issue = makeIssue({ waiting_on: waitingOn(["DX-2"]) });
    const map = byIdMap([depIssue("DX-2", "ToDo")]);
    expect(isEffectivelyWaitingOn(issue, map)).toBe(true);
  });

  it("true when dep missing", () => {
    const issue = makeIssue({ waiting_on: waitingOn(["DX-2"]) });
    expect(isEffectivelyWaitingOn(issue, new Map())).toBe(true);
  });
});
