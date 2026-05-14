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
    schema_version: 8,
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
    position: null,
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
    conflict_on: overrides.conflict_on ?? [],
    effort_level: overrides.effort_level ?? null,
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
const SQL_SELECT_ISSUES_BY_IDS = normalizeSql(
  `SELECT data FROM issues WHERE repo_name = $1 AND id = ANY($2::text[])`,
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

    // dbSelectIssuesByIds — readIssueDetail uses this for waiting_on.by
    // deps + (DX-267) for counting children with requires_human != null.
    if (norm === SQL_SELECT_ISSUES_BY_IDS) {
      const [repoName, ids] = p as [string, string[]];
      const idSet = new Set(ids);
      return mockIssues
        .filter((r) => r.repoName === repoName && idSet.has(r.issue.id))
        .map((r) => ({ data: r.issue })) as never;
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
          requires_human: false,
          missing: true,
        },
        {
          id: "ISS-3",
          name: "<ISS-3: unknown>",
          type: "Feature",
          status: "ToDo",
          waiting_on: true,
          waiting_on_by_card: false,
          requires_human: false,
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
      position: null,
      assigned_agent: null,
      requires_human: null,
      requires_human_child_count: 0,
      blocked: null,
      conflict_on: [],
      conflict_on_active_count: 0,
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
      child_assignments: [],
    });
  });

  // DX-239 / P8 of DX-231 — requires_human is projected on the list item
  // and the parent's children_detail row so the SPA can render the 👤
  // indicator + the per-epic aggregate count without a detail fetch.
  it("projects requires_human on the list item and as a boolean on the parent's children row", async () => {
    const repo = setupRepo();
    const reqHuman = {
      reason: "Need Stripe key rotated",
      steps: ["Log into Stripe", "Roll the secret", "Update .env"],
      set_by: "agent" as const,
      set_at: "2026-05-10T16:50:00Z",
    };
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-10",
        type: "Epic",
        title: "Parent epic",
        children: ["ISS-11", "ISS-12"],
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-11",
        type: "Feature",
        title: "Child with requires_human",
        parent_id: "ISS-10",
        requires_human: reqHuman,
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-12",
        type: "Feature",
        title: "Child without",
        parent_id: "ISS-10",
        requires_human: null,
      }),
      1_700_000_000_000,
    );

    const items = await listIssues(repo);
    const parent = items.find((i) => i.id === "ISS-10")!;
    const child = items.find((i) => i.id === "ISS-11")!;
    const sibling = items.find((i) => i.id === "ISS-12")!;

    expect(child.requires_human).toEqual(reqHuman);
    expect(sibling.requires_human).toBeNull();
    expect(parent.requires_human).toBeNull();

    expect(parent.children_detail).toEqual([
      expect.objectContaining({ id: "ISS-11", requires_human: true }),
      expect.objectContaining({ id: "ISS-12", requires_human: false }),
    ]);
  });

  // Defense-in-depth: parents themselves can have requires_human set
  // (e.g. an epic flagged for a 3rd-party action). The list-item passthrough
  // must survive intact — the panel reads it directly off the row.
  it("projects requires_human on the PARENT's own list item (not just the children)", async () => {
    const repo = setupRepo();
    const parentReq = {
      reason: "Epic-level: vendor portal access needed",
      steps: ["Grant access", "Notify ops"],
      set_by: "human" as const,
      set_at: "2026-05-10T16:50:00Z",
    };
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-20",
        type: "Epic",
        title: "Parent flagged",
        children: [],
        requires_human: parentReq,
      }),
      1_700_000_000_000,
    );
    const items = await listIssues(repo);
    expect(items[0].requires_human).toEqual(parentReq);
  });

  // DX-267 — Epic-level rollup of `requires_human` across `children[]`.
  // Emitted as `requires_human_child_count` on every list item (Epic +
  // non-Epic) so the SPA's IssueCard chip and DrawerHeader text can read
  // a precomputed number instead of scanning `children_detail` inline.
  // Missing children must not be counted (they have no real requires_human
  // record — `children_detail` already projects them as `requires_human:
  // false`, defense-in-depth: assert the count drops missing rows).
  describe("requires_human_child_count rollup (DX-267)", () => {
    const reqHuman = {
      reason: "Need vendor portal access",
      steps: ["Grant access"],
      set_by: "agent" as const,
      set_at: "2026-05-11T00:00:00Z",
    };

    it("emits 0 on cards with no children", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({ id: "ISS-1", type: "Feature", children: [] }),
        1_700_000_000_000,
      );
      const items = await listIssues(repo);
      expect(items[0].requires_human_child_count).toBe(0);
    });

    it("emits 0 when no children are flagged", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-10",
          type: "Epic",
          children: ["ISS-11", "ISS-12"],
        }),
        1_700_000_000_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-11",
          type: "Feature",
          parent_id: "ISS-10",
          requires_human: null,
        }),
        1_700_000_000_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-12",
          type: "Feature",
          parent_id: "ISS-10",
          requires_human: null,
        }),
        1_700_000_000_000,
      );
      const items = await listIssues(repo);
      const epic = items.find((i) => i.id === "ISS-10")!;
      expect(epic.requires_human_child_count).toBe(0);
    });

    it("emits N when N of M children are flagged (mixed)", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-20",
          type: "Epic",
          children: ["ISS-21", "ISS-22", "ISS-23"],
        }),
        1_700_000_000_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-21",
          parent_id: "ISS-20",
          requires_human: reqHuman,
        }),
        1_700_000_000_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-22",
          parent_id: "ISS-20",
          requires_human: null,
        }),
        1_700_000_000_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-23",
          parent_id: "ISS-20",
          requires_human: reqHuman,
        }),
        1_700_000_000_000,
      );
      const items = await listIssues(repo);
      const epic = items.find((i) => i.id === "ISS-20")!;
      expect(epic.requires_human_child_count).toBe(2);
    });

    it("emits the full child count when every child is flagged", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-30",
          type: "Epic",
          children: ["ISS-31", "ISS-32"],
        }),
        1_700_000_000_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-31",
          parent_id: "ISS-30",
          requires_human: reqHuman,
        }),
        1_700_000_000_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-32",
          parent_id: "ISS-30",
          requires_human: reqHuman,
        }),
        1_700_000_000_000,
      );
      const items = await listIssues(repo);
      const epic = items.find((i) => i.id === "ISS-30")!;
      expect(epic.requires_human_child_count).toBe(2);
    });

    it("does NOT count missing children (orphaned references) as flagged", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-40",
          type: "Epic",
          // ISS-41 / ISS-42 are referenced but never written.
          children: ["ISS-41", "ISS-42"],
        }),
        1_700_000_000_000,
      );
      const items = await listIssues(repo);
      const epic = items.find((i) => i.id === "ISS-40")!;
      expect(epic.requires_human_child_count).toBe(0);
    });

    it("emits the field on non-Epic parents too (computed, not Epic-gated)", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-50",
          // type stays default Feature — non-Epic parent with sub-cards.
          children: ["ISS-51"],
        }),
        1_700_000_000_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-51",
          parent_id: "ISS-50",
          requires_human: reqHuman,
        }),
        1_700_000_000_000,
      );
      const items = await listIssues(repo);
      const parent = items.find((i) => i.id === "ISS-50")!;
      expect(parent.type).not.toBe("Epic");
      expect(parent.requires_human_child_count).toBe(1);
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
        requires_human: false,
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
      requires_human: false,
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

// DX-516 — triage block round-trips through the list-item projection so
// the SPA's IssueCard chip can render the ICE total + most-recent triage
// timestamp without a per-row detail fetch.
describe("listIssues — triage block projection (DX-516)", () => {
  it("passes the triage block through verbatim (untriaged shape)", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);
    const items = await listIssues(repo);
    expect(items[0].triage).toEqual({
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    });
  });

  it("projects the most-recent triage history entry on triaged cards", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        triage: {
          expires_at: "2026-06-01T00:00:00Z",
          reassess_hint: "re-check post-deploy",
          last_status: "Keep",
          last_explain: "high priority",
          ice: { total: 125, i: 5, c: 5, e: 5 },
          history: [
            {
              timestamp: "2026-05-13T10:00:00Z",
              status: "Keep",
              explain: "first pass",
              expires_at: "2026-06-01T00:00:00Z",
              ice: { total: 125, i: 5, c: 5, e: 5 },
            },
          ],
        },
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const t = items[0].triage!;
    expect(t.ice.total).toBe(125);
    expect(t.history).toHaveLength(1);
    expect(t.history[0].timestamp).toBe("2026-05-13T10:00:00Z");
  });

  it("deep-copies triage so a downstream mutation cannot leak into the next reader's view", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        triage: {
          expires_at: "",
          reassess_hint: "",
          last_status: "Keep",
          last_explain: "",
          ice: { total: 60, i: 4, c: 5, e: 3 },
          history: [
            {
              timestamp: "2026-05-13T10:00:00Z",
              status: "Keep",
              explain: "x",
              expires_at: "",
              ice: { total: 60, i: 4, c: 5, e: 3 },
            },
          ],
        },
      }),
      1_000,
    );
    const first = await listIssues(repo);
    first[0].triage!.ice.total = -1;
    first[0].triage!.history[0].ice.total = -1;
    const second = await listIssues(repo);
    expect(second[0].triage!.ice.total).toBe(60);
    expect(second[0].triage!.history[0].ice.total).toBe(60);
  });
});

describe("listIssues — position projection + sort tier (DX-264)", () => {
  it("surfaces issue.position verbatim on each list item", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1", position: 4.25 }), 1);
    writeIssue(repo, "open", emptyIssue({ id: "ISS-2", position: null }), 2);

    const items = await listIssues(repo);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId["ISS-1"].position).toBe(4.25);
    expect(byId["ISS-2"].position).toBeNull();
  });

  it("position ASC wins over ICE within a ToDo column", async () => {
    const repo = setupRepo();
    // High-ICE card with null position should sit BELOW the low-ICE
    // positioned card — position tier dominates the ICE tier.
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        position: null,
        triage: {
          expires_at: "2030-01-01T00:00:00.000Z",
          reassess_hint: "",
          last_status: "Keep",
          last_explain: "",
          ice: { total: 125, i: 5, c: 5, e: 5 },
          history: [],
        },
      }),
      100,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        position: 1,
        triage: {
          expires_at: "2030-01-01T00:00:00.000Z",
          reassess_hint: "",
          last_status: "Keep",
          last_explain: "",
          ice: { total: 1, i: 1, c: 1, e: 1 },
          history: [],
        },
      }),
      200,
    );

    const items = await listIssues(repo);
    const todoOrder = items
      .filter((i) => i.status === "ToDo")
      .map((i) => i.id);
    expect(todoOrder).toEqual(["ISS-2", "ISS-1"]);
  });
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

  // DX-267 — readIssueDetail emits requires_human_child_count so the
  // drawer header on Epics can render the "<N> phase(s) need human
  // action" line without a second round-trip or a SPA-side scan.
  describe("requires_human_child_count (DX-267)", () => {
    const reqHuman = {
      reason: "Need vendor portal access",
      steps: ["Grant access"],
      set_by: "agent" as const,
      set_at: "2026-05-11T00:00:00Z",
    };

    it("emits 0 on cards with no children", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({ id: "ISS-1", children: [] }),
        1_000,
      );
      const detail = await readIssueDetail(repo, "ISS-1");
      expect(detail!.requires_human_child_count).toBe(0);
    });

    it("counts only children whose requires_human is non-null", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-10",
          type: "Epic",
          children: ["ISS-11", "ISS-12", "ISS-13"],
        }),
        1_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-11",
          parent_id: "ISS-10",
          requires_human: reqHuman,
        }),
        1_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-12",
          parent_id: "ISS-10",
          requires_human: null,
        }),
        1_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-13",
          parent_id: "ISS-10",
          requires_human: reqHuman,
        }),
        1_000,
      );
      const detail = await readIssueDetail(repo, "ISS-10");
      expect(detail!.requires_human_child_count).toBe(2);
    });

    it("treats missing children as 0 contribution (orphaned refs)", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-20",
          type: "Epic",
          // ISS-21 / ISS-22 never written.
          children: ["ISS-21", "ISS-22"],
        }),
        1_000,
      );
      const detail = await readIssueDetail(repo, "ISS-20");
      expect(detail!.requires_human_child_count).toBe(0);
    });

    // The parent epic itself may carry `requires_human != null` (e.g. an
    // epic flagged for vendor-portal access at the epic level). That self
    // flag is surfaced separately on `detail.requires_human` — it MUST
    // NOT roll up into the children count or the operator sees "1 phase
    // needs human action" on an epic whose phases are all clean.
    it("does NOT count the parent's own requires_human in the child rollup", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-30",
          type: "Epic",
          children: ["ISS-31"],
          requires_human: reqHuman, // parent itself is flagged.
        }),
        1_000,
      );
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-31",
          parent_id: "ISS-30",
          requires_human: null, // child is clean.
        }),
        1_000,
      );
      const detail = await readIssueDetail(repo, "ISS-30");
      expect(detail!.requires_human).toEqual(reqHuman);
      expect(detail!.requires_human_child_count).toBe(0);
    });

    // Done / Cancelled children with `requires_human != null` are still
    // operator-actionable — the closed status doesn't strip the flag —
    // so they MUST stay counted. Pins the contract against a future
    // status-based filter regression.
    it("counts Done / Cancelled children whose requires_human is non-null", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-40",
          type: "Epic",
          children: ["ISS-41", "ISS-42"],
        }),
        1_000,
      );
      writeIssue(
        repo,
        "closed",
        emptyIssue({
          id: "ISS-41",
          parent_id: "ISS-40",
          status: "Done",
          requires_human: reqHuman,
        }),
        1_000,
      );
      writeIssue(
        repo,
        "closed",
        emptyIssue({
          id: "ISS-42",
          parent_id: "ISS-40",
          status: "Cancelled",
          requires_human: reqHuman,
        }),
        1_000,
      );
      const detail = await readIssueDetail(repo, "ISS-40");
      expect(detail!.requires_human_child_count).toBe(2);
    });

    // The mirror stamps `_malformed: true` on rows whose YAML failed to
    // parse. `dbSelectIssuesByIds` passes those rows through untouched
    // (the consumer is responsible for skipping). Our filter uses loose
    // `!= null` so an `undefined` requires_human field on a malformed
    // row does NOT inflate the count.
    it("does NOT inflate the count when a child row is _malformed", async () => {
      const repo = setupRepo();
      writeIssue(
        repo,
        "open",
        emptyIssue({
          id: "ISS-50",
          type: "Epic",
          children: ["ISS-51"],
        }),
        1_000,
      );
      // Seed a malformed child row directly, skipping `emptyIssue`'s
      // normalization (mirror writers stamp this shape on parse errors).
      mockIssues.push({
        repoName: basename(repo),
        issue: {
          id: "ISS-51",
          _malformed: true,
          raw: "garbage bytes",
        } as unknown as Issue,
        mirrorUpdatedAtMs: 1_000,
      });
      const detail = await readIssueDetail(repo, "ISS-50");
      expect(detail!.requires_human_child_count).toBe(0);
    });
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
    // FIFO by id-numeric ASC (mtime no longer tiebreaks). At numeric tie
    // (DX-1 / ISS-1 both N=1) the localeCompare fallback breaks by prefix:
    // "DX" < "ISS" → DX-1 first, ISS-1 second.
    expect(items.map((i) => i.id)).toEqual(["DX-1", "ISS-1", "DX-2", "DX-3"]);
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

describe("conflict_on projection (DX-309)", () => {
  it("listIssues: counts forward conflict (own conflict_on points at In Progress partner)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        status: "ToDo",
        conflict_on: [{ id: "ISS-2", reason: "same file" }],
      }),
      1_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", status: "In Progress" }),
      1_000,
    );
    const items = await listIssues(repo);
    const me = items.find((i) => i.id === "ISS-1")!;
    expect(me.conflict_on).toEqual([{ id: "ISS-2", reason: "same file" }]);
    expect(me.conflict_on_active_count).toBe(1);
  });

  it("listIssues: counts reverse conflict (OTHER In Progress card names THIS card)", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1", status: "ToDo" }), 1_000);
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        status: "In Progress",
        conflict_on: [{ id: "ISS-1", reason: "partner declares" }],
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const me = items.find((i) => i.id === "ISS-1")!;
    expect(me.conflict_on).toEqual([]);
    expect(me.conflict_on_active_count).toBe(1);
  });

  it("listIssues: terminal partner = audit-only (count 0)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        status: "ToDo",
        conflict_on: [{ id: "ISS-2", reason: "historical" }],
      }),
      1_000,
    );
    writeIssue(repo, "closed", emptyIssue({ id: "ISS-2", status: "Done" }), 1_000);
    const items = await listIssues(repo);
    const me = items.find((i) => i.id === "ISS-1")!;
    expect(me.conflict_on).toEqual([{ id: "ISS-2", reason: "historical" }]);
    expect(me.conflict_on_active_count).toBe(0);
  });

  it("readIssueDetail: conflict_on_partners covers forward + reverse + waiting_on.by ids", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        status: "ToDo",
        conflict_on: [{ id: "ISS-2", reason: "fwd" }],
        waiting_on: {
          reason: "needs ISS-3",
          timestamp: "t",
          by: ["ISS-3"],
        },
      }),
      1_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", status: "In Progress", title: "fwd partner" }),
      1_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-3", status: "ToDo", title: "dep partner" }),
      1_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-4",
        status: "In Progress",
        title: "rev partner",
        conflict_on: [{ id: "ISS-1", reason: "rev declared" }],
      }),
      1_000,
    );
    const detail = await readIssueDetail(repo, "ISS-1");
    expect(detail).not.toBeNull();
    expect(detail!.conflict_on_partners).toMatchObject({
      "ISS-2": { status: "In Progress", title: "fwd partner" },
      "ISS-3": { status: "ToDo", title: "dep partner" },
      "ISS-4": { status: "In Progress", title: "rev partner" },
    });
    expect(detail!.conflict_on_reverse).toEqual([
      { id: "ISS-4", reason: "rev declared" },
    ]);
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

// DX-524 — `child_assignments` rollup on every list item. One entry per
// (agent, child) pair across the recursive child subtree, filtered to
// children whose `status` is non-terminal AND `assigned_agent !== null`.
// Empty on non-parent rows and on parents whose subtree has zero
// qualifying assignments. Walk uses the in-memory `byId` map; missing
// children (orphaned id references) are skipped.
describe("child_assignments rollup (DX-524)", () => {
  it("emits [] on cards with no children", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Feature", children: [] }),
      1_700_000_000_000,
    );
    const items = await listIssues(repo);
    expect(items[0].child_assignments).toEqual([]);
  });

  it("emits [] when every child is terminal or has no assigned_agent", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-10",
        type: "Epic",
        children: ["ISS-11", "ISS-12", "ISS-13"],
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-11",
        parent_id: "ISS-10",
        status: "Done",
        assigned_agent: "phil",
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-12",
        parent_id: "ISS-10",
        status: "Cancelled",
        assigned_agent: "phil",
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-13",
        parent_id: "ISS-10",
        status: "ToDo",
        assigned_agent: null,
      }),
      1_700_000_000_000,
    );
    const items = await listIssues(repo, { includeClosed: "all" });
    const epic = items.find((i) => i.id === "ISS-10")!;
    expect(epic.child_assignments).toEqual([]);
  });

  it("excludes Review-status children even with an assigned_agent (residue from triage, not active work)", async () => {
    // Locks the ASSIGNABLE_STATUSES whitelist contract. A regression
    // that widens the whitelist to include Review (e.g. someone reads
    // the spec as "any non-terminal status") would silently surface
    // stale triage-assigned agents on the parent rollup.
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-90",
        type: "Epic",
        children: ["ISS-91"],
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-91",
        parent_id: "ISS-90",
        title: "Review-stuck child",
        status: "Review",
        assigned_agent: "phil",
      }),
      1_700_000_000_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-90")!;
    expect(epic.child_assignments).toEqual([]);
  });

  it("emits one entry per non-terminal child with an assigned_agent, excluding Done/Cancelled/null", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-20",
        type: "Epic",
        title: "Parent epic",
        children: ["ISS-21", "ISS-22", "ISS-23", "ISS-24", "ISS-25", "ISS-26"],
      }),
      1_700_000_000_000,
    );
    // ToDo + assigned → INCLUDED
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-21",
        parent_id: "ISS-20",
        title: "Phase 1",
        status: "ToDo",
        assigned_agent: "buildy",
      }),
      1_700_000_000_000,
    );
    // In Progress + assigned → INCLUDED
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-22",
        parent_id: "ISS-20",
        title: "Phase 2",
        status: "In Progress",
        assigned_agent: "sage",
      }),
      1_700_000_000_000,
    );
    // Blocked + assigned → INCLUDED (Blocked is non-terminal)
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-23",
        parent_id: "ISS-20",
        title: "Phase 3",
        status: "Blocked",
        assigned_agent: "phil",
        blocked: { reason: "needs key", timestamp: "2026-01-01T00:00:00Z" },
      }),
      1_700_000_000_000,
    );
    // Done + assigned → EXCLUDED (stale agent on terminal card)
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-24",
        parent_id: "ISS-20",
        title: "Phase 4 done",
        status: "Done",
        assigned_agent: "alice",
      }),
      1_700_000_000_000,
    );
    // Cancelled + assigned → EXCLUDED
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-25",
        parent_id: "ISS-20",
        title: "Phase 5 cancelled",
        status: "Cancelled",
        assigned_agent: "bob",
      }),
      1_700_000_000_000,
    );
    // In Progress + null assigned_agent → EXCLUDED
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-26",
        parent_id: "ISS-20",
        title: "Phase 6 unassigned",
        status: "In Progress",
        assigned_agent: null,
      }),
      1_700_000_000_000,
    );

    const items = await listIssues(repo, { includeClosed: "all" });
    const epic = items.find((i) => i.id === "ISS-20")!;
    expect(epic.child_assignments).toEqual([
      { agent: "buildy", issue_id: "ISS-21", issue_title: "Phase 1" },
      { agent: "sage", issue_id: "ISS-22", issue_title: "Phase 2" },
      { agent: "phil", issue_id: "ISS-23", issue_title: "Phase 3" },
    ]);
  });

  it("skips missing children (orphaned id references) without inflating the rollup", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-30",
        type: "Epic",
        children: ["ISS-31", "ISS-32"],
      }),
      1_700_000_000_000,
    );
    // ISS-31 is intentionally NOT seeded (orphaned reference)
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-32",
        parent_id: "ISS-30",
        title: "Real child",
        status: "In Progress",
        assigned_agent: "phil",
      }),
      1_700_000_000_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-30")!;
    expect(epic.child_assignments).toEqual([
      { agent: "phil", issue_id: "ISS-32", issue_title: "Real child" },
    ]);
  });

  it("walks recursive grandchildren (epic → sub-epic → phase)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-40",
        type: "Epic",
        title: "Top-level epic",
        children: ["ISS-41"],
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-41",
        type: "Epic",
        parent_id: "ISS-40",
        title: "Sub-epic",
        status: "In Progress",
        // Sub-epic itself never carries assigned_agent (parents don't
        // dispatch); the grandchild does.
        assigned_agent: null,
        children: ["ISS-42"],
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-42",
        parent_id: "ISS-41",
        title: "Leaf phase",
        status: "In Progress",
        assigned_agent: "murphy",
      }),
      1_700_000_000_000,
    );

    const items = await listIssues(repo);
    const top = items.find((i) => i.id === "ISS-40")!;
    expect(top.child_assignments).toEqual([
      { agent: "murphy", issue_id: "ISS-42", issue_title: "Leaf phase" },
    ]);
    const subEpic = items.find((i) => i.id === "ISS-41")!;
    // Sub-epic also sees its own leaf.
    expect(subEpic.child_assignments).toEqual([
      { agent: "murphy", issue_id: "ISS-42", issue_title: "Leaf phase" },
    ]);
  });

  it("emits [] on non-parent rows (no children)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-50",
        type: "Feature",
        children: [],
        status: "In Progress",
        assigned_agent: "phil",
      }),
      1_700_000_000_000,
    );
    const items = await listIssues(repo);
    expect(items[0].child_assignments).toEqual([]);
  });

  it("keeps duplicate (agent, child) pairs verbatim when the same agent owns multiple children", async () => {
    // The spec calls for "one entry per (agent, child) pair" so the
    // tooltip can list every per-card assignment. Distinct-by-agent is
    // a SPA-side concern (avatar count cap); the backend ships every pair.
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-60",
        type: "Epic",
        children: ["ISS-61", "ISS-62"],
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-61",
        parent_id: "ISS-60",
        title: "Phase A",
        status: "In Progress",
        assigned_agent: "phil",
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-62",
        parent_id: "ISS-60",
        title: "Phase B",
        status: "ToDo",
        assigned_agent: "phil",
      }),
      1_700_000_000_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-60")!;
    expect(epic.child_assignments).toEqual([
      { agent: "phil", issue_id: "ISS-61", issue_title: "Phase A" },
      { agent: "phil", issue_id: "ISS-62", issue_title: "Phase B" },
    ]);
  });

  it("cycle-safe: a graph that loops back into a visited node does not re-enter it", async () => {
    // Malformed graph: ISS-71 lists ISS-70 as a child (cycle). The walk
    // tracks visited ids and skips the re-entry. Without the guard, the
    // recursion would stack-overflow.
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-70",
        type: "Epic",
        children: ["ISS-71"],
      }),
      1_700_000_000_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-71",
        parent_id: "ISS-70",
        title: "Cycling child",
        status: "In Progress",
        assigned_agent: "phil",
        children: ["ISS-70"], // cycle back to the root
      }),
      1_700_000_000_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-70")!;
    expect(epic.child_assignments).toEqual([
      { agent: "phil", issue_id: "ISS-71", issue_title: "Cycling child" },
    ]);
  });
});
