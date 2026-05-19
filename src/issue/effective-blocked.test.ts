import { describe, expect, it } from "vitest";
import type { Blocked, Issue } from "../issue-tracker/interface.js";
import {
  effectiveBlocked,
  isEffectivelyBlocked,
} from "./effective-blocked.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 12,
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

function blocked(reason: string, at = "2026-05-18T00:00:00.000Z"): Blocked {
  return { at, reason };
}

function byIdMap(issues: Issue[]): Map<string, Issue> {
  const m = new Map<string, Issue>();
  for (const i of issues) m.set(i.id, i);
  return m;
}

describe("effectiveBlocked", () => {
  it("no children → self passthrough, empty inherited", () => {
    const issue = makeIssue();
    expect(effectiveBlocked(issue, byIdMap([issue]))).toEqual({
      self: null,
      inherited: [],
    });
  });

  it("self-blocked but no descendants → self set, inherited empty", () => {
    const issue = makeIssue({ blocked: blocked("reason A") });
    expect(effectiveBlocked(issue, byIdMap([issue]))).toEqual({
      self: { at: "2026-05-18T00:00:00.000Z", reason: "reason A" },
      inherited: [],
    });
  });

  it("single blocked direct child → inherited carries child record", () => {
    const child = makeIssue({ id: "DX-2", blocked: blocked("phase wedged") });
    const parent = makeIssue({ id: "DX-1", children: ["DX-2"] });
    const result = effectiveBlocked(parent, byIdMap([parent, child]));
    expect(result.self).toBeNull();
    expect(result.inherited).toEqual([
      { id: "DX-2", reason: "phase wedged", at: "2026-05-18T00:00:00.000Z" },
    ]);
  });

  it("recursive — grandchild blocked surfaces on root", () => {
    const grand = makeIssue({ id: "DX-3", blocked: blocked("leaf gate") });
    const child = makeIssue({ id: "DX-2", children: ["DX-3"] });
    const root = makeIssue({ id: "DX-1", children: ["DX-2"] });
    const result = effectiveBlocked(root, byIdMap([root, child, grand]));
    expect(result.inherited).toEqual([
      { id: "DX-3", reason: "leaf gate", at: "2026-05-18T00:00:00.000Z" },
    ]);
  });

  it("multiple blocked siblings → all surface in depth-first order", () => {
    const c1 = makeIssue({ id: "DX-2", blocked: blocked("c1") });
    const c2 = makeIssue({ id: "DX-3", blocked: blocked("c2") });
    const root = makeIssue({ id: "DX-1", children: ["DX-2", "DX-3"] });
    const result = effectiveBlocked(root, byIdMap([root, c1, c2]));
    expect(result.inherited.map((i) => i.id)).toEqual(["DX-2", "DX-3"]);
  });

  it("child with undefined blocked / undefined children → no throw", () => {
    const child = {
      ...makeIssue({ id: "DX-2" }),
      blocked: undefined as unknown as null,
      children: undefined as unknown as string[],
    } as Issue;
    const root = makeIssue({ id: "DX-1", children: ["DX-2"] });
    expect(() => effectiveBlocked(root, byIdMap([root, child]))).not.toThrow();
    expect(effectiveBlocked(root, byIdMap([root, child])).inherited).toEqual(
      [],
    );
  });

  it("missing child id → skipped, no throw", () => {
    const root = makeIssue({ id: "DX-1", children: ["DX-missing"] });
    expect(effectiveBlocked(root, byIdMap([root])).inherited).toEqual([]);
  });

  it("cycle in graph → terminates, deduped", () => {
    const a = makeIssue({ id: "DX-1", children: ["DX-2"] });
    const b = makeIssue({
      id: "DX-2",
      children: ["DX-1"],
      blocked: blocked("b"),
    });
    const result = effectiveBlocked(a, byIdMap([a, b]));
    expect(result.inherited).toEqual([
      { id: "DX-2", reason: "b", at: "2026-05-18T00:00:00.000Z" },
    ]);
  });

  it("self + descendant both blocked → both reported orthogonally", () => {
    const child = makeIssue({ id: "DX-2", blocked: blocked("child") });
    const parent = makeIssue({
      id: "DX-1",
      children: ["DX-2"],
      blocked: blocked("self"),
    });
    const result = effectiveBlocked(parent, byIdMap([parent, child]));
    expect(result.self).toEqual({
      at: "2026-05-18T00:00:00.000Z",
      reason: "self",
    });
    expect(result.inherited).toEqual([
      { id: "DX-2", reason: "child", at: "2026-05-18T00:00:00.000Z" },
    ]);
  });
});

describe("isEffectivelyBlocked", () => {
  it("false when neither self nor any descendant blocked", () => {
    const child = makeIssue({ id: "DX-2" });
    const parent = makeIssue({ id: "DX-1", children: ["DX-2"] });
    expect(isEffectivelyBlocked(parent, byIdMap([parent, child]))).toBe(false);
  });

  it("true when self blocked", () => {
    const issue = makeIssue({ blocked: blocked("x") });
    expect(isEffectivelyBlocked(issue, byIdMap([issue]))).toBe(true);
  });

  it("true when deep descendant blocked", () => {
    const grand = makeIssue({ id: "DX-3", blocked: blocked("g") });
    const child = makeIssue({ id: "DX-2", children: ["DX-3"] });
    const root = makeIssue({ id: "DX-1", children: ["DX-2"] });
    expect(isEffectivelyBlocked(root, byIdMap([root, child, grand]))).toBe(
      true,
    );
  });
});
