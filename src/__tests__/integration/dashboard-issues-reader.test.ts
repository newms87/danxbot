import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createTestDb, type TestDbHandle } from "../../db/test-db.js";
import { up as upIssuesMirror } from "../../db/migrations/016_issues_mirror.js";
import { canonicalize, sha256 } from "../../db/canonicalize.js";
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
import type { Issue } from "../../issue-tracker/interface.js";
import { serializeIssue } from "../../issue-tracker/yaml.js";

/**
 * Phase 5 of the Issues DB Mirror epic (DX-151 / DX-156).
 *
 * Real-Postgres integration tests for the dashboard's DB-backed reader.
 * The unit tests use an in-memory simulator (cheap, fragile to SQL
 * shape changes); these tests run the real SQL the helpers emit
 * against `createTestDb`, surfacing any divergence between the
 * simulator and PG's actual semantics.
 *
 * Skip semantics: when PG isn't reachable, `createTestDb()` returns
 * `null` and every `it.skipIf` body is skipped — same pattern as
 * `yaml-lifecycle-readers.test.ts`.
 */

const handle: TestDbHandle | null = await createTestDb();

if (handle) {
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    await upIssuesMirror(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const REPO_NAME = "dashboard-issues-reader-test-repo";
const REPO_PATH = "/tmp/dashboard-issues-reader-test-repo";

afterAll(async () => {
  resetIssueDbQueryFn();
  clearAllRepoNames();
  if (handle) await handle.close();
});

if (handle) {
  beforeAll(() => {
    setIssueDbQueryFn(async (sql, params) => {
      const result = await handle.pool.query(sql, params ?? []);
      return result.rows as never;
    });
    setRepoName(REPO_PATH, REPO_NAME);
  });

  beforeEach(async () => {
    await handle.pool.query("DELETE FROM issue_history");
    await handle.pool.query("DELETE FROM issues");
  });
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const merged: Issue = {
    schema_version: 12,
    tracker: "trello",
    id: "ISS-1",
    external_id: "ext-1",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Sample",
    description: "Body",
    priority: 3.0,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [{ check_item_id: "", title: "AC1", checked: false }],
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

async function seed(
  repoName: string,
  issue: Issue,
  mtimeMs?: number,
): Promise<void> {
  if (!handle) return;
  const data = issue as unknown as Record<string, unknown>;
  const contentHash = sha256(canonicalize(data));
  const mirrorAt = mtimeMs !== undefined ? new Date(mtimeMs) : new Date();
  await handle.pool.query(
    `INSERT INTO issues (repo_name, data, content_hash, mirror_updated_at)
     VALUES ($1, $2::jsonb, $3, $4)`,
    [repoName, JSON.stringify(data), contentHash, mirrorAt],
  );
}

async function seedHistory(
  repoName: string,
  issueId: string,
  rows: Array<{
    changedAtMs: number;
    source: string;
    prevHash: string | null;
    nextHash: string;
    patch: unknown;
  }>,
): Promise<void> {
  if (!handle) return;
  for (const r of rows) {
    await handle.pool.query(
      `INSERT INTO issue_history
         (repo_name, issue_id, changed_at, "source", patch, prev_hash, next_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        repoName,
        issueId,
        new Date(r.changedAtMs),
        r.source,
        JSON.stringify(r.patch),
        r.prevHash,
        r.nextHash,
      ],
    );
  }
}

describe("listIssues — DB-backed", () => {
  it.skipIf(!handle)("returns rows for the repo", async () => {
    await seed(REPO_NAME, makeIssue({ id: "ISS-1", title: "first" }), 1_000);
    await seed(
      REPO_NAME,
      makeIssue({ id: "ISS-2", title: "second", status: "In Progress" }),
      2_000,
    );
    const items = await listIssues(REPO_PATH);
    const ids = new Set(items.map((i) => i.id));
    expect(ids.has("ISS-1")).toBe(true);
    expect(ids.has("ISS-2")).toBe(true);
  });

  it.skipIf(!handle)("isolates by repo_name", async () => {
    await seed("other-repo", makeIssue({ id: "ISS-99" }));
    const items = await listIssues(REPO_PATH);
    expect(items).toEqual([]);
  });

  it.skipIf(!handle)(
    "returns Done rows when includeClosed=all",
    async () => {
      await seed(
        REPO_NAME,
        makeIssue({ id: "ISS-1", status: "Done" }),
        1_000,
      );
      const all = await listIssues(REPO_PATH, { includeClosed: "all" });
      expect(all.map((i) => i.id)).toEqual(["ISS-1"]);
    },
  );

  it.skipIf(!handle)(
    "preserves children_detail across open + closed rows",
    async () => {
      await seed(
        REPO_NAME,
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "In Progress",
          children: ["ISS-2"],
        }),
        2_000,
      );
      await seed(
        REPO_NAME,
        makeIssue({
          id: "ISS-2",
          status: "Done",
          title: "child phase",
        }),
        1_000,
      );
      const items = await listIssues(REPO_PATH);
      const epic = items.find((i) => i.id === "ISS-1");
      expect(epic).toBeDefined();
      expect(epic!.children_detail).toEqual([
        {
          id: "ISS-2",
          name: "child phase",
          type: "Feature",
          status: "Done",
          waiting_on: false,
          waiting_on_by_card: false,
          requires_human: false,
          missing: false,
        },
      ]);
    },
  );
});

describe("readIssueDetail — DB-backed", () => {
  it.skipIf(!handle)("returns the issue with mirror_updated_at as ms", async () => {
    const issue = makeIssue({
      id: "ISS-10",
      external_id: "ext-10",
      description: "body",
    });
    const ts = 1_725_000_000_000;
    await seed(REPO_NAME, issue, ts);

    const detail = await readIssueDetail(REPO_PATH, "ISS-10");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("ISS-10");
    expect(detail!.description).toBe("body");
    expect(detail!.updated_at).toBe(ts);
    expect(detail!.raw_yaml).toBe(serializeIssue(issue));
  });

  it.skipIf(!handle)("returns null when (repo_name, id) misses", async () => {
    expect(await readIssueDetail(REPO_PATH, "ISS-9999")).toBeNull();
  });
});

describe("readIssueHistory — DB-backed", () => {
  it.skipIf(!handle)(
    "returns ascending-ordered patches for the issue",
    async () => {
      await seedHistory(REPO_NAME, "ISS-1", [
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

      const entries = await readIssueHistory(REPO_PATH, "ISS-1");
      expect(entries.map((e) => e.next_hash)).toEqual(["h1", "h2", "h3"]);
      expect(entries[0].source).toBe("boot-scan");
      expect(entries[0].prev_hash).toBeNull();
    },
  );

  it.skipIf(!handle)("returns [] for unknown ids", async () => {
    expect(await readIssueHistory(REPO_PATH, "ISS-MISSING")).toEqual([]);
  });

  it.skipIf(!handle)("isolates by repo_name", async () => {
    await seedHistory("other-repo", "ISS-1", [
      {
        changedAtMs: 1_000,
        source: "watcher",
        prevHash: null,
        nextHash: "h1",
        patch: [],
      },
    ]);
    expect(await readIssueHistory(REPO_PATH, "ISS-1")).toEqual([]);
  });

  it.skipIf(!handle)("respects the limit parameter", async () => {
    await seedHistory(
      REPO_NAME,
      "ISS-1",
      Array.from({ length: 5 }, (_, i) => ({
        changedAtMs: 1_000 + i,
        source: "watcher",
        prevHash: i === 0 ? null : `h${i - 1}`,
        nextHash: `h${i}`,
        patch: [{ op: "test", path: "/seq", value: i }],
      })),
    );
    const entries = await readIssueHistory(REPO_PATH, "ISS-1", { limit: 2 });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.next_hash)).toEqual(["h0", "h1"]);
  });

  it.skipIf(!handle)(
    "preserves insertion order when changed_at ties (PG `id ASC` tiebreaker)",
    async () => {
      // Production SQL is `ORDER BY changed_at ASC, id ASC` — `id` is
      // the bigserial PK that advances monotonically per INSERT. If a
      // future refactor drops the `, id ASC` clause, two same-timestamp
      // rows would surface in PG's natural order (unstable across query
      // planner choices). This test seals that invariant against real
      // PG; the unit test simulator can't exercise it because it uses
      // an in-memory `insertSeq` counter instead of the SQL clause.
      const ts = 1_725_500_000_000;
      await seedHistory(REPO_NAME, "ISS-1", [
        {
          changedAtMs: ts,
          source: "watcher",
          prevHash: null,
          nextHash: "h-first",
          patch: [{ op: "add", path: "/seq", value: 0 }],
        },
        {
          changedAtMs: ts,
          source: "watcher",
          prevHash: "h-first",
          nextHash: "h-second",
          patch: [{ op: "replace", path: "/seq", value: 1 }],
        },
        {
          changedAtMs: ts,
          source: "watcher",
          prevHash: "h-second",
          nextHash: "h-third",
          patch: [{ op: "replace", path: "/seq", value: 2 }],
        },
      ]);
      const entries = await readIssueHistory(REPO_PATH, "ISS-1");
      expect(entries.map((e) => e.next_hash)).toEqual([
        "h-first",
        "h-second",
        "h-third",
      ]);
    },
  );
});

describe("listIssues — DB-backed slice + sort", () => {
  it.skipIf(!handle)(
    "caps closed issues at 50 by default ordered by mirror_updated_at DESC",
    async () => {
      // 60 unrelated closed cards with monotonically increasing
      // mirror_updated_at — newest 50 should slice through.
      for (let i = 1; i <= 60; i++) {
        await seed(
          REPO_NAME,
          makeIssue({ id: `ISS-${i}`, status: "Done" }),
          1_000_000 + i,
        );
      }
      const items = await listIssues(REPO_PATH);
      expect(items).toHaveLength(50);
      // Sorted DESC by mtime → ISS-60 newest, ISS-11 oldest in the slice
      expect(items[0].id).toBe("ISS-60");
      expect(items[49].id).toBe("ISS-11");
    },
  );

  it.skipIf(!handle)(
    "pulls closed cards referenced by an open epic's children[] beyond the 50-cap",
    async () => {
      for (let i = 1; i <= 50; i++) {
        await seed(
          REPO_NAME,
          makeIssue({ id: `ISS-${i}`, status: "Done" }),
          2_000_000 + i,
        );
      }
      // Three OLD closed phase children
      for (const id of ["ISS-200", "ISS-201", "ISS-202"]) {
        await seed(
          REPO_NAME,
          makeIssue({ id, parent_id: "ISS-300", status: "Done" }),
          500,
        );
      }
      // Open epic referencing them
      await seed(
        REPO_NAME,
        makeIssue({
          id: "ISS-300",
          type: "Epic",
          status: "In Progress",
          children: ["ISS-200", "ISS-201", "ISS-202"],
        }),
        3_000_000,
      );
      const items = await listIssues(REPO_PATH);
      const ids = new Set(items.map((i) => i.id));
      // Recent-50 floor + 1 open epic + 3 referenced extras
      expect(items.length).toBe(50 + 1 + 3);
      expect(ids.has("ISS-200")).toBe(true);
      expect(ids.has("ISS-201")).toBe(true);
      expect(ids.has("ISS-202")).toBe(true);
      const epic = items.find((i) => i.id === "ISS-300")!;
      expect(epic.children_detail.every((c) => !c.missing)).toBe(true);
    },
  );

  it.skipIf(!handle)(
    "scale guard fails loud when a repo would return more than 5000 rows",
    async () => {
      if (!handle) return; // type-guard for the closure below
      const realQuery = handle.pool.query.bind(handle.pool);
      try {
        // Simulate exactly cap+1 returns — the cheapest way to assert
        // the production helper's count check fires without seeding
        // 5001 actual rows.
        setIssueDbQueryFn(async (sql, params) => {
          if (sql.includes("LIMIT 5001")) {
            return Array.from({ length: 5001 }, (_, i) => ({
              data: { id: `ISS-${i}`, status: "ToDo" },
              mirror_updated_at: new Date(1_000 + i),
            })) as never;
          }
          const result = await realQuery(sql, params ?? []);
          return result.rows as never;
        });
        await expect(listIssues(REPO_PATH)).rejects.toThrow(
          /returned 5001 rows/,
        );
      } finally {
        // Restore the real query function for the remaining tests.
        setIssueDbQueryFn(async (sql, params) => {
          const result = await realQuery(sql, params ?? []);
          return result.rows as never;
        });
      }
    },
  );
});
