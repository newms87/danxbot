import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  listIssues,
  readIssueDetail,
  readIssueHistory,
} from "../../dashboard/issues-reader.js";
import {
  resetIssueDbQueryFn,
  setIssueDbQueryFn,
} from "../../poller/issues-db.js";
import {
  clearAllRepoNames,
  setRepoName,
} from "../../poller/repo-name.js";
import type { Issue, IssueStatus } from "../../issue-tracker/interface.js";
import { serializeIssue } from "../../issue-tracker/yaml.js";

/**
 * Phase 5 of the Issues DB Mirror epic (DX-151 / DX-156).
 *
 * The dashboard's `listIssues` / `readIssueDetail` / `readIssueHistory`
 * helpers used to walk the YAML directory; under DX-156 they query the
 * `issues` + `issue_history` tables. These tests replace the prior
 * filesystem-backed setup (mkdtemp + writeFile + utimes) with an
 * in-memory DB simulator wired through `setIssueDbQueryFn` — the same
 * test hook Phase 4 (DX-155) introduced for the poller readers.
 *
 * The simulator pattern-matches on the literal SQL the reader emits and
 * filters/projects an in-memory row set. That is fragile relative to a
 * real PG instance — adding a new SQL pattern requires a new branch
 * here — but cheap (no Docker needed) and surfaces the matchers' shape
 * directly. Real-PG verification lives in
 * `src/__tests__/integration/dashboard-issues-reader.test.ts`.
 */

interface MockRow {
  repoName: string;
  issue: Issue;
  mirrorUpdatedAtMs: number;
}

interface MockHistoryRow {
  repoName: string;
  issueId: string;
  changedAtMs: number;
  source: string;
  prevHash: string | null;
  nextHash: string;
  patch: unknown;
  insertSeq: number;
}

const mockIssues: MockRow[] = [];
const mockHistory: MockHistoryRow[] = [];
let nextHistorySeq = 0;

function emptyIssue(overrides: Partial<Issue> = {}): Issue {
  const merged: Issue = {
    schema_version: 6,
    tracker: "memory",
    id: overrides.id ?? "ISS-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Title",
    description: "",
    priority: 3.0,
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
    history: [],
    ...overrides,
    blocked: overrides.blocked ?? null,
    assigned_agent: overrides.assigned_agent ?? null,
    waiting_on: overrides.waiting_on ?? null,
    requires_human: overrides.requires_human ?? null,
  };
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "issues-reader-"));
  setRepoName(repo, basename(repo));
  return repo;
}

/**
 * Test seed — populates the in-memory issues table for the named repo.
 * The `sub: "open" | "closed"` argument is preserved for parity with the
 * pre-DX-156 helper signature; it is no-op here because the DB has no
 * directory concept. The issue's `status` field is what actually drives
 * the open/closed split inside `listIssues`.
 */
function writeIssue(
  repoCwd: string,
  _sub: "open" | "closed",
  issue: Issue,
  mtimeMs: number,
): void {
  mockIssues.push({
    repoName: basename(repoCwd),
    issue,
    mirrorUpdatedAtMs: mtimeMs,
  });
}

function seedHistory(
  repoCwd: string,
  issueId: string,
  entries: Array<{
    changedAtMs: number;
    source: string;
    prevHash: string | null;
    nextHash: string;
    patch: unknown;
  }>,
): void {
  for (const e of entries) {
    mockHistory.push({
      repoName: basename(repoCwd),
      issueId,
      changedAtMs: e.changedAtMs,
      source: e.source,
      prevHash: e.prevHash,
      nextHash: e.nextHash,
      patch: e.patch,
      insertSeq: nextHistorySeq++,
    });
  }
}

/**
 * Normalize whitespace + trailing punctuation in a SQL string so the
 * simulator can match against literal expected SQL bodies without
 * caring about indentation. Match logic: collapse runs of whitespace,
 * trim ends.
 */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const SQL_LIST_ALL_ISSUES = normalizeSql(
  `SELECT data, mirror_updated_at FROM issues
     WHERE repo_name = $1
     LIMIT 5001`,
);
const SQL_SELECT_ISSUE_DETAIL = normalizeSql(
  `SELECT data, mirror_updated_at FROM issues
     WHERE repo_name = $1 AND id = $2 LIMIT 1`,
);
const SQL_LIST_ISSUE_HISTORY = normalizeSql(
  `SELECT changed_at, "source", prev_hash, next_hash, patch
     FROM issue_history
     WHERE repo_name = $1 AND issue_id = $2
     ORDER BY changed_at ASC, id ASC
     LIMIT $3`,
);

beforeEach(() => {
  mockIssues.length = 0;
  mockHistory.length = 0;
  nextHistorySeq = 0;
  setIssueDbQueryFn(async (sql, params) => {
    const p = params ?? [];
    const norm = normalizeSql(sql);

    // dbSelectIssueDetail — single row by (repo_name, id)
    if (norm === SQL_SELECT_ISSUE_DETAIL) {
      const [repoName, id] = p as [string, string];
      const match = mockIssues.find(
        (r) => r.repoName === repoName && r.issue.id === id,
      );
      if (!match) return [] as never;
      return [
        {
          data: match.issue,
          mirror_updated_at: new Date(match.mirrorUpdatedAtMs),
        },
      ] as never;
    }

    // dbListAllIssues — every row for the repo (with scale guard cap)
    if (norm === SQL_LIST_ALL_ISSUES) {
      const [repoName] = p as [string];
      return mockIssues
        .filter((r) => r.repoName === repoName)
        .map((r) => ({
          data: r.issue,
          mirror_updated_at: new Date(r.mirrorUpdatedAtMs),
        })) as never;
    }

    // dbListIssueHistory
    if (norm === SQL_LIST_ISSUE_HISTORY) {
      const [repoName, issueId, limitParam] = p as [
        string,
        string,
        number,
      ];
      const all = mockHistory
        .filter((r) => r.repoName === repoName && r.issueId === issueId)
        .sort((a, b) => {
          if (a.changedAtMs !== b.changedAtMs) {
            return a.changedAtMs - b.changedAtMs;
          }
          return a.insertSeq - b.insertSeq;
        });
      const limited = all.slice(0, limitParam);
      return limited.map((r) => ({
        changed_at: new Date(r.changedAtMs),
        source: r.source,
        prev_hash: r.prevHash,
        next_hash: r.nextHash,
        patch: r.patch,
      })) as never;
    }

    // Strict matcher — any new helper added to issues-db.ts must be
    // explicitly registered above. Substring matching let earlier
    // versions silently misroute new helpers through `dbListAllIssues`,
    // so the simulator now demands an exact match.
    throw new Error(
      `Unhandled SQL in dashboard reader simulator. Update SQL_* constants if a new helper landed.\nSQL: ${norm}\nParams: ${JSON.stringify(p)}`,
    );
  });
});

afterEach(() => {
  resetIssueDbQueryFn();
  clearAllRepoNames();
});

describe("listIssues", () => {
  it("returns IssueListItem[] with every list-card field populated correctly", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        title: "Epic title",
        description: "Epic body markdown",
        status: "In Progress",
        children: ["ISS-2", "ISS-3"],
        ac: [
          { check_item_id: "a", title: "ac1", checked: true },
          { check_item_id: "b", title: "ac2", checked: false },
        ],
        comments: [
          { author: "x", timestamp: "t1", text: "hi" },
          { author: "y", timestamp: "t2", text: "yo" },
        ],
        waiting_on: {
          reason: "waiting",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-2"],
        },
        blocked: null,
        requires_human: null,
        retro: {
          good: "ok",
          bad: "",
          action_item_ids: [],
          commits: [],
        },
      }),
      1_700_000_000_000,
    );

    const items = await listIssues(repo);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: "ISS-1",
      type: "Epic",
      title: "Epic title",
      description: "Epic body markdown",
      status: "In Progress",
      parent_id: null,
      children: ["ISS-2", "ISS-3"],
      ac_total: 2,
      ac_done: 1,
      children_detail: [
        {
          id: "ISS-2",
          name: "<ISS-2: unknown>",
          type: "Feature",
          status: "ToDo",
          waiting_on: true,
          waiting_on_by_card: false,
          missing: true,
        },
        {
          id: "ISS-3",
          name: "<ISS-3: unknown>",
          type: "Feature",
          status: "ToDo",
          waiting_on: true,
          waiting_on_by_card: false,
          missing: true,
        },
      ],
      waiting_on: true,
      waiting_on_reason: "waiting",
      waiting_on_by: ["ISS-2"],
      comments_count: 2,
      has_retro: true,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      priority: 3,
      assigned_agent: null,
    });
  });

  // DX-164 Phase 6: assigned_agent threads through the projection so the
  // SPA can render the AgentBadge chip on issue rows + drawer header.
  it("surfaces assigned_agent on the list item when the YAML stamps it", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-9",
        type: "Feature",
        title: "Claimed by alice",
        status: "In Progress",
        assigned_agent: "alice",
      }),
      1_700_000_000_000,
    );
    const items = await listIssues(repo);
    expect(items[0].assigned_agent).toBe("alice");
  });

  it("has empty children_detail for non-epic cards with no children", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", type: "Feature" }),
      1_000,
    );
    const items = await listIssues(repo);
    expect(items[0].children_detail).toEqual([]);
  });

  it("emits empty children_detail for epics with no children", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic" }),
      1_000,
    );
    const items = await listIssues(repo);
    expect(items[0].children_detail).toEqual([]);
  });

  it("children_detail carries child's raw Done status + blocked=false and uses child.title as name", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        children: ["ISS-2"],
      }),
      2_000,
    );
    writeIssue(
      repo,
      "closed",
      emptyIssue({
        id: "ISS-2",
        title: "Phase one shipped",
        status: "Done",
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail).toEqual([
      {
        id: "ISS-2",
        name: "Phase one shipped",
        type: "Feature",
        status: "Done",
        waiting_on: false,
        waiting_on_by_card: false,
        missing: false,
      },
    ]);
  });

  it("children_detail carries Cancelled raw (no projection in backend)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-2", title: "phase 2", status: "Cancelled" }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("Cancelled");
    expect(epic.children_detail[0].waiting_on).toBe(false);
  });

  it("children_detail carries blocked=true when child has a blocked record (status untouched)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        title: "blocked phase",
        status: "ToDo",
        waiting_on: {
          reason: "waiting",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-3"],
        },
        blocked: null,
        requires_human: null,
        }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("ToDo");
    expect(epic.children_detail[0].waiting_on).toBe(true);
  });

  it("children_detail carries Blocked raw + blocked=false", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", title: "help me", status: "Blocked" }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("Blocked");
    expect(epic.children_detail[0].waiting_on).toBe(false);
  });

  it("epic with no own waiting_on is NOT waiting regardless of child state (literal)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2", "ISS-3"],
      }),
      3_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", status: "In Progress" }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-3",
        status: "ToDo",
        waiting_on: {
          reason: "wait for ISS-2",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-2"],
        },
        blocked: null,
        requires_human: null,
        }),
      1_000,
    );
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.waiting_on).toBe(false);
    expect(epic.status).toBe("In Progress");
    expect(epic.waiting_on_by).toEqual([]);
  });

  it("epic status untouched by child waiting on external work (literal)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2"],
      }),
      3_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        status: "ToDo",
        waiting_on: {
          reason: "waits cross-epic",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-99"],
        },
        blocked: null,
        requires_human: null,
        }),
      2_000,
    );
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.status).toBe("In Progress");
    expect(epic.waiting_on).toBe(false);
    expect(epic.waiting_on_by).toEqual([]);
    expect(epic.children_detail[0].waiting_on).toBe(true);
  });

  it("epic status untouched by child status === Blocked (literal)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2"],
      }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", status: "Blocked" }),
      1_000,
    );
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.status).toBe("In Progress");
    expect(epic.waiting_on).toBe(false);
    expect(epic.children_detail[0].status).toBe("Blocked");
  });

  it("epic with non-null waiting_on surfaces literally on the wire", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2"],
        waiting_on: {
          reason: "hard dep on external epic",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-99"],
        },
      }),
      2_000,
    );
    writeIssue(repo, "open", emptyIssue({ id: "ISS-2" }), 1_000);
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.status).toBe("ToDo");
    expect(epic.waiting_on).toBe(true);
    expect(epic.waiting_on_reason).toBe("hard dep on external epic");
    expect(epic.waiting_on_by).toEqual(["ISS-99"]);
  });

  it("epic NOT waiting by missing children alone (literal)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-99", "ISS-100"],
      }),
      1_000,
    );
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.waiting_on).toBe(false);
    expect(epic.status).toBe("In Progress");
  });

  it("children_detail carries Blocked raw + waiting_on=false (Blocked is the canonical non-dispatchable status)", async () => {
    // DX-231 retired the `Needs Approval` parking status; Blocked is
    // now the only non-dispatchable open-status code path. The
    // children_detail projection still surfaces the raw status.
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        title: "stuck child",
        status: "Blocked",
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("Blocked");
    expect(epic.children_detail[0].waiting_on).toBe(false);
  });

  it("children_detail carries the child's raw type (Bug/Feature/Epic flows through)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        children: ["ISS-2", "ISS-3"],
      }),
      3_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", type: "Bug", title: "bug child" }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-3", type: "Feature", title: "feat child" }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail.map((c) => c.type)).toEqual(["Bug", "Feature"]);
  });

  it("missing children get missing=true so the SPA renders them as a distinct ⛔ row", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-99"] }),
      2_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0]).toEqual({
      id: "ISS-99",
      name: "<ISS-99: unknown>",
      type: "Feature",
      status: "ToDo",
      waiting_on: true,
      waiting_on_by_card: false,
      missing: true,
    });
  });

  it("children_detail carries In Progress raw + blocked=false", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        title: "active",
        status: "In Progress",
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("In Progress");
    expect(epic.children_detail[0].waiting_on).toBe(false);
  });

  it("groups by status (priority bucket FIFO ASC, recency bucket DESC), per ISS-210", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);
    writeIssue(repo, "open", emptyIssue({ id: "ISS-2" }), 3_000);
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-3", status: "Done" }),
      2_000,
    );

    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["ISS-1", "ISS-2", "ISS-3"]);
  });

  it("caps closed issues at 50 by default (recent)", async () => {
    const repo = setupRepo();
    for (let i = 1; i <= 60; i++) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id: `ISS-${i}`, status: "Done" }),
        1_000_000 + i,
      );
    }
    const items = await listIssues(repo);
    expect(items).toHaveLength(50);
    // Newest 50 by mtime: ISS-11..ISS-60
    expect(items[0].id).toBe("ISS-60");
    expect(items[49].id).toBe("ISS-11");
  });

  it("pulls closed cards referenced by an open card's children[] beyond the 50-cap", async () => {
    const repo = setupRepo();
    for (let i = 1; i <= 60; i++) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id: `ISS-${i}`, status: "Done" }),
        1_000_000 + i,
      );
    }
    // Three OLD closed phase children (older than every above).
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-200", status: "Done" }),
      500,
    );
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-201", status: "Done" }),
      600,
    );
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-202", status: "Done" }),
      700,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-300",
        type: "Epic",
        children: ["ISS-200", "ISS-201", "ISS-202"],
      }),
      2_000_000,
    );
    const items = await listIssues(repo);
    const ids = new Set(items.map((i) => i.id));
    expect(items.length).toBe(50 + 1 + 3);
    expect(ids.has("ISS-200")).toBe(true);
    expect(ids.has("ISS-201")).toBe(true);
    expect(ids.has("ISS-202")).toBe(true);
    const epic = items.find((i) => i.id === "ISS-300")!;
    expect(epic.children_detail.every((c) => !c.missing)).toBe(true);
  });

  it("pulls closed cards referenced by parent_id beyond the 50-cap", async () => {
    const repo = setupRepo();
    for (let i = 1; i <= 60; i++) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id: `ISS-${i}`, status: "Done" }),
        1_000_000 + i,
      );
    }
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-200", type: "Epic", status: "Done" }),
      500,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-300", parent_id: "ISS-200" }),
      2_000_000,
    );
    const ids = new Set((await listIssues(repo)).map((i) => i.id));
    expect(ids.has("ISS-200")).toBe(true);
  });

  it("recent-closed parent pulls its closed children past the 50-cap (DX-99 scenario)", async () => {
    const repo = setupRepo();
    for (let i = 1; i <= 50; i++) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id: `ISS-${i}`, status: "Done" }),
        2_000_000 + i,
      );
    }
    writeIssue(
      repo,
      "closed",
      emptyIssue({
        id: "ISS-200",
        type: "Epic",
        status: "Done",
        children: ["ISS-201", "ISS-202", "ISS-203"],
      }),
      3_000_000,
    );
    for (const id of ["ISS-201", "ISS-202", "ISS-203"]) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id, parent_id: "ISS-200", status: "Done" }),
        1_000,
      );
    }
    const items = await listIssues(repo);
    const ids = new Set(items.map((i) => i.id));
    expect(ids.has("ISS-201")).toBe(true);
    expect(ids.has("ISS-202")).toBe(true);
    expect(ids.has("ISS-203")).toBe(true);
    const epic = items.find((i) => i.id === "ISS-200")!;
    expect(epic.children_detail.every((c) => !c.missing)).toBe(true);
  });

  it("returns every closed issue when include_closed=all", async () => {
    const repo = setupRepo();
    for (let i = 1; i <= 60; i++) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id: `ISS-${i}`, status: "Done" }),
        1_000_000 + i,
      );
    }
    const items = await listIssues(repo, { includeClosed: "all" });
    expect(items).toHaveLength(60);
  });

  it("isolates results by repo_name — a repo with no rows returns []", async () => {
    const repo = setupRepo();
    // Seed under a different repo name; the listIssues call below should
    // never see those rows.
    mockIssues.push({
      repoName: "other-repo",
      issue: emptyIssue({ id: "ISS-99" }),
      mirrorUpdatedAtMs: 1_000,
    });
    const items = await listIssues(repo);
    expect(items).toEqual([]);
  });

  it("skips malformed rows and surfaces the rest", async () => {
    const repo = setupRepo();
    // Reader skips-and-logs on per-row corruption (issues-reader.ts
    // toRawIssue catch) so a single transient bad row can't crash the
    // entire `/api/issues` endpoint. The malformed row is dropped;
    // healthy siblings still appear.
    mockIssues.push({
      repoName: basename(repo),
      issue: {
        id: "ISS-99",
        _malformed: true,
        raw: "garbage",
      } as unknown as Issue,
      mirrorUpdatedAtMs: 1_000,
    });
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);

    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["ISS-1"]);
  });

  it("preserves parent_id and children round-trip", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        parent_id: "ISS-1",
        children: [],
      }),
      1_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        children: ["ISS-2"],
      }),
      2_000,
    );

    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    const phase = items.find((i) => i.id === "ISS-2")!;
    expect(epic.children).toEqual(["ISS-2"]);
    expect(epic.parent_id).toBeNull();
    expect(phase.parent_id).toBe("ISS-1");
    expect(phase.children).toEqual([]);
  });

  it("has_retro is false when every retro field is empty", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);
    const items = await listIssues(repo);
    expect(items[0].has_retro).toBe(false);
  });

  it.each([
    ["good", { good: "x", bad: "", action_item_ids: [], commits: [] }],
    ["bad", { good: "", bad: "y", action_item_ids: [], commits: [] }],
    [
      "action_item_ids",
      { good: "", bad: "", action_item_ids: ["ISS-9"], commits: [] },
    ],
    ["commits", { good: "", bad: "", action_item_ids: [], commits: ["abc"] }],
  ])(
    "has_retro is true when retro.%s is non-empty",
    async (_label, retro) => {
      const repo = setupRepo();
      writeIssue(repo, "open", emptyIssue({ id: "ISS-1", retro }), 1_000);
      const items = await listIssues(repo);
      expect(items[0].has_retro).toBe(true);
    },
  );
});

describe("readIssueDetail", () => {
  it("returns the full Issue with mtime injected", async () => {
    const repo = setupRepo();
    const issue = emptyIssue({
      id: "ISS-1",
      description: "body",
      ac: [{ check_item_id: "a", title: "ac1", checked: false }],
      comments: [{ author: "x", timestamp: "t", text: "hi" }],
    });
    writeIssue(repo, "open", issue, 1_700_000_000_000);

    const detail = await readIssueDetail(repo, "ISS-1");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("ISS-1");
    expect(detail!.description).toBe("body");
    expect(detail!.ac).toHaveLength(1);
    expect(detail!.comments).toHaveLength(1);
    expect(detail!.updated_at).toBe(1_700_000_000_000);
  });

  it("returns the issue regardless of status (Done rows still found)", async () => {
    // Pre-DX-156 the helper looked at open/<id>.yml then closed/<id>.yml.
    // Under the DB mirror there is exactly one row per (repo, id) — Done
    // rows live in `issues` just like ToDo rows. The reader returns
    // whichever row exists.
    const repo = setupRepo();
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-7", status: "Done" }),
      5_000,
    );
    const detail = await readIssueDetail(repo, "ISS-7");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("ISS-7");
    expect(detail!.status).toBe("Done");
  });

  it("returns null when the id is unknown", async () => {
    const repo = setupRepo();
    const detail = await readIssueDetail(repo, "ISS-404");
    expect(detail).toBeNull();
  });

  it("includes raw_yaml field rendered from the canonical Issue state", async () => {
    const repo = setupRepo();
    const issue = emptyIssue({ id: "ISS-2", description: "hello" });
    writeIssue(repo, "open", issue, 3_000);

    const detail = await readIssueDetail(repo, "ISS-2");
    expect(detail).not.toBeNull();
    // raw_yaml is the canonical re-serialization of the current state —
    // byte-stable round-trip with serializeIssue, even if the operator
    // hand-formatted the original YAML differently.
    expect(detail!.raw_yaml).toBe(serializeIssue(issue));
    expect(detail!.raw_yaml).toContain("description: hello");
  });

  it("throws on malformed entries — fail loud", async () => {
    const repo = setupRepo();
    mockIssues.push({
      repoName: basename(repo),
      issue: {
        id: "ISS-99",
        _malformed: true,
        raw: "garbage",
      } as unknown as Issue,
      mirrorUpdatedAtMs: 1_000,
    });
    await expect(readIssueDetail(repo, "ISS-99")).rejects.toThrow(/malformed/);
  });

  it("isolates results by repo_name — different repo returns null", async () => {
    const repo = setupRepo();
    mockIssues.push({
      repoName: "other-repo",
      issue: emptyIssue({ id: "ISS-50" }),
      mirrorUpdatedAtMs: 1_000,
    });
    expect(await readIssueDetail(repo, "ISS-50")).toBeNull();
  });
});

describe("listIssues / readIssueDetail prefix-agnostic", () => {
  it("loads DX-N cards (no config.yml needed)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "DX-1", title: "first" }),
      1_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "DX-2", title: "second" }),
      2_000,
    );
    const items = await listIssues(repo);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["DX-1", "DX-2"]);
  });

  it("loads SG-N cards (no config.yml needed)", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "SG-7" }), 1_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["SG-7"]);
  });

  it("co-existing prefixes both load — no monoculture skip", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "DX-1", title: "dx" }), 2_000);
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1", title: "iss" }), 1_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id).sort()).toEqual(["DX-1", "ISS-1"]);
  });

  it("readIssueDetail loads any prefix by id", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "DX-42", description: "body" }),
      1_000,
    );
    const detail = await readIssueDetail(repo, "DX-42");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("DX-42");
    expect(detail!.description).toBe("body");
  });

  it("ordering is prefix-agnostic across mixed prefixes (per-status sort, ISS-210)", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "DX-1" }), 1_000);
    writeIssue(repo, "open", emptyIssue({ id: "DX-2" }), 3_000);
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 4_000);
    writeIssue(repo, "open", emptyIssue({ id: "DX-3" }), 2_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["DX-1", "DX-3", "DX-2", "ISS-1"]);
  });

  it("skips rogue ids in DB rows", async () => {
    // The mirror writer's PK is fed by `data->>'id'`, so a row whose
    // id doesn't match `<PREFIX>-N` is a regression in the writer.
    // The reader skips-and-logs (defense-in-depth — single bad row
    // can't crash `/api/issues`) rather than throwing.
    const repo = setupRepo();
    mockIssues.push({
      repoName: basename(repo),
      issue: { ...emptyIssue({ id: "lowercase-99" as unknown as string }) },
      mirrorUpdatedAtMs: 1_000,
    });
    const items = await listIssues(repo);
    expect(items).toEqual([]);
  });
});

describe("readIssueHistory", () => {
  it("returns ascending-ordered entries for an issue", async () => {
    const repo = setupRepo();
    seedHistory(repo, "ISS-1", [
      {
        changedAtMs: 3_000,
        source: "watcher",
        prevHash: "h2",
        nextHash: "h3",
        patch: [{ op: "replace", path: "/status", value: "Done" }],
      },
      {
        changedAtMs: 1_000,
        source: "boot-scan",
        prevHash: null,
        nextHash: "h1",
        patch: [{ op: "add", path: "/", value: { id: "ISS-1" } }],
      },
      {
        changedAtMs: 2_000,
        source: "watcher",
        prevHash: "h1",
        nextHash: "h2",
        patch: [{ op: "replace", path: "/status", value: "In Progress" }],
      },
    ]);

    const entries = await readIssueHistory(repo, "ISS-1");
    expect(entries.map((e) => e.next_hash)).toEqual(["h1", "h2", "h3"]);
    expect(entries[0].source).toBe("boot-scan");
    expect(entries[0].prev_hash).toBeNull();
    expect(entries[1].source).toBe("watcher");
  });

  it("returns [] when the issue has no recorded history", async () => {
    const repo = setupRepo();
    expect(await readIssueHistory(repo, "ISS-9999")).toEqual([]);
  });

  it("isolates by repo_name — entries from other repos are not returned", async () => {
    const repo = setupRepo();
    mockHistory.push({
      repoName: "other-repo",
      issueId: "ISS-1",
      changedAtMs: 1_000,
      source: "watcher",
      prevHash: null,
      nextHash: "h",
      patch: [],
      insertSeq: nextHistorySeq++,
    });
    expect(await readIssueHistory(repo, "ISS-1")).toEqual([]);
  });

  it("respects the limit option", async () => {
    const repo = setupRepo();
    seedHistory(
      repo,
      "ISS-1",
      Array.from({ length: 10 }, (_, i) => ({
        changedAtMs: 1_000 + i,
        source: "watcher",
        prevHash: i === 0 ? null : `h${i - 1}`,
        nextHash: `h${i}`,
        patch: [{ op: "test", path: "/seq", value: i }],
      })),
    );
    const entries = await readIssueHistory(repo, "ISS-1", { limit: 3 });
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.next_hash)).toEqual(["h0", "h1", "h2"]);
  });

  it("preserves changed_at as ISO 8601 string", async () => {
    const repo = setupRepo();
    const ts = Date.UTC(2026, 4, 9, 12, 0, 0);
    seedHistory(repo, "ISS-1", [
      {
        changedAtMs: ts,
        source: "watcher",
        prevHash: null,
        nextHash: "h1",
        patch: [],
      },
    ]);
    const [entry] = await readIssueHistory(repo, "ISS-1");
    expect(typeof entry.changed_at).toBe("string");
    expect(new Date(entry.changed_at).getTime()).toBe(ts);
  });
});

describe("listIssues — scale guard", () => {
  it("throws when the repo's row count exceeds the dashboard cap", async () => {
    // Force the simulator to return too many rows by stubbing the
    // query function — exercises the production code's `length >
    // DASHBOARD_MAX_ROWS` branch without seeding 5001 fixtures.
    setIssueDbQueryFn(async (sql) => {
      if (sql.includes("LIMIT 5001")) {
        // Return cap+1 rows shaped like real `issues` rows.
        return Array.from({ length: 5001 }, (_, i) => ({
          data: emptyIssue({ id: `ISS-${i + 1}` }),
          mirror_updated_at: new Date(1_000 + i),
        })) as never;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repo = setupRepo();
    await expect(listIssues(repo)).rejects.toThrow(
      /returned 5001 rows.*cap = 5000/,
    );
  });
});

// Sanity: every listed status routes correctly through the per-status
// sort path. Regression guard for the grouped ordering.
describe("listIssues — status grouping smoke", () => {
  it.each<IssueStatus>([
    "Review",
    "ToDo",
    "In Progress",
    "Blocked",
    "Done",
    "Cancelled",
  ])("retains rows in status %s", async (status) => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1", status }), 1_000);
    const items = await listIssues(repo, { includeClosed: "all" });
    expect(items.find((i) => i.id === "ISS-1")?.status).toBe(status);
  });
});
