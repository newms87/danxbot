/**
 * Integration tests for `dbListDependentsByWaitingOnId` (DX-217 Phase 2
 * of the Event-Driven Worker epic). Exercises the JSONB containment
 * (`data @> $2::jsonb`) query directly against a real Postgres test
 * DB, since reconcile step 10's correctness hinges on the operator
 * picking the right dependents and skipping the wrong ones.
 *
 * Skipped when local PG is unreachable (matches the pattern in
 * `epic-status.test.ts`).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createTestDb, type TestDbHandle } from "../db/test-db.js";
import { up as upIssuesMirror } from "../db/migrations/016_issues_mirror.js";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import {
  dbListDependentsByWaitingOnId,
  dbSelectIssueById,
  resetIssueDbQueryFn,
  setIssueDbQueryFn,
} from "./issues-db.js";
import type { Issue, IssueStatus, WaitingOn } from "../issue-tracker/interface.js";

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

  beforeAll(() => {
    setIssueDbQueryFn(async (sql, params) => {
      const result = await handle.pool.query(sql, params ?? []);
      return result.rows as never;
    });
  });
}

afterAll(async () => {
  resetIssueDbQueryFn();
  if (handle) await handle.close();
});

const REPO = "issues-db-test-repo";

function makeIssue(
  id: string,
  status: IssueStatus = "ToDo",
  waiting_on: WaitingOn | null = null,
): Issue {
  return {
    schema_version: 11,
    tracker: "memory",
    id,
    external_id: `ext-${id}`,
    parent_id: null,
    children: [],
    dispatch: null,
    status,
    type: "Feature",
    title: `Title ${id}`,
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
    waiting_on,
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

}

async function seed(issue: Issue): Promise<void> {
  if (!handle) return;
  const data = issue as unknown as Record<string, unknown>;
  const contentHash = sha256(canonicalize(data));
  await handle.pool.query(
    `INSERT INTO issues
       (repo_name, data, content_hash, mirror_updated_at)
     VALUES ($1, $2::jsonb, $3, now())`,
    [REPO, JSON.stringify(data), contentHash],
  );
}

describe("dbListDependentsByWaitingOnId (DX-217)", () => {
  beforeEach(async () => {
    if (handle) await handle.pool.query("DELETE FROM issues");
  });

  it.skipIf(!handle)(
    "returns issues whose waiting_on.by[] contains the supplied id",
    async () => {
      await seed(makeIssue("DX-1", "Done"));
      await seed(
        makeIssue("DX-2", "ToDo", {
          reason: "waits on DX-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          by: ["DX-1"],
        }),
      );

      const rows = await dbListDependentsByWaitingOnId(REPO, "DX-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("DX-2");
    },
  );

  it.skipIf(!handle)(
    "matches when the id is one of multiple in by[] (containment)",
    async () => {
      await seed(makeIssue("DX-1"));
      await seed(makeIssue("DX-2"));
      await seed(
        makeIssue("DX-3", "ToDo", {
          reason: "waits on DX-1 and DX-2",
          timestamp: "2026-01-01T00:00:00.000Z",
          by: ["DX-1", "DX-2"],
        }),
      );

      const rows = await dbListDependentsByWaitingOnId(REPO, "DX-1");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("DX-3");
      const rowsForTwo = await dbListDependentsByWaitingOnId(REPO, "DX-2");
      expect(rowsForTwo).toHaveLength(1);
      expect(rowsForTwo[0].id).toBe("DX-3");
    },
  );

  it.skipIf(!handle)(
    "returns multiple dependents when several cards wait on the same id",
    async () => {
      await seed(makeIssue("DX-1"));
      await seed(
        makeIssue("DX-10", "ToDo", {
          reason: "",
          timestamp: "",
          by: ["DX-1"],
        }),
      );
      await seed(
        makeIssue("DX-11", "ToDo", {
          reason: "",
          timestamp: "",
          by: ["DX-1"],
        }),
      );

      const rows = await dbListDependentsByWaitingOnId(REPO, "DX-1");
      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual(["DX-10", "DX-11"]);
    },
  );

  it.skipIf(!handle)(
    "does NOT match cards with null waiting_on",
    async () => {
      await seed(makeIssue("DX-1"));
      await seed(makeIssue("DX-2", "ToDo", null));

      const rows = await dbListDependentsByWaitingOnId(REPO, "DX-1");
      expect(rows).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "does NOT match cards whose by[] contains a different id",
    async () => {
      await seed(makeIssue("DX-1"));
      await seed(
        makeIssue("DX-2", "ToDo", {
          reason: "",
          timestamp: "",
          by: ["DX-99"],
        }),
      );

      const rows = await dbListDependentsByWaitingOnId(REPO, "DX-1");
      expect(rows).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "respects repo isolation (other repo's rows excluded)",
    async () => {
      await seed(
        makeIssue("DX-2", "ToDo", {
          reason: "",
          timestamp: "",
          by: ["DX-1"],
        }),
      );
      // Seed a row in a DIFFERENT repo with the same shape.
      if (handle) {
        const otherIssue = makeIssue("DX-2", "ToDo", {
          reason: "",
          timestamp: "",
          by: ["DX-1"],
        });
        const data = otherIssue as unknown as Record<string, unknown>;
        const contentHash = sha256(canonicalize(data));
        await handle.pool.query(
          `INSERT INTO issues (repo_name, data, content_hash, mirror_updated_at) VALUES ($1, $2::jsonb, $3, now())`,
          ["other-repo", JSON.stringify(data), contentHash],
        );
      }

      const rows = await dbListDependentsByWaitingOnId(REPO, "DX-1");
      expect(rows).toHaveLength(1);
      // Sanity: only the REPO row, not the other-repo one.
      expect(rows[0].id).toBe("DX-2");
    },
  );
});

describe("normalizeLoadedIssue — v3 row defaults", () => {
  beforeEach(async () => {
    if (handle) await handle.pool.query("DELETE FROM issues");
  });

  it.skipIf(!handle)(
    "fills history/waiting_on/priority/etc. on a v3-shaped row loaded from DB",
    async () => {
      // Minimal v3 shape — no history, no waiting_on, no priority, no
      // position, no requires_human, no assigned_agent. Same shape
      // gpt-manager's SG-105 ships on disk.
      const v3 = {
        schema_version: 11,
        tracker: "trello",
        id: "DX-V3",
        external_id: "ext-v3",
        parent_id: null,
        children: [],
        dispatch: null,
        status: "Review",
        type: "Bug",
        title: "v3",
        description: "",
        triage: {
          expires_at: "",
          reassess_hint: "",
          last_status: "",
          last_explain: "",
          ice: { total: 0, i: 0, c: 0, e: 0 },
        },
        ac: [],
        comments: [],
        retro: { good: "", bad: "" },
        blocked: null,
      };
      const contentHash = sha256(canonicalize(v3));
      await handle!.pool.query(
        `INSERT INTO issues (repo_name, data, content_hash, mirror_updated_at)
         VALUES ($1, $2::jsonb, $3, now())`,
        [REPO, JSON.stringify(v3), contentHash],
      );

      const loaded = await dbSelectIssueById(REPO, "DX-V3");
      expect(loaded).not.toBeNull();
      // Schema-default fields normalize:
      expect(loaded!.history).toEqual([]);
      expect(loaded!.waiting_on).toBeNull();
      expect(loaded!.requires_human).toBeNull();
      expect(loaded!.assigned_agent).toBeNull();
      expect(loaded!.priority).toBe(3);
      expect(loaded!.retro.action_item_ids).toEqual([]);
      expect(loaded!.retro.commits).toEqual([]);
      expect(loaded!.triage.history).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "fills waiting_on.by[] when waiting_on is present but missing by[]",
    async () => {
      // Hypothetical hand-edited / legacy waiting_on with no by[] — would
      // crash listDispatchableYamls (`w.by` undefined → `.map` throws).
      const broken = {
        ...({
          schema_version: 11,
          tracker: "memory",
          id: "DX-W",
          external_id: "",
          parent_id: null,
          children: [],
          dispatch: null,
          status: "ToDo",
          type: "Feature",
          title: "w",
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
          history: [],
          db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
        })
,
        // Non-null waiting_on, missing by[]
        waiting_on: { reason: "x", timestamp: "" },
      };
      const contentHash = sha256(canonicalize(broken));
      await handle!.pool.query(
        `INSERT INTO issues (repo_name, data, content_hash, mirror_updated_at)
         VALUES ($1, $2::jsonb, $3, now())`,
        [REPO, JSON.stringify(broken), contentHash],
      );

      const loaded = await dbSelectIssueById(REPO, "DX-W");
      expect(loaded!.waiting_on).not.toBeNull();
      expect(loaded!.waiting_on!.by).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "defaults conflict_on to [] on a pre-v7 row missing the field",
    async () => {
      // Pre-v7 row — JSONB has no `conflict_on` key. effectiveConflictOn
      // iterates `issue.conflict_on` directly; if the loader doesn't
      // default the field, the poller crashes with
      // "TypeError: issue.conflict_on is not iterable" on every tick
      // that calls listDispatchableYamls.
      const v6 = {
        schema_version: 11,
        tracker: "memory",
        id: "DX-V6",
        external_id: "",
        parent_id: null,
        children: [],
        dispatch: null,
        status: "ToDo",
        type: "Feature",
        title: "v6",
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
        waiting_on: null,
        requires_human: null,
        assigned_agent: null,
        history: [],
        // conflict_on intentionally absent — pre-v7 shape
      };
      const contentHash = sha256(canonicalize(v6));
      await handle!.pool.query(
        `INSERT INTO issues (repo_name, data, content_hash, mirror_updated_at)
         VALUES ($1, $2::jsonb, $3, now())`,
        [REPO, JSON.stringify(v6), contentHash],
      );

      const loaded = await dbSelectIssueById(REPO, "DX-V6");
      expect(loaded).not.toBeNull();
      expect(loaded!.conflict_on).toEqual([]);
      // Bug-class assertion: must be iterable. Crash mode was
      // "for (const entry of issue.conflict_on)" against undefined.
      expect(() => {
        for (const _ of loaded!.conflict_on) {
          void _;
        }
      }).not.toThrow();
    },
  );

  it.skipIf(!handle)(
    "passes through _malformed rows untouched",
    async () => {
      const malformed = { id: "DX-M", _malformed: true, raw: "garbage" };
      const contentHash = sha256(canonicalize(malformed));
      await handle!.pool.query(
        `INSERT INTO issues (repo_name, data, content_hash, mirror_updated_at)
         VALUES ($1, $2::jsonb, $3, now())`,
        [REPO, JSON.stringify(malformed), contentHash],
      );
      const loaded = await dbSelectIssueById(REPO, "DX-M");
      expect(loaded).not.toBeNull();
      expect((loaded as unknown as Record<string, unknown>)._malformed).toBe(true);
      // Crucially: did NOT acquire children/history arrays — caller skips it.
      expect((loaded as unknown as Record<string, unknown>).history).toBeUndefined();
    },
  );
});
