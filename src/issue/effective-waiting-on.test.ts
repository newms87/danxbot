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
    schema_version: 10,
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
    "returns record with full by[] when single dep is %s (non-terminal)",
    (status) => {
      const raw = waitingOn(["DX-2"]);
      const issue = makeIssue({ waiting_on: raw });
      const map = byIdMap([depIssue("DX-2", status)]);
      const result = effectiveWaitingOn(issue, map);
      expect(result).not.toBeNull();
      expect(result?.reason).toBe(raw.reason);
      expect(result?.by).toEqual(["DX-2"]);
    },
  );

  it("filters terminal deps out of by[] when one of many is non-terminal", () => {
    const raw = waitingOn(["DX-2", "DX-3", "DX-4"]);
    const issue = makeIssue({ waiting_on: raw });
    const map = byIdMap([
      depIssue("DX-2", "Done"),
      depIssue("DX-3", "In Progress"),
      depIssue("DX-4", "Cancelled"),
    ]);
    const result = effectiveWaitingOn(issue, map);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe(raw.reason);
    expect(result?.by).toEqual(["DX-3"]);
  });

  it("returns record with by[]=[depId] when dep missing from byId (fail-safe)", () => {
    const raw = waitingOn(["DX-2"]);
    const issue = makeIssue({ waiting_on: raw });
    const result = effectiveWaitingOn(issue, new Map());
    expect(result).not.toBeNull();
    expect(result?.by).toEqual(["DX-2"]);
  });

  it("keeps missing deps in by[]; drops terminal ones", () => {
    const raw = waitingOn(["DX-2", "DX-3"]);
    const issue = makeIssue({ waiting_on: raw });
    const map = byIdMap([depIssue("DX-2", "Done")]);
    const result = effectiveWaitingOn(issue, map);
    expect(result).not.toBeNull();
    expect(result?.by).toEqual(["DX-3"]);
  });

  it("does NOT mutate issue.waiting_on when computing effective", () => {
    const raw = waitingOn(["DX-2", "DX-3"]);
    const rawByBefore = [...raw.by];
    const issue = makeIssue({ waiting_on: raw });
    const map = byIdMap([
      depIssue("DX-2", "Done"),
      depIssue("DX-3", "In Progress"),
    ]);
    effectiveWaitingOn(issue, map);
    expect(issue.waiting_on).toBe(raw);
    expect(raw.by).toEqual(rawByBefore);
  });

  it("preserves by[] order from the raw record", () => {
    const raw = waitingOn(["DX-2", "DX-3", "DX-4"]);
    const issue = makeIssue({ waiting_on: raw });
    const map = byIdMap([
      depIssue("DX-2", "In Progress"),
      depIssue("DX-3", "Done"),
      depIssue("DX-4", "ToDo"),
    ]);
    const result = effectiveWaitingOn(issue, map);
    expect(result?.by).toEqual(["DX-2", "DX-4"]);
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
