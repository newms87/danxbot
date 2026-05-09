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
  listBlockedTodoYamls,
  listDispatchableYamls,
  listInProgressYamls,
  listTriageDueYamls,
} from "./local-issues.js";
import {
  resetIssueDbQueryFn,
  setIssueDbQueryFn,
} from "./issues-db.js";
import { clearAllRepoNames, setRepoName } from "./repo-name.js";
import type { Issue, IssueStatus, WaitingOn } from "../issue-tracker/interface.js";

/**
 * Phase 4 of the Issues DB Mirror epic (DX-151 / DX-155). Integration
 * tests against a real `danxbot-postgres` instance. Replaces the
 * pre-DX-155 YAML-tmpdir test setup — every helper now queries the
 * `issues` table, so the test seeds rows directly via INSERT and
 * asserts on the helper return.
 *
 * Top-level `await createTestDb()` matches the pattern in
 * `src/__tests__/integration/issues-mirror.test.ts`: vitest evaluates
 * `skipIf` eagerly at describe-collection time so a `beforeAll`-built
 * handle would leave every test marked-skipped before setup runs.
 *
 * `setIssueDbQueryFn` swaps the helper's pool getter to one bound to
 * the test DB. Every test runs against the same isolated database, so
 * `beforeEach` truncates `issues` to keep tests independent.
 */

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[local-issues] skipping — local Postgres not reachable; run `make launch-infra` to enable",
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

const REPO_NAME = "local-issues-test-repo";
const REPO_PATH = "/tmp/local-issues-test-repo";

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
    waiting_on: null,
    history: [],
    ...overrides,
  };
  // Auto-populate the self-block record when caller sets status="Blocked"
  // without an explicit `blocked` override. Keeps the v4 invariant
  // `status === "Blocked" ⟺ blocked !== null` without forcing every
  // call site to repeat the {reason, timestamp} shape.
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
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

/**
 * Seed one row directly into the `issues` table. `mirrorUpdatedAtSec`
 * is the FIFO ordering signal that file mtime previously provided — we
 * stamp it into `mirror_updated_at` so tests can pin ordering.
 */
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

describe("local-issues — DB-backed", () => {
  describe("listDispatchableYamls", () => {
    it.skipIf(!handle)("returns ToDo + blocked=null issues", async () => {
      await seed(makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      const result = await listDispatchableYamls(REPO_PATH, "ISS");
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it.skipIf(!handle)("excludes status !== ToDo", async () => {
      await seed(
        makeIssue({ id: "ISS-1", external_id: "a", status: "In Progress" }),
        1000,
      );
      await seed(
        makeIssue({ id: "ISS-2", external_id: "b", status: "Blocked" }),
        1000,
      );
      await seed(
        makeIssue({ id: "ISS-3", external_id: "c", status: "ToDo" }),
        1000,
      );
      const result = await listDispatchableYamls(REPO_PATH, "ISS");
      expect(result.map((i) => i.id)).toEqual(["ISS-3"]);
    });

    it.skipIf(!handle)("excludes waiting_on cards", async () => {
      const waiting_on: WaitingOn = {
        reason: "Waits for ISS-2",
        timestamp: "2026-01-01T00:00:00Z",
        by: ["ISS-2"],
      };
      await seed(
        makeIssue({ id: "ISS-1", external_id: "a", waiting_on }),
        1000,
      );
      await seed(makeIssue({ id: "ISS-2", external_id: "b" }), 1000);
      const result = await listDispatchableYamls(REPO_PATH, "ISS");
      expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
    });

    it.skipIf(!handle)(
      "excludes cards that already carry a non-null dispatch (occupied)",
      async () => {
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            dispatch: {
              id: "uuid-1",
              pid: 1,
              host: "h",
              kind: "work",
              started_at: "2026-01-01T00:00:00Z",
              ttl_seconds: 7200,
            },
          }),
          1000,
        );
        await seed(makeIssue({ id: "ISS-2", external_id: "b" }), 1000);
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
      },
    );

    it.skipIf(!handle)(
      "excludes Epic-typed cards (phase children dispatched directly)",
      async () => {
        await seed(
          makeIssue({ id: "ISS-1", external_id: "a", type: "Epic" }),
          1000,
        );
        await seed(
          makeIssue({ id: "ISS-2", external_id: "b", type: "Feature" }),
          1000,
        );
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
      },
    );

    it.skipIf(!handle)(
      "sorts untriaged cards before triaged cards regardless of mirror_updated_at",
      async () => {
        // Triaged with high ICE (older mirror_updated_at = 1000) — would win FIFO
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            triage: {
              expires_at: "2026-09-01T00:00:00Z",
              reassess_hint: "",
              last_status: "Keep",
              last_explain: "",
              ice: { total: 100, i: 5, c: 5, e: 4 },
              history: [],
            },
          }),
          1000,
        );
        // Untriaged (mirror_updated_at = 5000) — should still win.
        await seed(makeIssue({ id: "ISS-2", external_id: "b" }), 5000);
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-1"]);
      },
    );

    it.skipIf(!handle)(
      "among triaged cards, sorts by triage.ice.total DESC",
      async () => {
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            triage: {
              expires_at: "2026-09-01T00:00:00Z",
              reassess_hint: "",
              last_status: "Keep",
              last_explain: "",
              ice: { total: 20, i: 5, c: 2, e: 2 },
              history: [],
            },
          }),
          1000,
        );
        await seed(
          makeIssue({
            id: "ISS-2",
            external_id: "b",
            triage: {
              expires_at: "2026-09-01T00:00:00Z",
              reassess_hint: "",
              last_status: "Keep",
              last_explain: "",
              ice: { total: 100, i: 5, c: 5, e: 4 },
              history: [],
            },
          }),
          2000,
        );
        await seed(
          makeIssue({
            id: "ISS-3",
            external_id: "c",
            triage: {
              expires_at: "2026-09-01T00:00:00Z",
              reassess_hint: "",
              last_status: "Keep",
              last_explain: "",
              ice: { total: 60, i: 4, c: 3, e: 5 },
              history: [],
            },
          }),
          3000,
        );
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-3", "ISS-1"]);
      },
    );

    it.skipIf(!handle)(
      "falls back to FIFO mirror_updated_at within the same priority tier (untriaged)",
      async () => {
        await seed(makeIssue({ id: "ISS-3", external_id: "c" }), 3000);
        await seed(makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
        await seed(makeIssue({ id: "ISS-2", external_id: "b" }), 2000);
        await seed(makeIssue({ id: "ISS-10", external_id: "d" }), 1000);
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual([
          "ISS-1",
          "ISS-10",
          "ISS-2",
          "ISS-3",
        ]);
      },
    );

    it.skipIf(!handle)("returns [] when no rows exist for the repo", async () => {
      expect(await listDispatchableYamls(REPO_PATH, "ISS")).toEqual([]);
    });

    it.skipIf(!handle)(
      "ignores Done/Cancelled rows even when otherwise dispatchable",
      async () => {
        await seed(
          makeIssue({ id: "ISS-9", external_id: "z", status: "Done" }),
          1000,
        );
        await seed(makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
      },
    );

    // Ancestor-block contract: a card whose own waiting_on/blocked are
    // null is still NOT dispatchable when any ancestor up the parent_id
    // chain has a non-null waiting_on or blocked record. The blocking
    // signal lives on the ancestor — descendants do NOT mirror it.
    it.skipIf(!handle)(
      "excludes child whose parent has waiting_on != null",
      async () => {
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            type: "Epic",
            status: "ToDo",
            waiting_on: {
              reason: "waits external",
              timestamp: "2026-01-01T00:00:00Z",
              by: ["ISS-99"],
            },
          }),
          1000,
        );
        await seed(
          makeIssue({ id: "ISS-2", external_id: "b", parent_id: "ISS-1" }),
          2000,
        );
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual([]);
      },
    );

    it.skipIf(!handle)(
      "excludes child whose parent has blocked != null",
      async () => {
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            type: "Epic",
            status: "Blocked",
          }),
          1000,
        );
        await seed(
          makeIssue({ id: "ISS-2", external_id: "b", parent_id: "ISS-1" }),
          2000,
        );
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual([]);
      },
    );

    it.skipIf(!handle)(
      "excludes grandchild whose grandparent has waiting_on != null",
      async () => {
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            type: "Epic",
            status: "ToDo",
            waiting_on: {
              reason: "waits external",
              timestamp: "2026-01-01T00:00:00Z",
              by: ["ISS-99"],
            },
          }),
          1000,
        );
        await seed(
          makeIssue({
            id: "ISS-2",
            external_id: "b",
            type: "Epic",
            parent_id: "ISS-1",
          }),
          2000,
        );
        await seed(
          makeIssue({ id: "ISS-3", external_id: "c", parent_id: "ISS-2" }),
          3000,
        );
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual([]);
      },
    );

    it.skipIf(!handle)("includes child when ancestor chain is clean", async () => {
      await seed(
        makeIssue({ id: "ISS-1", external_id: "a", type: "Epic" }),
        1000,
      );
      await seed(
        makeIssue({ id: "ISS-2", external_id: "b", parent_id: "ISS-1" }),
        2000,
      );
      const result = await listDispatchableYamls(REPO_PATH, "ISS");
      expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
    });

    it.skipIf(!handle)(
      "treats Done/Cancelled ancestors as non-blocking (excluded from byId)",
      async () => {
        // A Done parent doesn't appear in the helper's byId map (status
        // filter excludes Done/Cancelled), so the child dispatches.
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            type: "Epic",
            status: "Done",
          }),
          1000,
        );
        await seed(
          makeIssue({ id: "ISS-2", external_id: "b", parent_id: "ISS-1" }),
          2000,
        );
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
      },
    );

    it.skipIf(!handle)(
      "safe under cyclic parent_id (does not infinite-loop)",
      async () => {
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            type: "Epic",
            parent_id: "ISS-2",
          }),
          1000,
        );
        await seed(
          makeIssue({
            id: "ISS-2",
            external_id: "b",
            type: "Epic",
            parent_id: "ISS-1",
          }),
          2000,
        );
        await seed(
          makeIssue({ id: "ISS-3", external_id: "c", parent_id: "ISS-1" }),
          3000,
        );
        const result = await listDispatchableYamls(REPO_PATH, "ISS");
        // ISS-3 dispatches because the cycle has no waiting_on/blocked
        // anywhere; the walk terminates via the seen-set guard.
        expect(result.map((i) => i.id)).toEqual(["ISS-3"]);
      },
    );

    it.skipIf(!handle)("isolates by repo_name", async () => {
      // Seed a row under a different repo_name; it must NOT appear.
      const otherIssue = makeIssue({ id: "ISS-9", external_id: "z" });
      const data = otherIssue as unknown as Record<string, unknown>;
      await handle!.pool.query(
        `INSERT INTO issues
           (repo_name, data, content_hash, mirror_updated_at)
         VALUES ($1, $2::jsonb, $3, now())`,
        ["different-repo", JSON.stringify(data), sha256(canonicalize(data))],
      );
      await seed(makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      const result = await listDispatchableYamls(REPO_PATH, "ISS");
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });
  });

  describe("listBlockedTodoYamls", () => {
    const waiting_on: WaitingOn = {
      reason: "Waits for ISS-2",
      timestamp: "2026-01-01T00:00:00Z",
      by: ["ISS-2"],
    };

    it.skipIf(!handle)(
      "returns ToDo issues with non-null waiting_on, sorted FIFO",
      async () => {
        await seed(
          makeIssue({ id: "ISS-1", external_id: "a", waiting_on }),
          2000,
        );
        await seed(
          makeIssue({ id: "ISS-2", external_id: "b", waiting_on }),
          1000,
        );
        const result = await listBlockedTodoYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-1"]);
      },
    );

    it.skipIf(!handle)(
      "excludes ToDo issues whose waiting_on is null",
      async () => {
        await seed(makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
        expect(await listBlockedTodoYamls(REPO_PATH, "ISS")).toEqual([]);
      },
    );

    it.skipIf(!handle)(
      "excludes In Progress issues even with non-null waiting_on",
      async () => {
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            status: "In Progress",
            waiting_on,
          }),
          1000,
        );
        expect(await listBlockedTodoYamls(REPO_PATH, "ISS")).toEqual([]);
      },
    );
  });

  describe("listInProgressYamls", () => {
    it.skipIf(!handle)(
      "excludes Done/Cancelled rows (status filter applies at the DB layer)",
      async () => {
        await seed(
          makeIssue({ id: "ISS-1", external_id: "a", status: "In Progress" }),
          1000,
        );
        await seed(
          makeIssue({ id: "ISS-9", external_id: "z", status: "Done" }),
          1500,
        );
        await seed(
          makeIssue({ id: "ISS-8", external_id: "y", status: "Cancelled" }),
          2000,
        );
        const result = await listInProgressYamls(REPO_PATH, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
      },
    );

    it.skipIf(!handle)("returns only In Progress issues", async () => {
      await seed(
        makeIssue({ id: "ISS-1", external_id: "a", status: "ToDo" }),
        1000,
      );
      await seed(
        makeIssue({
          id: "ISS-2",
          external_id: "b",
          status: "In Progress",
          dispatch: {
            id: "uuid-1",
            pid: 0,
            host: "",
            kind: "work",
            started_at: "",
            ttl_seconds: 0,
          },
        }),
        2000,
      );
      await seed(
        makeIssue({
          id: "ISS-3",
          external_id: "c",
          status: "In Progress",
          dispatch: {
            id: "uuid-2",
            pid: 0,
            host: "",
            kind: "work",
            started_at: "",
            ttl_seconds: 0,
          },
        }),
        1500,
      );
      const result = await listInProgressYamls(REPO_PATH, "ISS");
      expect(result.map((i) => i.id)).toEqual(["ISS-3", "ISS-2"]);
    });
  });

  describe("listTriageDueYamls", () => {
    const NOW = Date.parse("2026-05-07T12:00:00Z");

    function withTriage(
      overrides: Partial<Issue>,
      expiresAt: string,
    ): Issue {
      return makeIssue({
        ...overrides,
        triage: {
          expires_at: expiresAt,
          reassess_hint: "",
          last_status: expiresAt === "" ? "" : "Confirm-Block",
          last_explain: "",
          ice: { total: 0, i: 0, c: 0, e: 0 },
          history: [],
        },
      });
    }

    it.skipIf(!handle)(
      "returns Review cards whose triage is due (expires_at empty or <= now)",
      async () => {
        await seed(
          withTriage(
            { id: "ISS-1", external_id: "a", status: "Review" },
            "2026-04-01T00:00:00Z", // past — due
          ),
          1000,
        );
        await seed(
          withTriage(
            { id: "ISS-2", external_id: "b", status: "Review" },
            "2026-09-01T00:00:00Z", // future — not due
          ),
          2000,
        );
        const result = await listTriageDueYamls(REPO_PATH, NOW, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
      },
    );

    it.skipIf(!handle)("returns Blocked cards whose triage is due", async () => {
      await seed(
        withTriage({ id: "ISS-1", external_id: "a", status: "Blocked" }, ""),
        1000,
      );
      const result = await listTriageDueYamls(REPO_PATH, NOW, "ISS");
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it.skipIf(!handle)(
      "returns Blocked cards (waiting_on != null) regardless of status",
      async () => {
        const waiting_on: WaitingOn = {
          reason: "Waits for ISS-99",
          timestamp: "2026-04-01T00:00:00Z",
          by: ["ISS-99"],
        };
        await seed(
          withTriage(
            { id: "ISS-1", external_id: "a", status: "ToDo", waiting_on },
            "",
          ),
          1000,
        );
        const result = await listTriageDueYamls(REPO_PATH, NOW, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
      },
    );

    it.skipIf(!handle)(
      "excludes ToDo cards (waiting_on == null) — they go through the work path",
      async () => {
        await seed(
          withTriage({ id: "ISS-1", external_id: "a", status: "ToDo" }, ""),
          1000,
        );
        const result = await listTriageDueYamls(REPO_PATH, NOW, "ISS");
        expect(result).toEqual([]);
      },
    );

    it.skipIf(!handle)(
      "excludes In Progress / Done / Cancelled / Needs Approval cards",
      async () => {
        for (const status of [
          "In Progress",
          "Done",
          "Cancelled",
          "Needs Approval",
        ] as IssueStatus[]) {
          await handle!.pool.query("DELETE FROM issues");
          await seed(
            withTriage({ id: "ISS-1", external_id: "a", status }, ""),
            1000,
          );
          expect(await listTriageDueYamls(REPO_PATH, NOW, "ISS")).toEqual([]);
        }
      },
    );

    it.skipIf(!handle)(
      "excludes cards with an active dispatch (dispatch != null)",
      async () => {
        await seed(
          makeIssue({
            id: "ISS-1",
            external_id: "a",
            status: "Review",
            dispatch: {
              id: "uuid-1",
              pid: 1,
              host: "h",
              kind: "triage",
              started_at: "2026-05-07T11:55:00Z",
              ttl_seconds: 600,
            },
          }),
          1000,
        );
        expect(await listTriageDueYamls(REPO_PATH, NOW, "ISS")).toEqual([]);
      },
    );

    it.skipIf(!handle)(
      "sorts never-triaged (expires_at === '') before stale-triaged",
      async () => {
        await seed(
          withTriage(
            { id: "ISS-1", external_id: "a", status: "Review" },
            "2026-04-01T00:00:00Z",
          ),
          1000,
        );
        await seed(
          withTriage({ id: "ISS-2", external_id: "b", status: "Review" }, ""),
          5000,
        );
        const result = await listTriageDueYamls(REPO_PATH, NOW, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-1"]);
      },
    );

    it.skipIf(!handle)(
      "sorts stale-triaged by expires_at ASC (oldest stale first)",
      async () => {
        await seed(
          withTriage(
            { id: "ISS-1", external_id: "a", status: "Review" },
            "2026-03-01T00:00:00Z",
          ),
          3000,
        );
        await seed(
          withTriage(
            { id: "ISS-2", external_id: "b", status: "Review" },
            "2026-01-01T00:00:00Z",
          ),
          2000,
        );
        await seed(
          withTriage(
            { id: "ISS-3", external_id: "c", status: "Review" },
            "2026-04-01T00:00:00Z",
          ),
          1000,
        );
        const result = await listTriageDueYamls(REPO_PATH, NOW, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-1", "ISS-3"]);
      },
    );

    it.skipIf(!handle)(
      "FIFO mirror_updated_at tiebreak when expires_at matches exactly",
      async () => {
        await seed(
          withTriage(
            { id: "ISS-2", external_id: "b", status: "Review" },
            "2026-04-01T00:00:00Z",
          ),
          2000,
        );
        await seed(
          withTriage(
            { id: "ISS-1", external_id: "a", status: "Review" },
            "2026-04-01T00:00:00Z",
          ),
          1000,
        );
        const result = await listTriageDueYamls(REPO_PATH, NOW, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-1", "ISS-2"]);
      },
    );

    it.skipIf(!handle)(
      "treats a malformed expires_at (non-parseable) as due (fail-open — re-triage rewrites)",
      async () => {
        await seed(
          withTriage(
            { id: "ISS-1", external_id: "a", status: "Review" },
            "not-a-real-date",
          ),
          1000,
        );
        const result = await listTriageDueYamls(REPO_PATH, NOW, "ISS");
        expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
      },
    );
  });
});
