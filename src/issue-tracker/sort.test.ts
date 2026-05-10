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
  iceTotal?: number;
  untriaged?: boolean;
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
  if (k.untriaged) {
    i.triage.expires_at = "";
    i.triage.ice.total = 0;
  } else {
    i.triage.expires_at = "2030-01-01T00:00:00.000Z";
    i.triage.last_status = "Keep";
    i.triage.ice.total = k.iceTotal ?? 1;
  }
  i.parent_id = k.parentId ?? null;
  if (k.waitingOnBy && k.waitingOnBy.length > 0) {
    i.waiting_on = {
      reason: "wait",
      timestamp: "2030-01-01T00:00:00.000Z",
      by: k.waitingOnBy,
    };
  }
  if (k.blockedReason) {
    i.status = "Blocked";
    i.blocked = {
      reason: k.blockedReason,
      timestamp: "2030-01-01T00:00:00.000Z",
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

describe("sortIssuesForStatus — priority bucket", () => {
  it("untriaged cards sort above triaged regardless of ICE", () => {
    const a = mkIssue({ id: "ISS-1", iceTotal: 125 });
    const b = mkIssue({ id: "ISS-2", untriaged: true });
    const c = mkIssue({ id: "ISS-3", iceTotal: 64 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
      [c.id, c],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: a, mtime: 100 },
        { issue: b, mtime: 200 },
        { issue: c, mtime: 50 },
      ]),
      "ToDo",
      byId,
    );
    expect(ids(out)).toEqual(["ISS-2", "ISS-1", "ISS-3"]);
  });

  it("ICE total DESC tiebreak among triaged cards", () => {
    const a = mkIssue({ id: "ISS-10", iceTotal: 12 });
    const b = mkIssue({ id: "ISS-20", iceTotal: 60 });
    const c = mkIssue({ id: "ISS-30", iceTotal: 30 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
      [c.id, c],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: a, mtime: 100 },
        { issue: b, mtime: 200 },
        { issue: c, mtime: 300 },
      ]),
      "ToDo",
      byId,
    );
    expect(ids(out)).toEqual(["ISS-20", "ISS-30", "ISS-10"]);
  });

  it("priority DESC tiebreaks ICE-equal cards", () => {
    const a = mkIssue({ id: "ISS-1", iceTotal: 50, priority: 3.0 });
    const b = mkIssue({ id: "ISS-2", iceTotal: 50, priority: 4.5 });
    const c = mkIssue({ id: "ISS-3", iceTotal: 50, priority: 1.5 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
      [c.id, c],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: a, mtime: 100 },
        { issue: b, mtime: 200 },
        { issue: c, mtime: 50 },
      ]),
      "ToDo",
      byId,
    );
    expect(ids(out)).toEqual(["ISS-2", "ISS-1", "ISS-3"]);
  });

  it("missing priority on an Issue defaults to 3.0 via createEmptyIssue", () => {
    // mkIssue uses createEmptyIssue → priority 3.0 default.
    const a = mkIssue({ id: "ISS-1", iceTotal: 10 });
    expect(a.priority).toBe(3.0);
  });

  it("FIFO mtime tiebreak when ICE + priority equal", () => {
    const a = mkIssue({ id: "ISS-1", iceTotal: 10, priority: 3.0 });
    const b = mkIssue({ id: "ISS-2", iceTotal: 10, priority: 3.0 });
    const c = mkIssue({ id: "ISS-3", iceTotal: 10, priority: 3.0 });
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
      "ToDo",
      byId,
    );
    expect(ids(out)).toEqual(["ISS-2", "ISS-3", "ISS-1"]);
  });

  it("waiting_on / blocked tier — non-waiting cards before waiting/blocked", () => {
    const ok = mkIssue({ id: "ISS-1", iceTotal: 10 });
    const wait = mkIssue({
      id: "ISS-2",
      iceTotal: 99,
      waitingOnBy: ["ISS-99"],
    });
    const block = mkIssue({
      id: "ISS-3",
      iceTotal: 99,
      blockedReason: "stuck",
    });
    const byId = new Map<string, Issue>([
      [ok.id, ok],
      [wait.id, wait],
      [block.id, block],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: ok, mtime: 100 },
        { issue: wait, mtime: 200 },
        { issue: block, mtime: 300 },
      ]),
      "Review",
      byId,
    );
    // ok (low ICE) still beats high-ICE waiting/blocked entries; the
    // tier check runs before ICE.
    expect(ids(out)[0]).toBe("ISS-1");
  });

  it("ancestor waiting_on demotes a child to bottom tier", () => {
    const parent = mkIssue({
      id: "ISS-99",
      status: "ToDo",
      waitingOnBy: ["ISS-100"],
    });
    const child = mkIssue({
      id: "ISS-2",
      iceTotal: 99,
      parentId: "ISS-99",
    });
    const sibling = mkIssue({ id: "ISS-3", iceTotal: 10 });
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
    // sibling beats child even though child has higher ICE — ancestor
    // demotes child.
    expect(ids(out)).toEqual(["ISS-3", "ISS-2"]);
  });

  it("two untriaged cards both score +Infinity → priority + FIFO break", () => {
    const a = mkIssue({ id: "ISS-1", untriaged: true, priority: 3.0 });
    const b = mkIssue({ id: "ISS-2", untriaged: true, priority: 4.0 });
    const c = mkIssue({ id: "ISS-3", untriaged: true, priority: 3.0 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
      [c.id, c],
    ]);
    const out = sortInputsForStatus(
      asInputs([
        { issue: a, mtime: 200 },
        { issue: b, mtime: 100 },
        { issue: c, mtime: 50 },
      ]),
      "ToDo",
      byId,
    );
    // b wins on priority; c beats a on FIFO at equal priority.
    expect(ids(out)).toEqual(["ISS-2", "ISS-3", "ISS-1"]);
  });
});

describe("sortIssuesForStatus — recency bucket", () => {
  it("In Progress sorts by updated_at DESC, ignores priority + ICE", () => {
    const a = mkIssue({ id: "ISS-1", status: "In Progress", priority: 1.0, iceTotal: 1 });
    const b = mkIssue({ id: "ISS-2", status: "In Progress", priority: 5.0, iceTotal: 125 });
    const c = mkIssue({ id: "ISS-3", status: "In Progress", priority: 3.0, iceTotal: 30 });
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

  it("Done + Cancelled also use updated_at DESC", () => {
    for (const status of ["Done", "Cancelled"] as const) {
      const a = mkIssue({ id: "ISS-1", status, iceTotal: 99 });
      const b = mkIssue({ id: "ISS-2", status, iceTotal: 1 });
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
    const a = mkIssue({ id: "ISS-1", iceTotal: 10 });
    const b = mkIssue({ id: "ISS-2", iceTotal: 50 });
    const byId = new Map<string, Issue>([
      [a.id, a],
      [b.id, b],
    ]);
    const out = sortIssuesForStatus([a, b], "ToDo", byId, () => 0);
    expect(out.map((i) => i.id)).toEqual(["ISS-2", "ISS-1"]);
  });
});
