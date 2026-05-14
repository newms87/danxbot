import { describe, it, expect } from "vitest";
import {
  projectChildStatus,
  CHILD_STATUS_META,
  ICE_TIER_META,
  iceTier,
} from "./issuePalette";

describe("projectChildStatus", () => {
  it("Done → 'done'", () => {
    expect(projectChildStatus("Done", false)).toBe("done");
  });

  it("Cancelled → 'done' (terminal-from-parent's-perspective)", () => {
    expect(projectChildStatus("Cancelled", false)).toBe("done");
  });

  it("Done overrides waiting_on record", () => {
    expect(projectChildStatus("Done", true)).toBe("done");
  });

  it("Cancelled overrides waiting_on record", () => {
    expect(projectChildStatus("Cancelled", true)).toBe("done");
  });

  it("Blocked → 'blocked'", () => {
    expect(projectChildStatus("Blocked", false)).toBe("blocked");
  });
  // DX-231 retired the legacy `Needs Approval` status mapping; the
  // orthogonal `requires_human` field gets its own indicator (Phase 8
  // of the epic), not a status-derived palette branch.

  it("non-null waiting_on on a non-terminal status → 'waiting'", () => {
    expect(projectChildStatus("ToDo", true)).toBe("waiting");
    expect(projectChildStatus("In Progress", true)).toBe("waiting");
    expect(projectChildStatus("Review", true)).toBe("waiting");
  });

  it("Review / ToDo (no waiting_on) → 'todo'", () => {
    expect(projectChildStatus("Review", false)).toBe("todo");
    expect(projectChildStatus("ToDo", false)).toBe("todo");
  });

  it("In Progress (no waiting_on) → 'in_progress'", () => {
    expect(projectChildStatus("In Progress", false)).toBe("in_progress");
  });
});

describe("CHILD_STATUS_META", () => {
  it("has an entry for every ChildStatusId the projection emits", () => {
    expect(CHILD_STATUS_META.done).toBeDefined();
    expect(CHILD_STATUS_META.todo).toBeDefined();
    expect(CHILD_STATUS_META.blocked).toBeDefined();
  });
});

// DX-516 — ICE tier classification for the IssueCard triage chip.
// Three tiers (green ≥ 60, amber 20-59, gray < 20) so operators
// triaging a backlog can prioritize by saturation at a glance.
describe("iceTier", () => {
  it("returns 'high' for totals at or above the 60 threshold", () => {
    expect(iceTier(60)).toBe("high");
    expect(iceTier(125)).toBe("high");
  });

  it("returns 'mid' for totals in [20, 60)", () => {
    expect(iceTier(20)).toBe("mid");
    expect(iceTier(59)).toBe("mid");
  });

  it("returns 'low' for totals below the 20 threshold", () => {
    expect(iceTier(0)).toBe("low");
    expect(iceTier(19)).toBe("low");
    expect(iceTier(4)).toBe("low");
  });
});

describe("ICE_TIER_META", () => {
  it("has an entry per tier with fg / bg / border tokens", () => {
    for (const tier of ["high", "mid", "low"] as const) {
      const meta = ICE_TIER_META[tier];
      expect(meta.fg).toMatch(/^#/);
      expect(meta.bg.length).toBeGreaterThan(0);
      expect(meta.border.length).toBeGreaterThan(0);
    }
  });
});
