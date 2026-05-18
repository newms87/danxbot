import { describe, expect, it } from "vitest";
import type { Issue, IssueStatus } from "./interface.js";
import { createEmptyIssue } from "./yaml.js";
import {
  ancestorWaitingOrBlocked,
  isWaitingOrBlocked,
  sortInputsForStatus,
  sortIssuesForStatus,
} from "./sort.js";

interface Knobs {
  id: string;
  status?: IssueStatus;
  priority?: number;
  parentId?: string | null;
  waitingOnBy?: string[];
  blockedReason?: string;
}

function mkIssue(k: Knobs): Issue {
  const i = createEmptyIssue({
    id: k.id,
    status: k.status ?? "ToDo",
    title: k.id,
  });
  i.priority = k.priority ?? 3.0;
  i.parent_id = k.parentId ?? null;
  if (k.waitingOnBy && k.waitingOnBy.length > 0) {
    i.waiting_on = {
      reason: "wait",
      timestamp: "2030-01-01T00:00:00.000Z",
      by: k.waitingOnBy,
    };
  }
  if (k.blockedReason) {
    i.blocked = {
      reason: k.blockedReason,
      at: "2030-01-01T00:00:00.000Z",
    };
  }
  return i;
}

function asInputs(
  rows: Array<{ issue: Issue; mtime: number }>,
): { issue: Issue; payload: Issue; updatedAtMs: number }[] {
  return rows.map((r) => ({
    issue: r.issue,
    payload: r.issue,
    updatedAtMs: r.mtime,
  }));
}

function ids(issues: Issue[]): string[] {
  return issues.map((i) => i.id);
}

describe("sortIssuesForStatus — priority bucket (DX-627 canon)", () => {
  it("priority DESC orders cards inside the bucket", () => {
    const low = mkIssue({ id: "ISS-1", priority: 2.0 });
    const high = mkIssue({ id: "ISS-2", priority: 4.0 });
    const mid = mkIssue({ id: "ISS-3", priority: 3.0 });
    const byId = new Map<string, Issue>([
      [low.id, low],
      [high.id, high],
      [mid.id, mid],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: low, mtime: 100 },
        { issue: high, mtime: 200 },
        { issue: mid, mtime: 50 },
      ]),
      "ToDo",
      byId,
    );
    expect(ids(out)).toEqual(["ISS-2", "ISS-3", "ISS-1"]);
  });

  it("two cards with identical priority sort by id ASC FIFO", () => {
    const a = mkIssue({ id: "ISS-1", priority: 3.0 });
    const b = mkIssue({ id: "ISS-2", priority: 3.0 });
    const c = mkIssue({ id: "ISS-3", priority: 3.0 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
      [c.id, c],
    ]);
    // mtime intentionally inverted vs id order — id ASC wins.
    const out = sortInputsForStatus(
      asInputs([
        { issue: a, mtime: 300 },
        { issue: b, mtime: 100 },
        { issue: c, mtime: 200 },
      ]),
      "ToDo",
      byId,
    );
    expect(ids(out)).toEqual(["ISS-1", "ISS-2", "ISS-3"]);
  });

  it("id-numeric tiebreak handles multi-digit ids correctly (lexicographic would fail)", () => {
    const a = mkIssue({ id: "ISS-9", priority: 3.0 });
    const b = mkIssue({ id: "ISS-10", priority: 3.0 });
    const c = mkIssue({ id: "ISS-100", priority: 3.0 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
      [c.id, c],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: c, mtime: 100 },
        { issue: b, mtime: 100 },
        { issue: a, mtime: 100 },
      ]),
      "ToDo",
      byId,
    );
    // 9 < 10 < 100 — id-numeric parser beats string localeCompare.
    expect(ids(out)).toEqual(["ISS-9", "ISS-10", "ISS-100"]);
  });

  it("missing priority on an Issue defaults to 3.0 via createEmptyIssue", () => {
    const a = mkIssue({ id: "ISS-1" });
    expect(a.priority).toBe(3.0);
  });

  it("waiting_on / blocked tier — non-waiting cards before waiting/blocked, regardless of priority", () => {
    const ok = mkIssue({ id: "ISS-1", priority: 1.0 });
    const waitHi = mkIssue({
      id: "ISS-2",
      priority: 5.0,
      waitingOnBy: ["ISS-99"],
    });
    const blockHi = mkIssue({
      id: "ISS-3",
      priority: 5.0,
      blockedReason: "stuck",
    });
    const byId = new Map<string, Issue>([
      [ok.id, ok],
      [waitHi.id, waitHi],
      [blockHi.id, blockHi],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: ok, mtime: 100 },
        { issue: waitHi, mtime: 200 },
        { issue: blockHi, mtime: 300 },
      ]),
      "Review",
      byId,
    );
    // The tier check runs before priority: low-priority OK still beats
    // high-priority waiting/blocked entries.
    expect(ids(out)[0]).toBe("ISS-1");
  });

  it("malformed ids fall back to localeCompare at the FIFO tier", () => {
    const good = mkIssue({ id: "ISS-2", priority: 3.0 });
    const malformed = mkIssue({ id: "no-numeric-suffix", priority: 3.0 });
    const byId = new Map<string, Issue>([
      [good.id, good],
      [malformed.id, malformed],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: good, mtime: 100 },
        { issue: malformed, mtime: 200 },
      ]),
      "ToDo",
      byId,
    );
    // parseIdNumeric returns null for "no-numeric-suffix" → localeCompare:
    // "ISS-2" < "no-numeric-suffix" (uppercase 'I' < lowercase 'n').
    expect(ids(out)).toEqual(["ISS-2", "no-numeric-suffix"]);
  });

  it("ancestor waiting_on demotes a child to bottom tier", () => {
    const parent = mkIssue({
      id: "ISS-99",
      status: "ToDo",
      waitingOnBy: ["ISS-100"],
    });
    const child = mkIssue({
      id: "ISS-2",
      priority: 5.0,
      parentId: "ISS-99",
    });
    const sibling = mkIssue({ id: "ISS-3", priority: 1.0 });
    const byId = new Map<string, Issue>([
      [parent.id, parent],
      [child.id, child],
      [sibling.id, sibling],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: child, mtime: 100 },
        { issue: sibling, mtime: 200 },
      ]),
      "ToDo",
      byId,
    );
    // sibling beats child even though child has higher priority — ancestor
    // demotes child.
    expect(ids(out)).toEqual(["ISS-3", "ISS-2"]);
  });
});

describe("sortIssuesForStatus — recency bucket", () => {
  it("In Progress sorts by updated_at DESC, ignores priority", () => {
    const a = mkIssue({ id: "ISS-1", status: "In Progress", priority: 1.0 });
    const b = mkIssue({ id: "ISS-2", status: "In Progress", priority: 5.0 });
    const c = mkIssue({ id: "ISS-3", status: "In Progress", priority: 3.0 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
      [c.id, c],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: a, mtime: 300 },
        { issue: b, mtime: 100 },
        { issue: c, mtime: 200 },
      ]),
      "In Progress",
      byId,
    );
    expect(ids(out)).toEqual(["ISS-1", "ISS-3", "ISS-2"]);
  });

  it("Backlog uses updated_at DESC (DX-582 — parked cards land in recency bucket)", () => {
    const a = mkIssue({ id: "ISS-1", status: "Backlog", priority: 1.0 });
    const b = mkIssue({ id: "ISS-2", status: "Backlog", priority: 5.0 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
    ]);
    // Priority is ignored in the recency bucket; freshly archived sinks
    // to the top of the column.
    const out = sortInputsForStatus(
      asInputs([
        { issue: a, mtime: 500 },
        { issue: b, mtime: 100 },
      ]),
      "Backlog",
      byId,
    );
    expect(ids(out)).toEqual(["ISS-1", "ISS-2"]);
  });

  it("Done + Cancelled also use updated_at DESC", () => {
    for (const status of ["Done", "Cancelled"] as const) {
      const a = mkIssue({ id: "ISS-1", status, priority: 5.0 });
      const b = mkIssue({ id: "ISS-2", status, priority: 1.0 });
      const byId = new Map<string, Issue>([
        [a.id, a],
        [b.id, b],
      ]);
      const out = sortInputsForStatus(
        asInputs([
          { issue: a, mtime: 50 },
          { issue: b, mtime: 200 },
        ]),
        status,
        byId,
      );
      expect(ids(out)).toEqual(["ISS-2", "ISS-1"]);
    }
  });
});

describe("ancestorWaitingOrBlocked", () => {
  it("returns false when there is no parent chain", () => {
    const i = mkIssue({ id: "ISS-1" });
    expect(ancestorWaitingOrBlocked(i, new Map([[i.id, i]]))).toBe(false);
  });

  it("returns true when a grandparent has waiting_on", () => {
    const gp = mkIssue({ id: "ISS-1", waitingOnBy: ["ISS-99"] });
    const p = mkIssue({ id: "ISS-2", parentId: "ISS-1" });
    const c = mkIssue({ id: "ISS-3", parentId: "ISS-2" });
    const byId = new Map<string, Issue>([
      [gp.id, gp],
      [p.id, p],
      [c.id, c],
    ]);
    expect(ancestorWaitingOrBlocked(c, byId)).toBe(true);
  });

  it("returns true when an ancestor has blocked", () => {
    const p = mkIssue({ id: "ISS-1", blockedReason: "stuck" });
    const c = mkIssue({ id: "ISS-2", parentId: "ISS-1" });
    const byId = new Map<string, Issue>([
      [p.id, p],
      [c.id, c],
    ]);
    expect(ancestorWaitingOrBlocked(c, byId)).toBe(true);
  });

  it("cycle-safe", () => {
    const a = mkIssue({ id: "ISS-1", parentId: "ISS-2" });
    const b = mkIssue({ id: "ISS-2", parentId: "ISS-1" });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
    ]);
    expect(ancestorWaitingOrBlocked(a, byId)).toBe(false);
  });
});

describe("isWaitingOrBlocked", () => {
  it("true when card itself is waiting", () => {
    const i = mkIssue({ id: "ISS-1", waitingOnBy: ["ISS-99"] });
    expect(isWaitingOrBlocked(i, new Map([[i.id, i]]))).toBe(true);
  });

  it("true when card itself is blocked", () => {
    const i = mkIssue({ id: "ISS-1", blockedReason: "x" });
    expect(isWaitingOrBlocked(i, new Map([[i.id, i]]))).toBe(true);
  });

  it("false when neither card nor ancestor are waiting/blocked", () => {
    const p = mkIssue({ id: "ISS-1" });
    const c = mkIssue({ id: "ISS-2", parentId: "ISS-1" });
    expect(
      isWaitingOrBlocked(
        c,
        new Map<string, Issue>([
          [p.id, p],
          [c.id, c],
        ]),
      ),
    ).toBe(false);
  });
});

describe("sortIssuesForStatus convenience overload", () => {
  it("returns Issue[] sorted via the same logic", () => {
    const a = mkIssue({ id: "ISS-1", priority: 2.0 });
    const b = mkIssue({ id: "ISS-2", priority: 4.0 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
    ]);
    const out = sortIssuesForStatus([a, b], "ToDo", byId, () => 0);
    expect(out.map((i) => i.id)).toEqual(["ISS-2", "ISS-1"]);
  });
});
