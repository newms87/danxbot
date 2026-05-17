import { describe, it, expect } from "vitest";
import {
  applyListMove,
  currentLadderIndex,
  ladderIndexForType,
  ListMoveError,
  LADDER_ORDER,
} from "./list-move.js";
import { createEmptyIssue } from "../issue-tracker/yaml.js";
import { deriveStatus } from "./derive-status.js";
import type { Issue } from "../issue-tracker/interface.js";

function fresh(seed: Partial<Issue> = {}): Issue {
  return { ...createEmptyIssue({ id: "DX-1", title: "T" }), ...seed };
}

const CTX = {
  authUsername: "monitor",
  nowIso: "2026-05-17T10:00:00.000Z",
  uuid: () => "00000000-0000-0000-0000-000000000001",
};

describe("LADDER_ORDER", () => {
  it("matches the epic body ladder", () => {
    expect(LADDER_ORDER).toEqual([
      "archived",
      "review",
      "ready",
      "blocked",
      "in_progress",
      "completed",
      "cancelled",
    ]);
  });
  it("ladderIndexForType is the array index", () => {
    expect(ladderIndexForType("archived")).toBe(0);
    expect(ladderIndexForType("cancelled")).toBe(6);
  });
});

describe("currentLadderIndex — anchors on derived status, not list_name", () => {
  it("returns review for a fresh status=Review card", () => {
    expect(currentLadderIndex(fresh({ status: "Review" }))).toBe(1);
  });
  it("returns ready for a default createEmptyIssue (status=ToDo)", () => {
    expect(currentLadderIndex(fresh())).toBe(2);
  });
  it("returns ready when ready_at is set", () => {
    expect(currentLadderIndex(fresh({ ready_at: "2026-05-17T09:00:00.000Z" }))).toBe(2);
  });
  it("returns in_progress when dispatch is set", () => {
    const issue = fresh({
      ready_at: "2026-05-17T09:00:00.000Z",
      dispatch: {
        id: "d1",
        pid: 1,
        host: "h",
        kind: "work",
        started_at: "2026-05-17T09:30:00.000Z",
        ttl_seconds: 0,
      },
    });
    expect(currentLadderIndex(issue)).toBe(4);
  });
  it("returns blocked when blocked.at is set (beats dispatch)", () => {
    const issue = fresh({
      ready_at: "2026-05-17T09:00:00.000Z",
      blocked: { at: "2026-05-17T09:30:00.000Z", reason: "r" },
    });
    expect(currentLadderIndex(issue)).toBe(3);
  });
  it("returns cancelled when cancelled_at is set (beats everything)", () => {
    const issue = fresh({
      ready_at: "x",
      completed_at: "y",
      cancelled_at: "z",
    });
    expect(currentLadderIndex(issue)).toBe(6);
  });
});

describe("applyListMove — lateral", () => {
  it("changes only list_name when dest is same type as current", () => {
    const current = fresh({ status: "Review", list_name: "Review" });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "review",
      destListName: "Inbox", // operator-renamed review list
      blockedPatch: undefined,
    });
    expect(next.list_name).toBe("Inbox");
    expect(next.ready_at).toBeNull();
    expect(next.completed_at).toBeNull();
    expect(deriveStatus(next)).toBe("Review");
  });
});

describe("applyListMove — rightward", () => {
  it("review → ready: stamps ready_at", () => {
    const current = fresh({ status: "Review" });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "ready",
      destListName: "To Do",
      blockedPatch: undefined,
    });
    expect(next.ready_at).toBe(CTX.nowIso);
    expect(next.completed_at).toBeNull();
    expect(next.list_name).toBe("To Do");
    expect(deriveStatus(next)).toBe("ToDo");
  });

  it("review → completed: stamps ready_at AND completed_at, skips blocked + in_progress gates", () => {
    const current = fresh({ status: "Review" });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "completed",
      destListName: "Done",
      blockedPatch: undefined,
    });
    expect(next.ready_at).toBe(CTX.nowIso);
    expect(next.completed_at).toBe(CTX.nowIso);
    expect(next.blocked).toBeNull();
    expect(next.dispatch).toBeNull();
    expect(deriveStatus(next)).toBe("Done");
  });

  it("review → cancelled: stamps ready_at AND cancelled_at; completed_at NOT stamped (>T excluded)", () => {
    // Wait — cancelled idx is 6 which is highest, so [2..6] includes completed (5).
    // Rightward stamps all lifecycle timestamps in the range including completed_at.
    const current = fresh({ status: "Review" });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "cancelled",
      destListName: "Cancelled",
      blockedPatch: undefined,
    });
    expect(next.ready_at).toBe(CTX.nowIso);
    expect(next.completed_at).toBe(CTX.nowIso);
    expect(next.cancelled_at).toBe(CTX.nowIso);
    expect(deriveStatus(next)).toBe("Cancelled");
  });

  it("ready → in_progress: auto-stamps human dispatch with operator identity", () => {
    const current = fresh({ status: "ToDo", ready_at: "2026-05-17T09:00:00.000Z" });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "in_progress",
      destListName: "In Progress",
      blockedPatch: undefined,
    });
    expect(next.dispatch).not.toBeNull();
    expect(next.dispatch?.host).toBe("dashboard:monitor");
    expect(next.dispatch?.kind).toBe("work");
    expect(next.dispatch?.started_at).toBe(CTX.nowIso);
    expect(next.dispatch?.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(deriveStatus(next)).toBe("In Progress");
  });

  it("review → in_progress: stamps ready_at AND dispatch (pass-through ready, dest in_progress)", () => {
    const current = fresh({ status: "Review" });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "in_progress",
      destListName: "In Progress",
      blockedPatch: undefined,
    });
    expect(next.ready_at).toBe(CTX.nowIso);
    expect(next.dispatch).not.toBeNull();
    expect(deriveStatus(next)).toBe("In Progress");
  });
});

describe("applyListMove — INTO blocked", () => {
  it("rejects when blocked patch is missing", () => {
    const current = fresh({ status: "ToDo", ready_at: "2026-05-17T09:00:00.000Z" });
    expect(() =>
      applyListMove({
        ...CTX,
        current,
        destListType: "blocked",
        destListName: "Blocked",
        blockedPatch: undefined,
      }),
    ).toThrow(ListMoveError);
  });

  it("rejects when blocked.reason is empty", () => {
    const current = fresh({ status: "ToDo", ready_at: "2026-05-17T09:00:00.000Z" });
    expect(() =>
      applyListMove({
        ...CTX,
        current,
        destListType: "blocked",
        destListName: "Blocked",
        blockedPatch: { reason: "" },
      }),
    ).toThrow(ListMoveError);
  });

  it("stamps blocked.at + reason when blocked.reason provided; clears any dispatch", () => {
    const current = fresh({
      status: "In Progress",
      ready_at: "2026-05-17T09:00:00.000Z",
      dispatch: {
        id: "d1",
        pid: 1,
        host: "h",
        kind: "work",
        started_at: "2026-05-17T09:30:00.000Z",
        ttl_seconds: 0,
      },
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "blocked",
      destListName: "Blocked",
      blockedPatch: { reason: "Waiting on design" },
    });
    expect(next.blocked).toEqual({ at: CTX.nowIso, reason: "Waiting on design" });
    expect(next.dispatch).toBeNull();
    expect(next.ready_at).toBe("2026-05-17T09:00:00.000Z"); // preserved
    expect(deriveStatus(next)).toBe("Blocked");
  });

  it("does NOT stamp ready_at / completed_at on the INTO-blocked rightward sweep (gate semantics)", () => {
    const current = fresh({ status: "Review" });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "blocked",
      destListName: "Blocked",
      blockedPatch: { reason: "Spec ambiguous" },
    });
    expect(next.ready_at).toBeNull();
    expect(next.blocked).toEqual({ at: CTX.nowIso, reason: "Spec ambiguous" });
    expect(deriveStatus(next)).toBe("Blocked");
  });
});

describe("applyListMove — OUT of blocked", () => {
  it("explicit blocked: null clears the block and applies ladder semantics for the dest", () => {
    const current = fresh({
      status: "Blocked",
      ready_at: "2026-05-17T09:00:00.000Z",
      blocked: { at: "2026-05-17T09:30:00.000Z", reason: "r" },
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "ready",
      destListName: "To Do",
      blockedPatch: null,
    });
    expect(next.blocked).toBeNull();
    expect(next.ready_at).toBe("2026-05-17T09:00:00.000Z"); // preserved
    expect(deriveStatus(next)).toBe("ToDo");
  });

  it("missing blocked patch still auto-clears when dest is non-blocked", () => {
    // Hardening: a board drag-out of blocked without the dialog still routes
    // through here and the move should auto-clear (operator dragged away from
    // Blocked, the block must lift even without the explicit confirm).
    const current = fresh({
      status: "Blocked",
      ready_at: "2026-05-17T09:00:00.000Z",
      blocked: { at: "2026-05-17T09:30:00.000Z", reason: "r" },
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "ready",
      destListName: "To Do",
      blockedPatch: undefined,
    });
    expect(next.blocked).toBeNull();
    expect(deriveStatus(next)).toBe("ToDo");
  });
});

describe("applyListMove — leftward", () => {
  it("in_progress → ready: clears dispatch, preserves ready_at", () => {
    const current = fresh({
      status: "In Progress",
      ready_at: "2026-05-17T09:00:00.000Z",
      dispatch: {
        id: "d1",
        pid: 1,
        host: "h",
        kind: "work",
        started_at: "2026-05-17T09:30:00.000Z",
        ttl_seconds: 0,
      },
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "ready",
      destListName: "To Do",
      blockedPatch: undefined,
    });
    expect(next.dispatch).toBeNull();
    expect(next.ready_at).toBe("2026-05-17T09:00:00.000Z");
    expect(deriveStatus(next)).toBe("ToDo");
  });

  it("done → ready: clears completed_at + cancelled_at + dispatch; ready_at preserved", () => {
    const current = fresh({
      status: "Done",
      ready_at: "2026-05-17T09:00:00.000Z",
      completed_at: "2026-05-17T09:30:00.000Z",
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "ready",
      destListName: "To Do",
      blockedPatch: undefined,
    });
    expect(next.completed_at).toBeNull();
    expect(next.ready_at).toBe("2026-05-17T09:00:00.000Z");
    expect(deriveStatus(next)).toBe("ToDo");
  });

  it("in_progress → archived: clears dispatch + ready_at, stamps archived_at", () => {
    const current = fresh({
      status: "In Progress",
      ready_at: "2026-05-17T09:00:00.000Z",
      dispatch: {
        id: "d1",
        pid: 1,
        host: "h",
        kind: "work",
        started_at: "2026-05-17T09:30:00.000Z",
        ttl_seconds: 0,
      },
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "archived",
      destListName: "Backlog",
      blockedPatch: undefined,
    });
    expect(next.dispatch).toBeNull();
    expect(next.ready_at).toBeNull();
    expect(next.archived_at).toBe(CTX.nowIso);
    expect(deriveStatus(next)).toBe("Backlog");
  });

  it("done → in_progress: clears completed_at + cancelled_at, stamps dispatch", () => {
    const current = fresh({
      status: "Done",
      ready_at: "2026-05-17T09:00:00.000Z",
      completed_at: "2026-05-17T09:30:00.000Z",
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "in_progress",
      destListName: "In Progress",
      blockedPatch: undefined,
    });
    expect(next.completed_at).toBeNull();
    expect(next.dispatch).not.toBeNull();
    expect(deriveStatus(next)).toBe("In Progress");
  });
});

describe("applyListMove — list_name always set", () => {
  it("sets list_name on every dest (rightward / leftward / lateral)", () => {
    const cases: { from: Partial<Issue>; destType: import("../lists-types.js").ListType; destName: string; blocked?: { reason: string } }[] = [
      { from: { status: "Review" }, destType: "ready", destName: "ToDoCustom" },
      { from: { status: "Review" }, destType: "archived", destName: "BacklogCustom" },
      { from: { status: "Review" }, destType: "blocked", destName: "Stuck", blocked: { reason: "r" } },
      { from: { status: "ToDo", ready_at: "x" }, destType: "in_progress", destName: "WIP" },
    ];
    for (const c of cases) {
      const current = fresh(c.from);
      const { next } = applyListMove({
        ...CTX,
        current,
        destListType: c.destType,
        destListName: c.destName,
        blockedPatch: c.blocked,
      });
      expect(next.list_name).toBe(c.destName);
    }
  });
});

describe("applyListMove — invalid combinations", () => {
  it("rejects blocked.reason paired with non-blocked dest", () => {
    const current = fresh({ status: "ToDo", ready_at: "2026-05-17T09:00:00.000Z" });
    expect(() =>
      applyListMove({
        ...CTX,
        current,
        destListType: "ready",
        destListName: "To Do",
        blockedPatch: { reason: "r" },
      }),
    ).toThrow(ListMoveError);
  });
});

// Critical-path regression tests added per DX-586 review findings.
describe("applyListMove — lateral within blocked (review finding)", () => {
  it("blocked → blocked-renamed (lateral): preserves blocked record, does NOT 400 on missing reason", () => {
    // Two blocked-type lists ("Blocked" → "Stuck"). The operator drags
    // between them; the existing block stays, no reason prompt fires.
    const current = fresh({
      status: "Blocked",
      ready_at: "2026-05-17T09:00:00.000Z",
      blocked: { at: "2026-05-17T09:30:00.000Z", reason: "Original reason" },
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "blocked",
      destListName: "Stuck",
      blockedPatch: undefined,
    });
    expect(next.list_name).toBe("Stuck");
    expect(next.blocked).toEqual({
      at: "2026-05-17T09:30:00.000Z",
      reason: "Original reason",
    });
    expect(deriveStatus(next)).toBe("Blocked");
  });
});

describe("applyListMove — multi-pass-through (review finding)", () => {
  it("archived → cancelled: skips blocked + in_progress gates, stamps ready_at + completed_at + cancelled_at", () => {
    const current = fresh({
      status: "Backlog",
      archived_at: "2026-05-17T08:00:00.000Z",
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "cancelled",
      destListName: "Cancelled",
      blockedPatch: undefined,
    });
    expect(next.archived_at).toBe("2026-05-17T08:00:00.000Z"); // preserved
    expect(next.ready_at).toBe(CTX.nowIso);
    expect(next.blocked).toBeNull(); // gate skipped
    expect(next.dispatch).toBeNull(); // gate skipped
    expect(next.completed_at).toBe(CTX.nowIso);
    expect(next.cancelled_at).toBe(CTX.nowIso);
    expect(deriveStatus(next)).toBe("Cancelled");
  });
});

describe("applyListMove — terminal ↔ terminal (review finding)", () => {
  it("completed → cancelled (rightward terminal): cancelled_at wins, completed_at preserved", () => {
    const current = fresh({
      status: "Done",
      ready_at: "2026-05-17T09:00:00.000Z",
      completed_at: "2026-05-17T09:30:00.000Z",
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "cancelled",
      destListName: "Cancelled",
      blockedPatch: undefined,
    });
    expect(next.completed_at).toBe("2026-05-17T09:30:00.000Z");
    expect(next.cancelled_at).toBe(CTX.nowIso);
    expect(deriveStatus(next)).toBe("Cancelled");
  });

  it("cancelled → completed (leftward terminal): clears cancelled_at, preserves completed_at", () => {
    const current = fresh({
      status: "Cancelled",
      ready_at: "2026-05-17T09:00:00.000Z",
      completed_at: "2026-05-17T09:30:00.000Z",
      cancelled_at: "2026-05-17T09:45:00.000Z",
    });
    const { next } = applyListMove({
      ...CTX,
      current,
      destListType: "completed",
      destListName: "Done",
      blockedPatch: undefined,
    });
    expect(next.cancelled_at).toBeNull();
    expect(next.completed_at).toBe("2026-05-17T09:30:00.000Z");
    expect(deriveStatus(next)).toBe("Done");
  });
});

describe("applyListMove — source mutation guard (review finding)", () => {
  it("does NOT mutate the input `current` Issue", () => {
    const current = fresh({
      status: "ToDo",
      ready_at: "2026-05-17T09:00:00.000Z",
    });
    const snapshot = JSON.parse(JSON.stringify(current));
    applyListMove({
      ...CTX,
      current,
      destListType: "in_progress",
      destListName: "In Progress",
      blockedPatch: undefined,
    });
    expect(JSON.parse(JSON.stringify(current))).toEqual(snapshot);
  });
});
