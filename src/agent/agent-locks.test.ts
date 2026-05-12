import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assignedCards,
  busyAgents,
  lastTerminalDispatchStatusByIssue,
  liveDispatchIssueIds,
  resetAgentLocksQueryFn,
  setAgentLocksQueryFn,
} from "./agent-locks.js";

interface MockDispatchRow {
  repoName: string;
  agentName: string | null;
  status: string;
  issueId?: string | null;
  pidTerminatedAt?: number | null;
  startedAt?: number;
}

interface MockIssueRow {
  repoName: string;
  id: string;
  assignedAgent: string | null;
  status: string;
}

const dispatches: MockDispatchRow[] = [];
const issues: MockIssueRow[] = [];

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// DX-322 — derive the terminal set from the production `TERMINAL_STATUSES`
// constant. Test fixture used to inline it (with the spurious
// `critical_failure` / `api_error_failed` / `timeout` entries removed by
// the refactor); pinning the inline copy would now drift on every future
// terminal-status addition. Re-import keeps the test honest.
import { TERMINAL_STATUSES as PROD_TERMINAL_STATUSES } from "../dashboard/dispatches.js";
const TERMINAL_DISPATCH_STATUSES: readonly string[] = PROD_TERMINAL_STATUSES;
const TERMINAL_PLACEHOLDERS = PROD_TERMINAL_STATUSES.map(
  (_, i) => `$${i + 2}`,
).join(", ");
const SQL_BUSY_AGENTS = normalizeSql(
  `SELECT DISTINCT agent_name FROM dispatches
     WHERE repo_name = $1
       AND agent_name IS NOT NULL
       AND "status" NOT IN (${TERMINAL_PLACEHOLDERS})`,
);
const SQL_ASSIGNED_CARDS = normalizeSql(
  `SELECT id, assigned_agent FROM issues
     WHERE repo_name = $1
       AND assigned_agent IS NOT NULL
       AND "status" NOT IN ('Done', 'Cancelled')`,
);
const SQL_LIVE_DISPATCH_ISSUE_IDS = normalizeSql(
  `SELECT DISTINCT issue_id FROM dispatches
     WHERE repo_name = $1
       AND issue_id IS NOT NULL
       AND "status" NOT IN (${TERMINAL_PLACEHOLDERS})
       AND pid_terminated_at IS NULL`,
);
const SQL_LAST_TERMINAL_BY_ISSUE = normalizeSql(
  `SELECT DISTINCT ON (issue_id) issue_id, "status"
     FROM dispatches
     WHERE repo_name = $1
       AND issue_id IS NOT NULL
       AND "status" IN (${TERMINAL_PLACEHOLDERS})
     ORDER BY issue_id, started_at DESC`,
);

beforeEach(() => {
  dispatches.length = 0;
  issues.length = 0;
  setAgentLocksQueryFn(async (sql, params) => {
    const norm = normalizeSql(sql);
    const p = params ?? [];
    if (norm === SQL_BUSY_AGENTS) {
      const [repoName] = p as [string];
      const seen = new Set<string>();
      const out: { agent_name: string }[] = [];
      for (const r of dispatches) {
        if (
          r.repoName === repoName &&
          r.agentName !== null &&
          r.agentName.length > 0 &&
          !TERMINAL_DISPATCH_STATUSES.includes(r.status)
        ) {
          if (!seen.has(r.agentName)) {
            seen.add(r.agentName);
            out.push({ agent_name: r.agentName });
          }
        }
      }
      return out as never;
    }
    if (norm === SQL_LIVE_DISPATCH_ISSUE_IDS) {
      const [repoName] = p as [string];
      const seen = new Set<string>();
      const out: { issue_id: string }[] = [];
      for (const r of dispatches) {
        if (
          r.repoName === repoName &&
          typeof r.issueId === "string" &&
          r.issueId.length > 0 &&
          !TERMINAL_DISPATCH_STATUSES.includes(r.status) &&
          (r.pidTerminatedAt === undefined || r.pidTerminatedAt === null)
        ) {
          if (!seen.has(r.issueId)) {
            seen.add(r.issueId);
            out.push({ issue_id: r.issueId });
          }
        }
      }
      return out as never;
    }
    if (norm === SQL_LAST_TERMINAL_BY_ISSUE) {
      const [repoName] = p as [string];
      // Group by issue_id, pick row with greatest startedAt (DESC).
      const byIssue = new Map<string, MockDispatchRow>();
      for (const r of dispatches) {
        if (
          r.repoName !== repoName ||
          typeof r.issueId !== "string" ||
          r.issueId.length === 0 ||
          !TERMINAL_DISPATCH_STATUSES.includes(r.status)
        ) {
          continue;
        }
        const prior = byIssue.get(r.issueId);
        if (!prior || (r.startedAt ?? 0) > (prior.startedAt ?? 0)) {
          byIssue.set(r.issueId, r);
        }
      }
      const out: { issue_id: string; status: string }[] = [];
      for (const [issueId, row] of byIssue) {
        out.push({ issue_id: issueId, status: row.status });
      }
      return out as never;
    }
    if (norm === SQL_ASSIGNED_CARDS) {
      const [repoName] = p as [string];
      const out: { id: string; assigned_agent: string }[] = [];
      for (const r of issues) {
        if (
          r.repoName === repoName &&
          r.assignedAgent !== null &&
          r.assignedAgent.length > 0 &&
          !["Done", "Cancelled"].includes(r.status)
        ) {
          out.push({ id: r.id, assigned_agent: r.assignedAgent });
        }
      }
      return out as never;
    }
    throw new Error(`Unhandled SQL in agent-locks test: ${norm}`);
  });
});

afterEach(() => {
  resetAgentLocksQueryFn();
});

describe("busyAgents", () => {
  it("returns the names of every agent with a non-terminal dispatch", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "running" },
      { repoName: "danxbot", agentName: "bob", status: "queued" },
      { repoName: "danxbot", agentName: "charlie", status: "completed" },
      { repoName: "danxbot", agentName: "dave", status: "failed" },
      { repoName: "danxbot", agentName: "erin", status: "cancelled" },
    );
    const out = await busyAgents("danxbot");
    expect(out).toEqual(new Set(["alice", "bob"]));
  });

  it("scopes to the repo — agents busy on a different repo do not appear", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "running" },
      { repoName: "gpt-manager", agentName: "bob", status: "running" },
    );
    const out = await busyAgents("danxbot");
    expect(out).toEqual(new Set(["alice"]));
  });

  it("returns an empty set when no dispatches are in-flight", async () => {
    const out = await busyAgents("danxbot");
    expect(out.size).toBe(0);
  });

  it("dedupes when the same agent has multiple non-terminal dispatches", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "running" },
      { repoName: "danxbot", agentName: "alice", status: "queued" },
    );
    const out = await busyAgents("danxbot");
    expect(out).toEqual(new Set(["alice"]));
  });

  it("ignores dispatches whose agent_name is NULL (legacy / non-agent dispatches)", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: null, status: "running" },
      { repoName: "danxbot", agentName: "alice", status: "running" },
    );
    const out = await busyAgents("danxbot");
    expect(out).toEqual(new Set(["alice"]));
  });
});

describe("assignedCards", () => {
  it("returns a map of card id to agent name for every open issue with a claim", async () => {
    issues.push(
      { repoName: "danxbot", id: "DX-1", assignedAgent: "alice", status: "ToDo" },
      { repoName: "danxbot", id: "DX-2", assignedAgent: "bob", status: "In Progress" },
      { repoName: "danxbot", id: "DX-3", assignedAgent: null, status: "ToDo" },
    );
    const out = await assignedCards("danxbot");
    expect(out.get("DX-1")).toBe("alice");
    expect(out.get("DX-2")).toBe("bob");
    expect(out.has("DX-3")).toBe(false);
  });

  it("excludes terminal cards (Done / Cancelled)", async () => {
    issues.push(
      { repoName: "danxbot", id: "DX-1", assignedAgent: "alice", status: "Done" },
      { repoName: "danxbot", id: "DX-2", assignedAgent: "alice", status: "Cancelled" },
      { repoName: "danxbot", id: "DX-3", assignedAgent: "alice", status: "ToDo" },
    );
    const out = await assignedCards("danxbot");
    expect(out.size).toBe(1);
    expect(out.get("DX-3")).toBe("alice");
  });

  it("scopes to the repo — claims on a different repo do not appear", async () => {
    issues.push(
      { repoName: "danxbot", id: "DX-1", assignedAgent: "alice", status: "ToDo" },
      { repoName: "gpt-manager", id: "GP-1", assignedAgent: "bob", status: "ToDo" },
    );
    const out = await assignedCards("danxbot");
    expect(out.size).toBe(1);
    expect(out.get("DX-1")).toBe("alice");
  });

  it("returns an empty map when no card has a claim", async () => {
    const out = await assignedCards("danxbot");
    expect(out.size).toBe(0);
  });
});

describe("liveDispatchIssueIds", () => {
  // DX-262 follow-up — the multi-agent picker uses this set as the
  // TRUE in-progress signal, replacing the YAML status field which
  // goes stale whenever a dispatch dies outside the orderly
  // completion path.

  it("returns the issue_id of every non-terminal dispatch with a card", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "running", issueId: "DX-1" },
      { repoName: "danxbot", agentName: "bob", status: "queued", issueId: "DX-2" },
      { repoName: "danxbot", agentName: "charlie", status: "completed", issueId: "DX-3" },
      { repoName: "danxbot", agentName: "dave", status: "cancelled", issueId: "DX-4" },
    );
    const out = await liveDispatchIssueIds("danxbot");
    expect(out).toEqual(new Set(["DX-1", "DX-2"]));
  });

  it("excludes dispatches with NULL issue_id (slack / api / non-issue dispatches)", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "running", issueId: null },
      { repoName: "danxbot", agentName: "bob", status: "running", issueId: "DX-2" },
    );
    const out = await liveDispatchIssueIds("danxbot");
    expect(out).toEqual(new Set(["DX-2"]));
  });

  it("excludes dispatches whose PID has been terminated (worker recovery edge)", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "running", issueId: "DX-1", pidTerminatedAt: Date.now() },
      { repoName: "danxbot", agentName: "bob", status: "running", issueId: "DX-2", pidTerminatedAt: null },
    );
    const out = await liveDispatchIssueIds("danxbot");
    expect(out).toEqual(new Set(["DX-2"]));
  });

  it("scopes to the repo", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "running", issueId: "DX-1" },
      { repoName: "gpt-manager", agentName: "bob", status: "running", issueId: "GP-1" },
    );
    const out = await liveDispatchIssueIds("danxbot");
    expect(out).toEqual(new Set(["DX-1"]));
  });

  it("dedupes — one issue with multiple non-terminal dispatch rows surfaces once", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "running", issueId: "DX-1" },
      { repoName: "danxbot", agentName: "bob", status: "queued", issueId: "DX-1" },
    );
    const out = await liveDispatchIssueIds("danxbot");
    expect(out).toEqual(new Set(["DX-1"]));
  });

  it("empty when no live dispatch carries an issue_id", async () => {
    const out = await liveDispatchIssueIds("danxbot");
    expect(out.size).toBe(0);
  });
});

describe("lastTerminalDispatchStatusByIssue (DX-329)", () => {
  it("returns each issue's most recent terminal dispatch status", async () => {
    dispatches.push(
      // DX-1: two terminal rows; the later 'failed' wins over 'recovered'.
      { repoName: "danxbot", agentName: "alice", status: "recovered", issueId: "DX-1", startedAt: 100 },
      { repoName: "danxbot", agentName: "alice", status: "failed", issueId: "DX-1", startedAt: 200 },
      // DX-2: single terminal row.
      { repoName: "danxbot", agentName: "bob", status: "completed", issueId: "DX-2", startedAt: 50 },
    );
    const out = await lastTerminalDispatchStatusByIssue("danxbot");
    expect(out.get("DX-1")).toBe("failed");
    expect(out.get("DX-2")).toBe("completed");
  });

  it("excludes non-terminal dispatch rows (only terminal latest is reported)", async () => {
    dispatches.push(
      // DX-3 has a terminal followed by a still-running re-dispatch — the
      // helper returns the prior terminal regardless (the live row is
      // covered by `liveDispatchIssueIds`).
      { repoName: "danxbot", agentName: "alice", status: "recovered", issueId: "DX-3", startedAt: 100 },
      { repoName: "danxbot", agentName: "alice", status: "running", issueId: "DX-3", startedAt: 200 },
    );
    const out = await lastTerminalDispatchStatusByIssue("danxbot");
    expect(out.get("DX-3")).toBe("recovered");
  });

  it("excludes dispatch rows with NULL issue_id (slack / api triggers)", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "completed", issueId: null, startedAt: 100 },
      { repoName: "danxbot", agentName: "alice", status: "completed", issueId: "DX-4", startedAt: 100 },
    );
    const out = await lastTerminalDispatchStatusByIssue("danxbot");
    expect(out.has("DX-4")).toBe(true);
    expect(out.size).toBe(1);
  });

  it("scopes to the repo", async () => {
    dispatches.push(
      { repoName: "danxbot", agentName: "alice", status: "failed", issueId: "DX-5", startedAt: 100 },
      { repoName: "gpt-manager", agentName: "alice", status: "failed", issueId: "GP-5", startedAt: 100 },
    );
    const out = await lastTerminalDispatchStatusByIssue("danxbot");
    expect(out.size).toBe(1);
    expect(out.has("DX-5")).toBe(true);
  });

  it("empty when no terminal dispatch carries an issue_id", async () => {
    const out = await lastTerminalDispatchStatusByIssue("danxbot");
    expect(out.size).toBe(0);
  });
});
