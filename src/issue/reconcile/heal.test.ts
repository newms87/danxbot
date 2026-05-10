import { describe, expect, it } from "vitest";
import type { Issue, IssueStatus } from "../../issue-tracker/interface.js";
import { decideFileMove } from "./heal.js";

function makeIssue(
  status: IssueStatus,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    schema_version: 6,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status,
    type: "Feature",
    title: "Title",
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
    blocked:
      status === "Blocked"
        ? { reason: "self-block", timestamp: "2026-01-01T00:00:00.000Z" }
        : null,
    assigned_agent: null,
    waiting_on: null,
    requires_human: null,
    history: [],
    ...overrides,
  };
}

describe("decideFileMove — pure helper (DX-217)", () => {
  describe("no-op cases (idempotency)", () => {
    it("Done in closed/ → null (file already in correct bucket)", () => {
      expect(decideFileMove(makeIssue("Done"), "closed")).toBeNull();
    });

    it("Cancelled in closed/ → null", () => {
      expect(decideFileMove(makeIssue("Cancelled"), "closed")).toBeNull();
    });

    it("ToDo in open/ → null", () => {
      expect(decideFileMove(makeIssue("ToDo"), "open")).toBeNull();
    });

    it("In Progress in open/ → null", () => {
      expect(decideFileMove(makeIssue("In Progress"), "open")).toBeNull();
    });

    it("Review in open/ → null", () => {
      expect(decideFileMove(makeIssue("Review"), "open")).toBeNull();
    });

    it("Blocked in open/ → null (Blocked is non-terminal)", () => {
      expect(decideFileMove(makeIssue("Blocked"), "open")).toBeNull();
    });
    // DX-231 retired the `Needs Approval` parking status — the
    // corresponding heal-direction case went away with it.
  });

  describe("open → closed direction (terminal in wrong bucket)", () => {
    it("Done in open/ → move to closed/, no heal entry", () => {
      const result = decideFileMove(makeIssue("Done"), "open");
      expect(result).not.toBeNull();
      expect(result?.targetDir).toBe("closed");
      expect(result?.healEntry).toBeNull();
    });

    it("Cancelled in open/ → move to closed/, no heal entry", () => {
      const result = decideFileMove(makeIssue("Cancelled"), "open");
      expect(result?.targetDir).toBe("closed");
      expect(result?.healEntry).toBeNull();
    });
  });

  describe("closed → open direction (drifted-back inverse heal)", () => {
    it("ToDo in closed/ → move to open/, heal entry with from=Done (default)", () => {
      const result = decideFileMove(makeIssue("ToDo"), "closed");
      expect(result?.targetDir).toBe("open");
      expect(result?.healEntry).not.toBeNull();
      const entry = result!.healEntry!;
      expect(entry.actor).toBe("worker:heal");
      expect(entry.event).toBe("status_change");
      expect(entry.from).toBe("Done");
      expect(entry.to).toBe("ToDo");
      expect(entry.note).toMatch(/closed.*open/);
      // Orchestrator is responsible for stamping the timestamp.
      expect(entry.timestamp).toBe("");
    });

    it("In Progress in closed/ → move to open/, from=Done default", () => {
      const result = decideFileMove(makeIssue("In Progress"), "closed");
      expect(result?.targetDir).toBe("open");
      expect(result?.healEntry?.from).toBe("Done");
      expect(result?.healEntry?.to).toBe("In Progress");
    });

    it("infers from=Cancelled when most recent terminal in history is Cancelled", () => {
      const issue = makeIssue("ToDo", {
        history: [
          {
            timestamp: "2026-01-01T00:00:00.000Z",
            actor: "worker:agent",
            event: "status_change",
            from: "In Progress",
            to: "Done",
          },
          {
            timestamp: "2026-01-02T00:00:00.000Z",
            actor: "worker:agent",
            event: "status_change",
            from: "Done",
            to: "Cancelled",
          },
        ],
      });
      const result = decideFileMove(issue, "closed");
      expect(result?.healEntry?.from).toBe("Cancelled");
    });

    it("infers from=Done when most recent terminal in history is Done", () => {
      const issue = makeIssue("Review", {
        history: [
          {
            timestamp: "2026-01-01T00:00:00.000Z",
            actor: "worker:agent",
            event: "status_change",
            from: "In Progress",
            to: "Done",
          },
        ],
      });
      const result = decideFileMove(issue, "closed");
      expect(result?.healEntry?.from).toBe("Done");
    });

    it("ignores non-terminal history entries when inferring from", () => {
      const issue = makeIssue("ToDo", {
        history: [
          {
            timestamp: "2026-01-01T00:00:00.000Z",
            actor: "worker:agent",
            event: "status_change",
            from: "ToDo",
            to: "In Progress",
          },
          {
            timestamp: "2026-01-02T00:00:00.000Z",
            actor: "worker:agent",
            event: "status_change",
            from: "In Progress",
            to: "Cancelled",
          },
          {
            timestamp: "2026-01-03T00:00:00.000Z",
            actor: "worker:agent",
            event: "status_change",
            from: "Cancelled",
            to: "ToDo",
          },
        ],
      });
      const result = decideFileMove(issue, "closed");
      expect(result?.healEntry?.from).toBe("Cancelled");
    });
  });
});
