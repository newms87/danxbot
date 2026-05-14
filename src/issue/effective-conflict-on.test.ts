import { describe, expect, it } from "vitest";
import {
  effectiveConflictOn,
  isEffectivelyConflicted,
} from "./effective-conflict-on.js";
import type { Issue } from "../issue-tracker/interface.js";

function issue(
  id: string,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    schema_version: 8,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: id,
    description: "",
    priority: 3.0,
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
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    ...overrides,
  };
}

describe("effectiveConflictOn", () => {
  it("returns empty report when conflict_on is empty + no reverse references", () => {
    const a = issue("DX-1");
    const b = issue("DX-2", { status: "In Progress" });
    expect(effectiveConflictOn(a, [a, b])).toEqual({
      forward: [],
      reverse: [],
    });
    expect(isEffectivelyConflicted(a, [a, b])).toBe(false);
  });

  it("forward direction: returns partners whose status is In Progress", () => {
    const a = issue("DX-1", {
      conflict_on: [
        { id: "DX-2", reason: "shared fn" },
        { id: "DX-3", reason: "shared interface" },
      ],
    });
    const b = issue("DX-2", { status: "In Progress" });
    const c = issue("DX-3", { status: "ToDo" });
    const report = effectiveConflictOn(a, [a, b, c]);
    expect(report.forward).toEqual([{ id: "DX-2", reason: "shared fn" }]);
    expect(report.reverse).toEqual([]);
    expect(isEffectivelyConflicted(a, [a, b, c])).toBe(true);
  });

  it("reverse direction: another In Progress card lists THIS card → blocking", () => {
    const a = issue("DX-1");
    const b = issue("DX-2", {
      status: "In Progress",
      conflict_on: [{ id: "DX-1", reason: "I conflict with DX-1" }],
    });
    const report = effectiveConflictOn(a, [a, b]);
    expect(report.forward).toEqual([]);
    expect(report.reverse).toEqual([
      { id: "DX-2", reason: "I conflict with DX-1" },
    ]);
    expect(isEffectivelyConflicted(a, [a, b])).toBe(true);
  });

  it("symmetric: declaration on one side enforces on both", () => {
    const a = issue("DX-1", {
      conflict_on: [{ id: "DX-2", reason: "shared module" }],
    });
    const b = issue("DX-2", {
      status: "In Progress",
      // NO declaration on B's side.
    });
    // A → B (forward), and B is In Progress
    expect(isEffectivelyConflicted(a, [a, b])).toBe(true);
    // B → A would only trigger if A were In Progress. A is ToDo here,
    // so B sees nothing live.
    expect(isEffectivelyConflicted(b, [a, b])).toBe(false);
  });

  it("ignores terminal partners (Done / Cancelled)", () => {
    const a = issue("DX-1", {
      conflict_on: [{ id: "DX-2", reason: "x" }],
    });
    const done = issue("DX-2", { status: "Done" });
    const cancelled = issue("DX-2", { status: "Cancelled" });
    expect(isEffectivelyConflicted(a, [a, done])).toBe(false);
    expect(isEffectivelyConflicted(a, [a, cancelled])).toBe(false);
  });

  it("ignores missing partners (hard-deleted / not in open set)", () => {
    const a = issue("DX-1", {
      conflict_on: [{ id: "DX-99", reason: "ghost" }],
    });
    expect(isEffectivelyConflicted(a, [a])).toBe(false);
  });

  it("ignores self-references in conflict_on (defensive)", () => {
    const a = issue("DX-1", {
      status: "In Progress",
      conflict_on: [{ id: "DX-1", reason: "self" }],
    });
    expect(isEffectivelyConflicted(a, [a])).toBe(false);
  });

  it("dedupes reverse entries when another card has duplicate references", () => {
    const a = issue("DX-1");
    const b = issue("DX-2", {
      status: "In Progress",
      // Validator would have dedup'd this, but defensive against
      // hand-edited or pre-v7 YAMLs.
      conflict_on: [
        { id: "DX-1", reason: "first" },
        { id: "DX-1", reason: "dup" },
      ],
    });
    const report = effectiveConflictOn(a, [a, b]);
    expect(report.reverse).toHaveLength(1);
    expect(report.reverse[0].id).toBe("DX-2");
  });

  it("multiple In Progress reverse partners all surface", () => {
    const a = issue("DX-1");
    const b = issue("DX-2", {
      status: "In Progress",
      conflict_on: [{ id: "DX-1", reason: "from B" }],
    });
    const c = issue("DX-3", {
      status: "In Progress",
      conflict_on: [{ id: "DX-1", reason: "from C" }],
    });
    const report = effectiveConflictOn(a, [a, b, c]);
    expect(report.reverse).toEqual([
      { id: "DX-2", reason: "from B" },
      { id: "DX-3", reason: "from C" },
    ]);
  });
});
