import { describe, expect, it } from "vitest";
import {
  deriveStatus,
  type DeriveStatusInput,
} from "./derive-status";

const TS = "2026-05-16T10:00:00Z";

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
  it("rule 3 deferred — dispatch alone does NOT derive In Progress (Phase 4 / DX-584)", () => {
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "ToDo" }))).toBe("ToDo");
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "Done" }))).toBe("Done");
  });
  it("rule 4: blocked.at → Blocked", () => {
    expect(deriveStatus(input({ blocked: { at: TS }, status: "ToDo" }))).toBe("Blocked");
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

  it("dispatch + blocked.at → Blocked (rule 4 fires regardless of dispatch)", () => {
    expect(deriveStatus(input({ dispatch: { id: "d" }, blocked: { at: TS } }))).toBe("Blocked");
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

  it("completed_at beats blocked / ready_at / archived_at", () => {
    expect(
      deriveStatus(
        input({
          completed_at: TS,
          blocked: { at: TS },
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
