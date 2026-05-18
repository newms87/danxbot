import { describe, expect, it } from "vitest";
import type { Issue, IssueStatus } from "../../issue-tracker/interface.js";
import { applyParentDeriveMutation, deriveParentStatus } from "./parent.js";

function child(id: string, status: IssueStatus): Issue {
  const merged: Issue = {
    schema_version: 11,
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

  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      at: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

describe("deriveParentStatus — pure helper (DX-217)", () => {
  it("returns null for empty children", () => {
    expect(deriveParentStatus([])).toBeNull();
  });

  describe("priority rule 1 — any Blocked", () => {
    it("Blocked wins over every other status", () => {
      const result = deriveParentStatus([
        child("DX-2", "In Progress"),
        child("DX-3", "Done"),
        child("DX-4", "Blocked"),
      ]);
      expect(result?.status).toBe("Blocked");
      expect(result?.rule).toMatch(/Blocked/);
    });
  });

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
    expect(deriveParentStatus([child("DX-2", "Blocked")])?.rule).toContain(
      "Blocked",
    );
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

    it("Backlog beaten by Blocked (rule 1 fires first)", () => {
      const result = deriveParentStatus([
        child("DX-2", "Backlog"),
        child("DX-3", "Blocked"),
      ]);
      expect(result?.status).toBe("Blocked");
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

    it("child with blocked.at populated derives to Blocked even if raw status is ToDo", () => {
      const c = child("DX-2", "ToDo");
      c.blocked = { reason: "self-block", at: "2026-05-16T00:00:00Z" };
      const result = deriveParentStatus([c]);
      // Derivation rule 4 (blocked.at → Blocked) overrides raw `ToDo`;
      // parent picks rule 1 (any Blocked → Blocked).
      expect(result?.status).toBe("Blocked");
    });
  });
});

function makeParent(
  status: IssueStatus,
  overrides: Partial<Issue> = {},
): Issue {
  const merged: Issue = {
    schema_version: 11,
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

  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "self-block",
      at: "2026-01-01T00:00:00.000Z",
    };
  }
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

  it("stamps blocked record when derived → Blocked AND issue had no self-block", () => {
    const issue = makeParent("In Progress", { blocked: null });
    const updated = applyParentDeriveMutation(
      issue,
      { status: "Blocked", rule: "Any child Blocked — parent Blocked" },
      NOW,
    );
    expect(updated.blocked).not.toBeNull();
    expect(updated.blocked!.reason).toContain("Auto-derived from children");
    expect(updated.blocked!.reason).toContain("Blocked");
    expect(updated.blocked!.at).toBe(NOW);
  });

  it("clears blocked record when derived from Blocked → non-Blocked (invariant maintenance)", () => {
    const issue = makeParent("Blocked"); // factory stamps blocked
    expect(issue.blocked).not.toBeNull();
    const updated = applyParentDeriveMutation(
      issue,
      { status: "In Progress", rule: "Any child In Progress — parent In Progress" },
      NOW,
    );
    expect(updated.status).toBe("In Progress");
    expect(updated.blocked).toBeNull();
  });

  it("preserves an EXISTING blocked record on Blocked → Blocked re-derive (no rewrite)", () => {
    const issue = makeParent("Blocked", {
      blocked: { reason: "manual operator block", at: "2026-01-01T00:00:00.000Z" },
    });
    const updated = applyParentDeriveMutation(
      issue,
      { status: "Blocked", rule: "Any child Blocked — parent Blocked" },
      NOW,
    );
    // Existing operator block reason is preserved (the SET branch only
    // fires when blocked === null).
    expect(updated.blocked!.reason).toBe("manual operator block");
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
});
