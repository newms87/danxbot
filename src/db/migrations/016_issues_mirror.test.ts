import { describe, it, expect, afterAll } from "vitest";
import type { Pool } from "pg";
import { createTestDb, type TestDbHandle } from "../test-db.js";
import { up, down } from "./016_issues_mirror.js";

/**
 * Real-Postgres integration tests for migration 016. Validates DDL,
 * generated-column expressions, indexes, and the down/up cycle against
 * the running `danxbot-postgres` container.
 *
 * The whole suite skips when PG is not reachable (CI without docker,
 * dev box without `make launch-infra`). Locally, with `docker compose
 * up -d` healthy, every test runs end-to-end.
 *
 * The PG handle is created via top-level await so vitest sees a
 * concrete `!handle` boolean at describe-collection time — `skipIf`
 * evaluates eagerly, not lazily, so a `beforeAll`-built handle would
 * leave every test marked-skipped before setup ever ran.
 *
 * Each `it` body runs against a single shared database; tests that
 * mutate row state clean up their inserts, and the down/up-cycle test
 * restores the schema before returning so the rest of the suite still
 * sees a clean migration.
 */

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[016_issues_mirror.test] skipping — local Postgres not reachable; run `docker compose up -d` to enable",
  );
} else {
  await runMigration(handle.pool, up);
}

const EXPECTED_ISSUES_COLUMNS: Array<[string, string]> = [
  ["repo_name", "text"],
  ["data", "jsonb"],
  ["content_hash", "text"],
  ["mirror_updated_at", "timestamp with time zone"],
  ["id", "text"],
  ["external_id", "text"],
  ["status", "text"],
  ["list_kind", "text"],
  ["type", "text"],
  ["parent_id", "text"],
  ["dispatch_id", "text"],
  ["dispatch_host_pid", "integer"],
  ["assigned_agent", "text"],
  ["blocked", "boolean"],
  ["blocked_reason", "text"],
  ["labels", "jsonb"],
  ["dispatch_started_at", "timestamp with time zone"],
  ["created_at", "timestamp with time zone"],
  ["updated_at", "timestamp with time zone"],
  ["closed_at", "timestamp with time zone"],
  ["last_status_change_at", "timestamp with time zone"],
  ["triage_expires_at", "timestamp with time zone"],
];

const EXPECTED_HISTORY_COLUMNS: Array<[string, string]> = [
  ["id", "bigint"],
  ["repo_name", "text"],
  ["issue_id", "text"],
  ["changed_at", "timestamp with time zone"],
  ["source", "text"],
  ["patch", "jsonb"],
  ["prev_hash", "text"],
  ["next_hash", "text"],
];

const EXPECTED_INDEXES = [
  "issues_pkey",
  "issues_status",
  "issues_status_kind",
  "issues_assigned",
  "issues_parent",
  "issues_triage_due",
  "issues_dispatch_id",
  "issues_labels_gin",
  "issue_history_pkey",
  "issue_history_timeline",
  "issue_history_source",
];

async function runMigration(
  pool: Pool,
  fn: typeof up | typeof down,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

describe("migration 016 — issues mirror", () => {
  afterAll(async () => {
    if (handle) await handle.close();
  });

  it.skipIf(!handle)("creates issues and issue_history tables", async () => {
    const rows = await handle!.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('issues', 'issue_history')
         ORDER BY table_name`,
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual([
      "issue_history",
      "issues",
    ]);
  });

  it.skipIf(!handle)("issues.data column is jsonb", async () => {
    const rows = await handle!.pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'issues'
           AND column_name = 'data'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].data_type).toBe("jsonb");
  });

  it.skipIf(!handle)(
    "issues — every spec column exists with the expected type",
    async () => {
      const rows = await handle!.pool.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'issues'`,
      );
      const got = new Map(rows.rows.map((r) => [r.column_name, r.data_type]));
      for (const [name, type] of EXPECTED_ISSUES_COLUMNS) {
        expect(got.get(name), `issues.${name} type`).toBe(type);
      }
      // No unexpected columns either — the spec is the full surface.
      expect(got.size).toBe(EXPECTED_ISSUES_COLUMNS.length);
    },
  );

  it.skipIf(!handle)(
    "issues — generated columns derive correct values from inserted data jsonb",
    async () => {
      // Sparse row — exercises NULL passthrough + the blocked COALESCE
      // branch (no `blocked` key → NULL `data->'blocked'` → COALESCE
      // forces `false`).
      await handle!.pool.query(
        `INSERT INTO issues (repo_name, data, content_hash) VALUES ($1, $2, $3)`,
        [
          "test-repo",
          JSON.stringify({ id: "DX-1", status: "ToDo", external_id: "abc" }),
          "hash-1",
        ],
      );

      // Rich row — exercises every generated column with a non-null
      // value, including the dispatch path (jsonb `#>>` extraction with
      // `::int` cast) and the `blocked` object branch.
      await handle!.pool.query(
        `INSERT INTO issues (repo_name, data, content_hash) VALUES ($1, $2, $3)`,
        [
          "test-repo",
          JSON.stringify({
            id: "DX-2",
            external_id: "xyz",
            status: "In Progress",
            list_kind: "default",
            type: "Feature",
            parent_id: "DX-100",
            assigned_agent: "agent-7",
            labels: ["bug", "p1"],
            blocked: { reason: "waiting on review" },
            dispatch: {
              id: "abc-123",
              pid: 4242,
            },
          }),
          "hash-2",
        ],
      );

      const sparse = await handle!.pool.query<{
        id: string;
        status: string;
        external_id: string;
        blocked: boolean;
        blocked_reason: string | null;
        labels: unknown;
        dispatch_id: string | null;
        dispatch_host_pid: number | null;
      }>(
        `SELECT id, "status", external_id, blocked, blocked_reason, labels,
                dispatch_id, dispatch_host_pid
           FROM issues WHERE repo_name = 'test-repo' AND id = 'DX-1'`,
      );
      expect(sparse.rows).toHaveLength(1);
      expect(sparse.rows[0].id).toBe("DX-1");
      expect(sparse.rows[0].status).toBe("ToDo");
      expect(sparse.rows[0].external_id).toBe("abc");
      expect(sparse.rows[0].blocked).toBe(false);
      expect(sparse.rows[0].blocked_reason).toBeNull();
      expect(sparse.rows[0].labels).toBeNull();
      expect(sparse.rows[0].dispatch_id).toBeNull();
      expect(sparse.rows[0].dispatch_host_pid).toBeNull();

      const rich = await handle!.pool.query<{
        id: string;
        external_id: string;
        status: string;
        list_kind: string;
        type: string;
        parent_id: string;
        assigned_agent: string;
        labels: string[];
        blocked: boolean;
        blocked_reason: string;
        dispatch_id: string;
        dispatch_host_pid: number;
      }>(
        `SELECT id, external_id, "status", list_kind, "type", parent_id,
                assigned_agent, labels, blocked, blocked_reason,
                dispatch_id, dispatch_host_pid
           FROM issues WHERE repo_name = 'test-repo' AND id = 'DX-2'`,
      );
      expect(rich.rows).toHaveLength(1);
      const row = rich.rows[0];
      expect(row.id).toBe("DX-2");
      expect(row.external_id).toBe("xyz");
      expect(row.status).toBe("In Progress");
      expect(row.list_kind).toBe("default");
      expect(row.type).toBe("Feature");
      expect(row.parent_id).toBe("DX-100");
      expect(row.assigned_agent).toBe("agent-7");
      expect(row.labels).toEqual(["bug", "p1"]);
      expect(row.blocked).toBe(true);
      expect(row.blocked_reason).toBe("waiting on review");
      expect(row.dispatch_id).toBe("abc-123");
      expect(row.dispatch_host_pid).toBe(4242);

      await handle!.pool.query(
        `DELETE FROM issues WHERE repo_name = 'test-repo' AND id IN ('DX-1', 'DX-2')`,
      );
    },
  );

  it.skipIf(!handle)(
    "issues — every index in the spec exists in pg_indexes",
    async () => {
      const rows = await handle!.pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
           WHERE schemaname = 'public'
             AND tablename IN ('issues', 'issue_history')`,
      );
      const got = new Set(rows.rows.map((r) => r.indexname));
      for (const name of EXPECTED_INDEXES) {
        expect(got.has(name), `index ${name}`).toBe(true);
      }
    },
  );

  it.skipIf(!handle)(
    "issue_history — every spec column exists; no FK to issues",
    async () => {
      const rows = await handle!.pool.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'issue_history'`,
      );
      const got = new Map(rows.rows.map((r) => [r.column_name, r.data_type]));
      for (const [name, type] of EXPECTED_HISTORY_COLUMNS) {
        expect(got.get(name), `issue_history.${name} type`).toBe(type);
      }
      expect(got.size).toBe(EXPECTED_HISTORY_COLUMNS.length);

      const fks = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.table_constraints
           WHERE table_schema = 'public'
             AND table_name = 'issue_history'
             AND constraint_type = 'FOREIGN KEY'`,
      );
      expect(fks.rows[0].count).toBe("0");
    },
  );

  it.skipIf(!handle)("down() drops both tables; up() re-applies cleanly", async () => {
    await runMigration(handle!.pool, down);

    const after = await handle!.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('issues', 'issue_history')`,
    );
    expect(after.rows).toHaveLength(0);

    // Restore the schema for the rest of the suite.
    await runMigration(handle!.pool, up);

    const restored = await handle!.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('issues', 'issue_history')`,
    );
    expect(restored.rows).toHaveLength(2);
  });

  it.skipIf(!handle)(
    "issue_history — inserting a row with prev_hash NULL succeeds",
    async () => {
      await handle!.pool.query(
        `INSERT INTO issue_history (repo_name, issue_id, "source", patch, prev_hash, next_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          "test-repo",
          "DX-init",
          "writer",
          JSON.stringify([{ op: "add", path: "/", value: {} }]),
          null,
          "hash-init",
        ],
      );
      const rows = await handle!.pool.query<{
        prev_hash: string | null;
        next_hash: string;
      }>(
        `SELECT prev_hash, next_hash FROM issue_history
           WHERE repo_name = 'test-repo' AND issue_id = 'DX-init'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].prev_hash).toBeNull();
      expect(rows.rows[0].next_hash).toBe("hash-init");

      await handle!.pool.query(
        `DELETE FROM issue_history WHERE repo_name = 'test-repo' AND issue_id = 'DX-init'`,
      );
    },
  );

  it.skipIf(!handle)(
    "deleting an issues row does NOT cascade-delete its issue_history rows",
    async () => {
      const data = { id: "DX-99", status: "ToDo" };
      await handle!.pool.query(
        `INSERT INTO issues (repo_name, data, content_hash) VALUES ($1, $2, $3)`,
        ["test-repo", JSON.stringify(data), "hash-99"],
      );
      await handle!.pool.query(
        `INSERT INTO issue_history (repo_name, issue_id, "source", patch, prev_hash, next_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          "test-repo",
          "DX-99",
          "writer",
          JSON.stringify([{ op: "replace", path: "/status", value: "Done" }]),
          "hash-prev",
          "hash-next",
        ],
      );

      await handle!.pool.query(
        `DELETE FROM issues WHERE repo_name = 'test-repo' AND id = 'DX-99'`,
      );

      const remaining = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM issue_history
           WHERE repo_name = 'test-repo' AND issue_id = 'DX-99'`,
      );
      expect(remaining.rows[0].count).toBe("1");

      await handle!.pool.query(
        `DELETE FROM issue_history WHERE repo_name = 'test-repo' AND issue_id = 'DX-99'`,
      );
    },
  );
});
