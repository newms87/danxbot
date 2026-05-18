import { describe, expect, it } from "vitest";
import {
  deriveStatus,
  type DeriveStatusInput,
} from "./derive-status.js";
import type { IssueStatus } from "../issue-tracker/interface.js";

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

const TS = "2026-05-16T10:00:00Z";

describe("deriveStatus — single-rule precedence", () => {
  const rows: ReadonlyArray<{
    name: string;
    overrides: Partial<DeriveStatusInput>;
    expected: IssueStatus;
  }> = [
    { name: "rule 1: cancelled_at → Cancelled", overrides: { cancelled_at: TS, status: "ToDo" }, expected: "Cancelled" },
    { name: "rule 2: completed_at → Done", overrides: { completed_at: TS, status: "ToDo" }, expected: "Done" },
    // Phase 4 (DX-584): rule 4 is live — dispatch != null derives In
    // Progress when raw status is not terminal.
    { name: "rule 4: dispatch live derives In Progress (raw ToDo)", overrides: { dispatch: { id: "d" }, status: "ToDo" }, expected: "In Progress" },
    { name: "rule 4: dispatch live derives In Progress (raw Review)", overrides: { dispatch: { id: "d" }, status: "Review" }, expected: "In Progress" },
    { name: "rule 5: ready_at → ToDo", overrides: { ready_at: TS, status: "Review" }, expected: "ToDo" },
    { name: "rule 6: archived_at → Backlog", overrides: { archived_at: TS, status: "Review" }, expected: "Backlog" },
    { name: "rule 7: fallthrough → raw status (Review)", overrides: { status: "Review" }, expected: "Review" },
    { name: "rule 7: fallthrough → raw status (ToDo)", overrides: { status: "ToDo" }, expected: "ToDo" },
    { name: "rule 7: fallthrough → raw status (In Progress)", overrides: { status: "In Progress" }, expected: "In Progress" },
    { name: "rule 7: fallthrough → raw status (Done)", overrides: { status: "Done" }, expected: "Done" },
    { name: "rule 7: fallthrough → raw status (Cancelled)", overrides: { status: "Cancelled" }, expected: "Cancelled" },
    { name: "rule 7: fallthrough → raw status (Backlog)", overrides: { status: "Backlog" }, expected: "Backlog" },
  ];

  for (const r of rows) {
    it(r.name, () => {
      expect(deriveStatus(input(r.overrides))).toBe(r.expected);
    });
  }
});

describe("deriveStatus — DX-658 blocked gate is orthogonal to derived status (AC #2)", () => {
  it("returns the same derived status whether blocked is null or populated (ready_at path)", () => {
    const base = input({
      ready_at: TS,
      status: "ToDo",
    });
    const withGate = { ...base, blocked: { at: TS } };
    expect(deriveStatus(base)).toBe(deriveStatus(withGate));
    expect(deriveStatus(base)).toBe("ToDo");
  });

  it("returns the same derived status whether blocked is null or populated (review fallthrough)", () => {
    const base = input({ status: "Review" });
    const withGate = { ...base, blocked: { at: TS } };
    expect(deriveStatus(base)).toBe(deriveStatus(withGate));
    expect(deriveStatus(base)).toBe("Review");
  });

  it("returns the same derived status whether blocked is null or populated (dispatch path)", () => {
    const base = input({
      dispatch: { id: "d" },
      status: "ToDo",
    });
    const withGate = { ...base, blocked: { at: TS } };
    expect(deriveStatus(base)).toBe(deriveStatus(withGate));
    expect(deriveStatus(base)).toBe("In Progress");
  });

  it("returns the same derived status whether blocked is null or populated (archived path)", () => {
    const base = input({
      archived_at: TS,
      status: "Review",
    });
    const withGate = { ...base, blocked: { at: TS } };
    expect(deriveStatus(base)).toBe(deriveStatus(withGate));
    expect(deriveStatus(base)).toBe("Backlog");
  });
});

describe("deriveStatus — precedence combinations", () => {
  it("cancelled_at beats every other rule", () => {
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
          dispatch: { id: "d" },
          blocked: { at: TS },
          ready_at: TS,
          archived_at: TS,
          status: "ToDo",
        }),
      ),
    ).toBe("Done");
  });

  it("rule 4 (Phase 4 / DX-584) — dispatch live derives In Progress, guarded against raw terminal", () => {
    // Phase 4 lands rule 4: dispatch != null derives In Progress when
    // raw status is not terminal. Legacy Done/Cancelled cards with a
    // lingering dispatch fall through to rule 7 so the heal pass can
    // detect + flush them.
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "ToDo" }))).toBe("In Progress");
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "Done" }))).toBe("Done");
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "Cancelled" }))).toBe("Cancelled");
    expect(deriveStatus(input({ dispatch: { id: "d" }, status: "In Progress" }))).toBe("In Progress");
  });

  it("ready_at + archived_at → ToDo (rule 5 beats rule 6)", () => {
    expect(
      deriveStatus(
        input({
          ready_at: TS,
          archived_at: TS,
          status: "Review",
        }),
      ),
    ).toBe("ToDo");
  });

  it("archived_at alone → Backlog", () => {
    expect(
      deriveStatus(input({ archived_at: TS, status: "Review" })),
    ).toBe("Backlog");
  });

  it("no timestamps + raw status → falls through to raw (rule-7 deviation)", () => {
    // Documents the deviation from spec rule 7 ("else → Review") in
    // favor of "else → raw issue.status" so existing on-disk YAMLs
    // with all-null v10 timestamps don't flip to Review on load.
    expect(deriveStatus(input({ status: "ToDo" }))).toBe("ToDo");
    expect(deriveStatus(input({ status: "In Progress" }))).toBe("In Progress");
  });
});
