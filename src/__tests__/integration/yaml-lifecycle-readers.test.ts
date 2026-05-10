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
  findByExternalId,
  loadLocal,
} from "../../poller/yaml-lifecycle.js";
import {
  resetIssueDbQueryFn,
  setIssueDbQueryFn,
} from "../../poller/issues-db.js";
import {
  clearAllRepoNames,
  setRepoName,
} from "../../poller/repo-name.js";
import type { Issue } from "../../issue-tracker/interface.js";

/**
 * DB-backed integration tests for `loadLocal` and `findByExternalId`.
 *
 * Phase 4 of the Issues DB Mirror epic (DX-151 / DX-155) moved the two
 * helpers from a YAML directory walk to a SQL query against the
 * `issues` table. The unit-level round-trip tests (writeIssue →
 * filesystem) lived in `src/poller/yaml-lifecycle.test.ts` until DX-155;
 * they don't observe the DB and would silently break under the new
 * implementation. These integration tests close that gap by seeding
 * the `issues` table directly.
 */

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[yaml-lifecycle-readers] skipping — local Postgres not reachable",
  );
} else {
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

const REPO_NAME = "yaml-lifecycle-readers-test-repo";
const REPO_PATH = "/tmp/yaml-lifecycle-readers-test-repo";
const OTHER_REPO_NAME = "different-repo";
const OTHER_REPO_PATH = "/tmp/different-repo";

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
    setRepoName(OTHER_REPO_PATH, OTHER_REPO_NAME);
  });

  beforeEach(async () => {
    await handle.pool.query("DELETE FROM issues");
  });
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const merged: Issue = {
    schema_version: 5,
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
    assigned_agent: null,
    waiting_on: null,
    history: [],
    ...overrides,
  };
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

async function seed(repoName: string, issue: Issue): Promise<void> {
  if (!handle) return;
  const data = issue as unknown as Record<string, unknown>;
  const contentHash = sha256(canonicalize(data));
  await handle.pool.query(
    `INSERT INTO issues
       (repo_name, data, content_hash, mirror_updated_at)
     VALUES ($1, $2::jsonb, $3, now())`,
    [repoName, JSON.stringify(data), contentHash],
  );
}

describe("loadLocal — DB-backed", () => {
  it.skipIf(!handle)(
    "returns null when no row exists for (repo_name, id)",
    async () => {
      expect(await loadLocal(REPO_PATH, "ISS-9999", "ISS")).toBeNull();
    },
  );

  it.skipIf(!handle)("returns the Issue when the row exists", async () => {
    const issue = makeIssue({
      id: "ISS-10",
      external_id: "ext-10",
      dispatch: {
        id: "did-1",
        pid: 0,
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: 0,
      },
    });
    await seed(REPO_NAME, issue);

    const loaded = await loadLocal(REPO_PATH, "ISS-10", "ISS");
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe("ISS-10");
    expect(loaded?.external_id).toBe("ext-10");
    expect(loaded?.dispatch?.id).toBe("did-1");
  });

  it.skipIf(!handle)(
    "returns the Issue when the row carries Cancelled status (closed/ equivalent)",
    async () => {
      const issue = makeIssue({
        id: "ISS-12",
        external_id: "ext-12",
        status: "Cancelled",
      });
      await seed(REPO_NAME, issue);

      const loaded = await loadLocal(REPO_PATH, "ISS-12", "ISS");
      expect(loaded?.id).toBe("ISS-12");
      expect(loaded?.status).toBe("Cancelled");
    },
  );

  it.skipIf(!handle)(
    "returns the Issue regardless of status (Done rows still findable)",
    async () => {
      // Pre-DX-155 the helper looked in `open/` then `closed/`. With
      // the SQL projection, Done / Cancelled rows are still in `issues`
      // (the YAML mirror keeps them across the open→closed transition)
      // so the equivalent behavior is "any status, any directory".
      const issue = makeIssue({
        id: "ISS-11",
        external_id: "ext-11",
        status: "Done",
      });
      await seed(REPO_NAME, issue);

      const loaded = await loadLocal(REPO_PATH, "ISS-11", "ISS");
      expect(loaded?.id).toBe("ISS-11");
      expect(loaded?.status).toBe("Done");
    },
  );

  it.skipIf(!handle)("isolates results by repo_name", async () => {
    await seed(OTHER_REPO_NAME, makeIssue({ id: "ISS-50", external_id: "z" }));
    expect(await loadLocal(REPO_PATH, "ISS-50", "ISS")).toBeNull();
  });
});

describe("findByExternalId — DB-backed", () => {
  it.skipIf(!handle)(
    "returns the issue whose external_id matches",
    async () => {
      await seed(REPO_NAME, makeIssue({ id: "ISS-50", external_id: "ext-50" }));
      const found = await findByExternalId(REPO_PATH, "ext-50");
      expect(found?.id).toBe("ISS-50");
    },
  );

  it.skipIf(!handle)("returns null when no row carries the external_id", async () => {
    expect(await findByExternalId(REPO_PATH, "ghost-card")).toBeNull();
  });

  it.skipIf(!handle)("returns null when externalId is empty", async () => {
    expect(await findByExternalId(REPO_PATH, "")).toBeNull();
  });

  // Regression — ISS-99 prefix-migration dup-spawn: bulk-sync after a
  // rename pass must STILL find the canonical row by external_id
  // regardless of the id's prefix (DX-* vs ISS-*).
  it.skipIf(!handle)(
    "is prefix-agnostic — finds the row by external_id alone",
    async () => {
      await seed(
        REPO_NAME,
        makeIssue({ id: "DX-7", external_id: "ext-dx-7" }),
      );
      expect((await findByExternalId(REPO_PATH, "ext-dx-7"))?.id).toBe("DX-7");
    },
  );

  it.skipIf(!handle)(
    "co-existing prefixes both resolve by external_id",
    async () => {
      await seed(
        REPO_NAME,
        makeIssue({ id: "DX-12", external_id: "ext-a" }),
      );
      await seed(
        REPO_NAME,
        makeIssue({ id: "SG-3", external_id: "ext-b" }),
      );
      expect((await findByExternalId(REPO_PATH, "ext-a"))?.id).toBe("DX-12");
      expect((await findByExternalId(REPO_PATH, "ext-b"))?.id).toBe("SG-3");
    },
  );

  it.skipIf(!handle)("isolates results by repo_name", async () => {
    await seed(
      OTHER_REPO_NAME,
      makeIssue({ id: "ISS-1", external_id: "ext-shared" }),
    );
    expect(await findByExternalId(REPO_PATH, "ext-shared")).toBeNull();
  });
});
