/**
 * Triage-loop wiring tests (Phase 4 of ISS-90, ISS-94; DB-backed since DX-155).
 *
 * The poller's main loop is:
 *
 *   1. activeDispatches non-empty? → liveness scan + return early
 *   2. (handled by Phase 2 startup reattach — invariant: in-memory matches YAML)
 *   3. work-ready: open ToDo+blocked=null+dispatch=null,
 *      sorted by priority DESC → id numeric ASC (DX-627 canon).
 *   4. triage-due: oldest open card with status ∈ {Review, Blocked}
 *      OR waiting_on != null AND triage.expires_at empty/past;
 *      sorted never-triaged-first then expires_at ASC.
 *   5. idle → ideator (if enabled) or sleep.
 *
 * These tests pin the seven behavioral cases from ISS-94's AC list at
 * the helper-composition layer. Phase 4 of the Issues DB Mirror epic
 * (DX-151 / DX-155) replaced the YAML-walk implementation with SQL
 * queries against the `issues` table — the test seeds rows directly
 * and asserts on the helper return.
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
  listDispatchableYamls,
  listInProgressYamls,
  listTriageDueYamls,
} from "./local-issues.js";
import {
  resetIssueDbQueryFn,
  setIssueDbQueryFn,
} from "./issues-db.js";
import { clearAllRepoNames, setRepoName } from "./repo-name.js";
import type { Issue, IssueIce } from "../issue-tracker/interface.js";

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[triage-loop] skipping — local Postgres not reachable; run `make launch-infra` to enable",
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

const REPO_NAME = "triage-loop-test-repo";
const REPO_PATH = "/tmp/triage-loop-test-repo";

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
    await handle.pool.query("DELETE FROM issues");
  });
}

function ice(total: number, i = 1, c = 1, e = 1): IssueIce {
  return { total, i, c, e };
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
      ice: ice(0, 0, 0, 0),
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

  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      at: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

function extractTriageExpiresAt(issue: Issue): string | null {
  const raw = issue.triage.expires_at;
  if (!raw) return null;
  if (!Number.isFinite(Date.parse(raw))) return null;
  return raw;
}

async function seed(issue: Issue, mirrorUpdatedAtSec: number): Promise<void> {
  if (!handle) return;
  const data = issue as unknown as Record<string, unknown>;
  const contentHash = sha256(canonicalize(data));
  const triageExpires = extractTriageExpiresAt(issue);
  await handle.pool.query(
    `INSERT INTO issues
       (repo_name, data, content_hash, mirror_updated_at, triage_expires_at)
     VALUES
       ($1, $2::jsonb, $3, to_timestamp($4), $5)`,
    [REPO_NAME, JSON.stringify(data), contentHash, mirrorUpdatedAtSec, triageExpires],
  );
}

const NOW = Date.parse("2026-05-07T12:00:00Z");

describe("triage-loop wiring (Phase 4 of ISS-90)", () => {
  it.skipIf(!handle)(
    "Case 1 — tick with 1 work-ready ToDo card → work-ready path picks it (triage-due path empty)",
    async () => {
      await seed(
        makeIssue({ id: "ISS-1", external_id: "a", status: "ToDo" }),
        1000,
      );
      expect(
        (await listDispatchableYamls(REPO_PATH, "ISS")).map((i) => i.id),
      ).toEqual(["ISS-1"]);
      expect(await listTriageDueYamls(REPO_PATH, NOW, "ISS")).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "Case 2 — tick with 0 work-ready, 1 triage-due Review → triage path picks the Review card",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          status: "Review",
          triage: {
            expires_at: "",
            reassess_hint: "",
            last_status: "",
            last_explain: "",
            ice: ice(0, 0, 0, 0),
            history: [],
          },
        }),
        1000,
      );
      expect(await listDispatchableYamls(REPO_PATH, "ISS")).toEqual([]);
      expect(
        (await listTriageDueYamls(REPO_PATH, NOW, "ISS")).map((i) => i.id),
      ).toEqual(["ISS-1"]);
    },
  );

  it.skipIf(!handle)(
    "Case 3 — 5 ToDo all default priority (DX-627 canon) → id-numeric ASC FIFO",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-101",
          external_id: "t1",
          status: "ToDo",
          triage: {
            expires_at: "2026-09-01T00:00:00Z",
            reassess_hint: "",
            last_status: "Keep",
            last_explain: "",
            ice: ice(60, 5, 4, 3),
            history: [],
          },
        }),
        1000,
      );
      await seed(
        makeIssue({
          id: "ISS-102",
          external_id: "t2",
          status: "ToDo",
          triage: {
            expires_at: "2026-09-01T00:00:00Z",
            reassess_hint: "",
            last_status: "Keep",
            last_explain: "",
            ice: ice(40, 4, 5, 2),
            history: [],
          },
        }),
        2000,
      );
      await seed(
        makeIssue({ id: "ISS-203", external_id: "u3", status: "ToDo" }),
        5000,
      );
      await seed(
        makeIssue({ id: "ISS-201", external_id: "u1", status: "ToDo" }),
        3000,
      );
      await seed(
        makeIssue({ id: "ISS-202", external_id: "u2", status: "ToDo" }),
        4000,
      );
      const result = await listDispatchableYamls(REPO_PATH, "ISS");
      // All five cards share the default priority 3.0; the canon
      // tiebreak is id numeric ASC (DX-627). ICE total + untriaged
      // status no longer affect the comparator.
      expect(result.map((i) => i.id)).toEqual([
        "ISS-101",
        "ISS-102",
        "ISS-201",
        "ISS-202",
        "ISS-203",
      ]);
    },
  );

  it.skipIf(!handle)(
    "Case 4 — 5 ToDo all default priority (DX-627 canon) → id-numeric ASC FIFO",
    async () => {
      function triagedToDo(id: string, total: number): Issue {
        return makeIssue({
          id,
          external_id: `${id}-ext`,
          status: "ToDo",
          triage: {
            expires_at: "2026-09-01T00:00:00Z",
            reassess_hint: "",
            last_status: "Keep",
            last_explain: "",
            ice: ice(total, 5, 4, 4),
            history: [],
          },
        });
      }
      await seed(triagedToDo("ISS-401", 80), 1000);
      await seed(triagedToDo("ISS-402", 60), 2000);
      await seed(triagedToDo("ISS-403", 40), 3000);
      await seed(triagedToDo("ISS-404", 20), 4000);
      await seed(triagedToDo("ISS-405", 10), 5000);
      const result = await listDispatchableYamls(REPO_PATH, "ISS");
      expect(result.map((i) => i.id)).toEqual([
        "ISS-401",
        "ISS-402",
        "ISS-403",
        "ISS-404",
        "ISS-405",
      ]);
    },
  );

  it.skipIf(!handle)(
    "Case 5 — active dispatch on the YAML hides the card from BOTH the work-ready set AND the triage-due set",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          status: "ToDo",
          dispatch: {
            id: "uuid-1",
            pid: 1,
            host: "h",
            kind: "work",
            started_at: "2026-05-07T11:50:00Z",
            ttl_seconds: 7200,
          },
        }),
        1000,
      );
      await seed(
        makeIssue({
          id: "ISS-2",
          external_id: "b",
          status: "Review",
          dispatch: {
            id: "uuid-2",
            pid: 2,
            host: "h",
            kind: "triage",
            started_at: "2026-05-07T11:55:00Z",
            ttl_seconds: 600,
          },
        }),
        2000,
      );
      expect(await listDispatchableYamls(REPO_PATH, "ISS")).toEqual([]);
      expect(await listTriageDueYamls(REPO_PATH, NOW, "ISS")).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "Case 6 — In Progress orphan with stamped dispatch is reattached; the helpers do not surface it as work-ready",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          status: "In Progress",
          dispatch: {
            id: "uuid-1",
            pid: 1,
            host: "h",
            kind: "work",
            started_at: "2026-05-07T11:50:00Z",
            ttl_seconds: 7200,
          },
        }),
        1000,
      );
      expect(await listDispatchableYamls(REPO_PATH, "ISS")).toEqual([]);
      expect(
        (await listInProgressYamls(REPO_PATH, "ISS")).map((i) => i.id),
      ).toEqual(["ISS-1"]);
      expect(await listTriageDueYamls(REPO_PATH, NOW, "ISS")).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "Case 7 — idle-loop guard: a triage agent that previously crashed leaves a short TTL on the card",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          status: "Review",
          triage: {
            expires_at: new Date(NOW + 5 * 60 * 1000).toISOString(),
            reassess_hint: "Triage agent crashed — retry after 5min cooldown",
            last_status: "",
            last_explain: "",
            ice: ice(0, 0, 0, 0),
            history: [],
          },
        }),
        1000,
      );
      expect(await listTriageDueYamls(REPO_PATH, NOW, "ISS")).toEqual([]);
      // Once 5 minutes pass, the same row appears in the triage-due set.
      expect(
        (
          await listTriageDueYamls(REPO_PATH, NOW + 6 * 60 * 1000, "ISS")
        ).map((i) => i.id),
      ).toEqual(["ISS-1"]);
    },
  );

  it.skipIf(!handle)(
    "Tier ordering invariant — triage-due picks the FIFO-oldest among never-triaged",
    async () => {
      await seed(
        makeIssue({ id: "ISS-501", external_id: "a", status: "Review" }),
        1000,
      );
      await seed(
        makeIssue({ id: "ISS-502", external_id: "b", status: "Review" }),
        2000,
      );
      await seed(
        makeIssue({ id: "ISS-503", external_id: "c", status: "Review" }),
        3000,
      );
      const due = await listTriageDueYamls(REPO_PATH, NOW, "ISS");
      expect(due.length).toBe(3);
      expect(due[0].id).toBe("ISS-501");
    },
  );

  it.skipIf(!handle)(
    "Waiting card (waiting_on != null, status ToDo, dep missing/non-terminal) is in triage-due but NOT work-ready",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          status: "ToDo",
          waiting_on: {
            reason: "Waits for ISS-99",
            timestamp: "2026-04-01T00:00:00Z",
            by: ["ISS-99"],
          },
        }),
        1000,
      );
      expect(await listDispatchableYamls(REPO_PATH, "ISS")).toEqual([]);
      expect(
        (await listTriageDueYamls(REPO_PATH, NOW, "ISS")).map((i) => i.id),
      ).toEqual(["ISS-1"]);
    },
  );
});
