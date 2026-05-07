/**
 * Unit tests for the small pure helpers in `issue-route.ts` that gate
 * dispatch-end behavior (ISS-92, Phase 2 of the poller-triage rework).
 *
 * The full handler (`handleIssueSave`) is integration-tested via
 * `src/__tests__/integration/yaml-lifecycle-memory-tracker.test.ts`. This
 * module covers the focused contract that distinguishes mid-session
 * saves (dispatch survives) from terminal saves (dispatch clears).
 */
import { describe, expect, it } from "vitest";
import { isDispatchSessionTerminal } from "./issue-route.js";
import type { Issue } from "../issue-tracker/interface.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 3,
    tracker: "memory",
    id: "ISS-1",
    external_id: "ext-1",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Test",
    description: "",
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
    ...overrides,
  };
}

describe("isDispatchSessionTerminal", () => {
  it("returns true for Done", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "Done" }))).toBe(true);
  });

  it("returns true for Cancelled", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "Cancelled" }))).toBe(
      true,
    );
  });

  it("returns true for Needs Help", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "Needs Help" }))).toBe(
      true,
    );
  });

  it("returns true for Needs Approval", () => {
    expect(
      isDispatchSessionTerminal(makeIssue({ status: "Needs Approval" })),
    ).toBe(true);
  });

  it("returns true when blocked is non-null even on a non-terminal status", () => {
    expect(
      isDispatchSessionTerminal(
        makeIssue({
          status: "ToDo",
          blocked: {
            reason: "Waits on ISS-99",
            timestamp: "2026-05-07T12:00:00Z",
            by: ["ISS-99"],
          },
        }),
      ),
    ).toBe(true);
  });

  it("returns false for mid-session ToDo (no blocked)", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "ToDo" }))).toBe(
      false,
    );
  });

  it("returns false for In Progress (mid-session save)", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "In Progress" }))).toBe(
      false,
    );
  });

  it("returns false for Review", () => {
    expect(isDispatchSessionTerminal(makeIssue({ status: "Review" }))).toBe(
      false,
    );
  });
});
