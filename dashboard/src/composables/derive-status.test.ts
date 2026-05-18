import { describe, expect, it } from "vitest";
import {
  deriveListTypeFromStatus,
  derivedListName,
  deriveStatus,
  type DeriveStatusInput,
} from "./derive-status";
import type { List } from "../types";

const TS = "2026-05-16T10:00:00Z";

const SEED_LISTS: readonly List[] = [
  { id: "lst-arc", name: "Backlog",     type: "archived",    order: 0, is_default_for_type: true, color: "#64748b" },
  { id: "lst-rev", name: "Review",      type: "review",      order: 1, is_default_for_type: true, color: "#3b82f6" },
  { id: "lst-rdy", name: "To Do",       type: "ready",       order: 2, is_default_for_type: true, color: "#22d3ee" },
  { id: "lst-wip", name: "In Progress", type: "in_progress", order: 4, is_default_for_type: true, color: "#f59e0b" },
  { id: "lst-don", name: "Done",        type: "completed",   order: 5, is_default_for_type: true, color: "#22c55e" },
  { id: "lst-cnl", name: "Cancelled",   type: "cancelled",   order: 6, is_default_for_type: true, color: "#71717a" },
];

function input(overrides: Partial<DeriveStatusInput> = {}): DeriveStatusInput {
  return {
    status: "Review",
    dispatch: null,
    blocked: null,
    ready_at: null,
    archived_at: null,
    completed_at: null,
    cancelled_at: null,
    ...overrides,
  };
}

describe("SPA deriveStatus — mirrors backend rules", () => {
  it("rule 1: cancelled_at → Cancelled", () => {
    expect(deriveStatus(input({ cancelled_at: TS, status: "ToDo" }))).toBe("Cancelled");
  });
  it("rule 2: completed_at → Done", () => {
    expect(deriveStatus(input({ completed_at: TS, status: "ToDo" }))).toBe("Done");
  });
  it("rule 4 (Phase 4 / DX-584) — dispatch live derives In Progress, guarded against raw terminal", () => {
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "ToDo" }))).toBe("In Progress");
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "Done" }))).toBe("Done");
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "Cancelled" }))).toBe("Cancelled");
  });
  it("rule 5: ready_at → ToDo", () => {
    expect(deriveStatus(input({ ready_at: TS, status: "Review" }))).toBe("ToDo");
  });
  it("rule 6: archived_at → Backlog", () => {
    expect(deriveStatus(input({ archived_at: TS, status: "Review" }))).toBe("Backlog");
  });
  it("rule 7: fallthrough → raw status", () => {
    expect(deriveStatus(input({ status: "Review" }))).toBe("Review");
    expect(deriveStatus(input({ status: "In Progress" }))).toBe("In Progress");
  });

  it("ready_at + archived_at → ToDo (rule 5 beats rule 6)", () => {
    expect(deriveStatus(input({ ready_at: TS, archived_at: TS }))).toBe("ToDo");
  });

  it("cancelled_at beats every other rule (maximal precedence)", () => {
    expect(
      deriveStatus(
        input({
          cancelled_at: TS,
          completed_at: TS,
          dispatch: { id: "d" },
          blocked: { at: TS },
          ready_at: TS,
          archived_at: TS,
          status: "Review",
        }),
      ),
    ).toBe("Cancelled");
  });

  it("completed_at beats ready_at / archived_at", () => {
    expect(
      deriveStatus(
        input({
          completed_at: TS,
          ready_at: TS,
          archived_at: TS,
          status: "ToDo",
        }),
      ),
    ).toBe("Done");
  });

  it("rule 3 deferral parity — dispatch with Cancelled / In Progress fallthrough", () => {
    // Mirror the backend's full rule-3 deferral coverage for byte-
    // identical fixture parity.
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "Cancelled" }))).toBe("Cancelled");
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "In Progress" }))).toBe("In Progress");
  });
});

describe("DX-639 deriveListTypeFromStatus — total over IssueStatus", () => {
  it("maps every IssueStatus to its canonical ListType", () => {
    expect(deriveListTypeFromStatus("Backlog")).toBe("archived");
    expect(deriveListTypeFromStatus("Review")).toBe("review");
    expect(deriveListTypeFromStatus("ToDo")).toBe("ready");
    expect(deriveListTypeFromStatus("In Progress")).toBe("in_progress");
    expect(deriveListTypeFromStatus("Done")).toBe("completed");
    expect(deriveListTypeFromStatus("Cancelled")).toBe("cancelled");
  });
});

describe("DX-639 derivedListName — projects from triggers + lists taxonomy", () => {
  it("projects from terminal trigger, ignoring raw status drift", () => {
    // The DX-624 failure shape — disk says `In Progress` but the
    // completed_at trigger fired; derivation lands on Done's list.
    expect(
      derivedListName(
        input({ completed_at: TS, status: "In Progress" }),
        SEED_LISTS,
      ),
    ).toBe("Done");
  });

  it("projects to operator-renamed default list (custom name on `ready` type)", () => {
    const renamed = SEED_LISTS.map((l) =>
      l.type === "ready" ? { ...l, name: "Up Next" } : l,
    );
    expect(
      derivedListName(input({ ready_at: TS, status: "Review" }), renamed),
    ).toBe("Up Next");
  });

  it("returns null when the taxonomy has no default for the projected type", () => {
    const noReadyDefault = SEED_LISTS.filter((l) => l.type !== "ready");
    expect(
      derivedListName(input({ ready_at: TS, status: "Review" }), noReadyDefault),
    ).toBeNull();
  });

  it("falls through to raw status (rule 7) for an empty-trigger Review card", () => {
    expect(derivedListName(input({ status: "Review" }), SEED_LISTS)).toBe(
      "Review",
    );
  });

  it("picks the default-of-type even when a non-default list of the same type comes first", () => {
    // Exercises the `is_default_for_type` predicate — without it, the
    // first-by-array-order `ready`-type list would win, masking the
    // intent. "Sprint 1 Backlog" sits before the canonical default in
    // the array; derivation MUST still land on "To Do".
    const withSecondReady: List[] = [
      { id: "lst-sprint", name: "Sprint 1 Backlog", type: "ready", order: 0, is_default_for_type: false, color: "#111" },
      ...SEED_LISTS,
    ];
    expect(
      derivedListName(input({ ready_at: TS, status: "Review" }), withSecondReady),
    ).toBe("To Do");
  });

  it("projects a live-dispatch card to in_progress regardless of raw status", () => {
    // Rule 4 coverage through the composition — a card with dispatch
    // live but raw status "ToDo" should land in In Progress, not To Do.
    expect(
      derivedListName(
        input({ dispatch: { id: "d" }, status: "ToDo" }),
        SEED_LISTS,
      ),
    ).toBe("In Progress");
  });
});
