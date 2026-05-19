import { describe, expect, it } from "vitest";
import type { Issue, IssueStatus } from "../../issue-tracker/interface.js";
import { applyParentDeriveMutation, deriveParentStatus } from "./parent.js";

function child(id: string, status: IssueStatus): Issue {
  const merged: Issue = {
    schema_version: 12,
    tracker: "memory",
    id,
    external_id: `ext-${id}`,
    parent_id: "DX-1",
    children: [],
    dispatch: null,
    status,
    type: "Feature",
    title: `Title for ${id}`,
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
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };

  return merged;
}

describe("deriveParentStatus — pure helper (DX-217)", () => {
  it("returns null for empty children", () => {
    expect(deriveParentStatus([])).toBeNull();
  });

  // DX-658 retired the `any child Blocked → parent Blocked` rule —
  // `Blocked` is no longer a status; `blocked` is a pure dispatch gate
  // not propagated through parent rollup.
  //
  // DX-231 retired the `Needs Approval` parking status; the priority
  // rule that propagated it to parents went away with it. The
  // orthogonal `requires_human` field replaces the status, but it is
  // intentionally NOT propagated through parent rollup — only the
  // dispatch filter consults the field. Tests for the retired rule
  // were removed.

  describe("priority rule 2 — any In Progress", () => {
    it("In Progress wins over ToDo / Review / Done / Cancelled", () => {
      const result = deriveParentStatus([
        child("DX-2", "ToDo"),
        child("DX-3", "In Progress"),
        child("DX-4", "Done"),
      ]);
      expect(result?.status).toBe("In Progress");
    });
  });

  describe("priority rule 4 — any ToDo", () => {
    it("ToDo wins over Review / Done / Cancelled", () => {
      const result = deriveParentStatus([
        child("DX-2", "ToDo"),
        child("DX-3", "Review"),
        child("DX-4", "Done"),
      ]);
      expect(result?.status).toBe("ToDo");
    });
  });

  describe("priority rule 5 — all non-cancelled Review", () => {
    it("All Review (no Cancelled) → Review", () => {
      const result = deriveParentStatus([
        child("DX-2", "Review"),
        child("DX-3", "Review"),
      ]);
      expect(result?.status).toBe("Review");
    });

    it("Cancelled siblings excluded — still Review", () => {
      const result = deriveParentStatus([
        child("DX-2", "Review"),
        child("DX-3", "Cancelled"),
      ]);
      expect(result?.status).toBe("Review");
    });
  });

  describe("priority rule 6 — all non-cancelled Done", () => {
    it("All Done (no Cancelled) → Done", () => {
      const result = deriveParentStatus([
        child("DX-2", "Done"),
        child("DX-3", "Done"),
      ]);
      expect(result?.status).toBe("Done");
    });

    it("Cancelled siblings excluded — still Done", () => {
      const result = deriveParentStatus([
        child("DX-2", "Done"),
        child("DX-3", "Cancelled"),
      ]);
      expect(result?.status).toBe("Done");
    });
  });

  describe("priority rule 7 — all Cancelled", () => {
    it("Every child Cancelled → Cancelled", () => {
      const result = deriveParentStatus([
        child("DX-2", "Cancelled"),
        child("DX-3", "Cancelled"),
      ]);
      expect(result?.status).toBe("Cancelled");
    });
  });

  describe("edge cases", () => {
    it("Mixed Review + Done returns null", () => {
      const result = deriveParentStatus([
        child("DX-2", "Review"),
        child("DX-3", "Done"),
      ]);
      expect(result).toBeNull();
    });
  });

  it("rule string is non-empty when status is derived", () => {
    const result = deriveParentStatus([child("DX-2", "ToDo")]);
    expect(result?.rule.length).toBeGreaterThan(0);
  });

  it("ToDo + Cancelled mix → ToDo (rule 4 fires; Cancelled doesn't gate ToDo)", () => {
    const result = deriveParentStatus([
      child("DX-2", "ToDo"),
      child("DX-3", "Cancelled"),
    ]);
    expect(result?.status).toBe("ToDo");
  });

  it("rule string contains the derived status word", () => {
    expect(deriveParentStatus([child("DX-2", "Done")])?.rule).toContain("Done");
    expect(
      deriveParentStatus([child("DX-2", "Cancelled")])?.rule,
    ).toContain("Cancelled");
  });

  describe("priority rule 5b — all non-cancelled Backlog (DX-582)", () => {
    it("single Backlog child → parent Backlog", () => {
      const result = deriveParentStatus([child("DX-2", "Backlog")]);
      expect(result?.status).toBe("Backlog");
      expect(result?.rule).toContain("Backlog");
    });

    it("Backlog + Cancelled mix → Backlog (Cancelled excluded)", () => {
      const result = deriveParentStatus([
        child("DX-2", "Backlog"),
        child("DX-3", "Cancelled"),
      ]);
      expect(result?.status).toBe("Backlog");
    });

    it("Backlog + Done returns null (mixed non-cancelled — no rule fires)", () => {
      const result = deriveParentStatus([
        child("DX-2", "Backlog"),
        child("DX-3", "Done"),
      ]);
      expect(result).toBeNull();
    });

    it("Backlog beaten by In Progress (rule 2 fires before rule 5b)", () => {
      const result = deriveParentStatus([
        child("DX-2", "Backlog"),
        child("DX-3", "In Progress"),
      ]);
      expect(result?.status).toBe("In Progress");
    });

    it("Backlog beaten by ToDo (rule 3 fires before rule 5b)", () => {
      const result = deriveParentStatus([
        child("DX-2", "Backlog"),
        child("DX-3", "ToDo"),
      ]);
      expect(result?.status).toBe("ToDo");
    });

    it("Backlog + Review mixed (no Cancelled) → null (neither all-Backlog nor all-Review)", () => {
      const result = deriveParentStatus([
        child("DX-2", "Backlog"),
        child("DX-3", "Review"),
      ]);
      expect(result).toBeNull();
    });

    it("all-Backlog with archived_at-driven derivation → parent Backlog", () => {
      // Child with raw status ToDo + archived_at populated derives to
      // Backlog via rule 6; parent picks rule 5b.
      const c1 = child("DX-2", "ToDo");
      c1.archived_at = "2026-05-16T00:00:00Z";
      const c2 = child("DX-3", "ToDo");
      c2.archived_at = "2026-05-16T00:00:00Z";
      const result = deriveParentStatus([c1, c2]);
      expect(result?.status).toBe("Backlog");
    });
  });

  describe("derived child status drives rollup (not raw on-disk status)", () => {
    it("child with completed_at populated derives to Done regardless of raw status field", () => {
      const c = child("DX-2", "ToDo");
      c.completed_at = "2026-05-16T00:00:00Z";
      const result = deriveParentStatus([c]);
      // Rollup walks `deriveStatus(c)` → "Done"; parent picks rule 6.
      expect(result?.status).toBe("Done");
    });

  });
});

function makeParent(
  status: IssueStatus,
  overrides: Partial<Issue> = {},
): Issue {
  const merged: Issue = {
    schema_version: 12,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: ["DX-2"],
    dispatch: null,
    status,
    type: "Epic",
    title: "Parent",
    description: "",
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

  return merged;
}

describe("applyParentDeriveMutation — shared mutation helper (DX-217)", () => {
  const NOW = "2026-05-10T03:00:00.000Z";

  it("appends worker:auto-derive status_change with the rule as note", () => {
    const issue = makeParent("ToDo");
    const updated = applyParentDeriveMutation(
      issue,
      { status: "In Progress", rule: "Any child In Progress — parent In Progress" },
      NOW,
    );
    expect(updated.status).toBe("In Progress");
    expect(updated.history).toHaveLength(1);
    const entry = updated.history[0];
    expect(entry.actor).toBe("worker:auto-derive");
    expect(entry.event).toBe("status_change");
    expect(entry.from).toBe("ToDo");
    expect(entry.to).toBe("In Progress");
    expect(entry.note).toContain("In Progress");
    expect(entry.timestamp).toBe(NOW);
  });

  it("does not mutate the input issue (purity)", () => {
    const issue = makeParent("ToDo");
    const before = JSON.stringify(issue);
    applyParentDeriveMutation(
      issue,
      { status: "In Progress", rule: "test" },
      NOW,
    );
    expect(JSON.stringify(issue)).toBe(before);
  });

  // Terminal rollup must stamp the lifecycle timestamp so `deriveStatus`
  // (which reads `completed_at` / `cancelled_at` BEFORE falling through
  // to raw `status`) actually returns Done / Cancelled. Without the
  // stamp, an epic with `ready_at` populated stays derived as ToDo even
  // after raw status flips to Done — the bug seen on DX-638 (parent of
  // DX-639/640/641/642). Ladder timestamps are timeline; prior
  // timestamps (`ready_at`) are NEVER cleared on a forward move.
  describe("terminal rollup stamps lifecycle timestamp (DX-638 class fix)", () => {
    const READY_AT = "2026-05-18T06:29:49.000Z";

    function epicWithReady(rawStatus: IssueStatus): Issue {
      const base = makeParent(rawStatus);
      return { ...base, ready_at: READY_AT };
    }

    it("Done rollup → stamps completed_at = now, preserves ready_at", () => {
      const issue = epicWithReady("ToDo");
      const updated = applyParentDeriveMutation(
        issue,
        { status: "Done", rule: "All non-cancelled children Done — parent Done" },
        NOW,
      );
      expect(updated.completed_at).toBe(NOW);
      expect(updated.ready_at).toBe(READY_AT);
      expect(updated.cancelled_at).toBeNull();
      expect(updated.status).toBe("Done");
    });

    it("Cancelled rollup → stamps cancelled_at = now, preserves ready_at", () => {
      const issue = epicWithReady("ToDo");
      const updated = applyParentDeriveMutation(
        issue,
        { status: "Cancelled", rule: "All children Cancelled — parent Cancelled" },
        NOW,
      );
      expect(updated.cancelled_at).toBe(NOW);
      expect(updated.ready_at).toBe(READY_AT);
      expect(updated.completed_at).toBeNull();
      expect(updated.status).toBe("Cancelled");
    });

    it("Done rollup is idempotent — does not re-stamp completed_at when already set", () => {
      const EARLIER = "2026-05-17T00:00:00.000Z";
      const issue: Issue = { ...epicWithReady("Done"), completed_at: EARLIER };
      const updated = applyParentDeriveMutation(
        issue,
        { status: "Done", rule: "All non-cancelled children Done — parent Done" },
        NOW,
      );
      expect(updated.completed_at).toBe(EARLIER);
    });

    it("Cancelled rollup is idempotent — does not re-stamp cancelled_at when already set", () => {
      const EARLIER = "2026-05-17T00:00:00.000Z";
      const issue: Issue = {
        ...epicWithReady("Cancelled"),
        cancelled_at: EARLIER,
      };
      const updated = applyParentDeriveMutation(
        issue,
        { status: "Cancelled", rule: "All children Cancelled — parent Cancelled" },
        NOW,
      );
      expect(updated.cancelled_at).toBe(EARLIER);
    });

    it("non-terminal rollup (In Progress / ToDo / Review / Backlog) does NOT stamp lifecycle timestamps", () => {
      const issue = epicWithReady("Done");
      const updated = applyParentDeriveMutation(
        issue,
        { status: "In Progress", rule: "Any child In Progress — parent In Progress" },
        NOW,
      );
      expect(updated.completed_at).toBeNull();
      expect(updated.cancelled_at).toBeNull();
      expect(updated.ready_at).toBe(READY_AT);
    });
  });
});
