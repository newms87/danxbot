import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assignedCards,
  busyAgents,
  resetAgentLocksQueryFn,
  setAgentLocksQueryFn,
} from "./agent-locks.js";

interface MockDispatchRow {
  repoName: string;
  agentName: string | null;
  status: string;
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

const SQL_BUSY_AGENTS = normalizeSql(
  `SELECT DISTINCT agent_name FROM dispatches
     WHERE repo_name = $1
       AND agent_name IS NOT NULL
       AND "status" NOT IN ('completed', 'failed', 'cancelled')`,
);
const SQL_ASSIGNED_CARDS = normalizeSql(
  `SELECT id, assigned_agent FROM issues
     WHERE repo_name = $1
       AND assigned_agent IS NOT NULL
       AND "status" NOT IN ('Done', 'Cancelled')`,
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
          !["completed", "failed", "cancelled"].includes(r.status)
        ) {
          if (!seen.has(r.agentName)) {
            seen.add(r.agentName);
            out.push({ agent_name: r.agentName });
          }
        }
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
