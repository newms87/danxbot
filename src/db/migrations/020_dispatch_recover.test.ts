import { describe, it, expect, afterAll } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createTestDb, type TestDbHandle } from "../test-db.js";
import { up as up001 } from "./001_initial_schema.js";
import { up as up009 } from "./009_dispatches_table.js";
import { up, down } from "./020_dispatch_recover.js";

/**
 * Real-Postgres integration tests for migration 020. Validates that
 * `recover_count` lands as `INT NOT NULL DEFAULT 0`, `parent_recover_id`
 * lands as nullable `VARCHAR(255)`, the partial index covers only
 * non-NULL rows, and the down direction drops both columns + the index.
 *
 * Skip semantics mirror migrations 016 + 019 — when local Postgres is
 * not reachable (CI without docker, dev box without `make launch-infra`)
 * `createTestDb` returns null and every `it.skipIf(!handle, ...)` body
 * passes as skipped without setup.
 *
 * Each `it` runs against a single shared database. The fixture stack:
 *   - migration 001 creates `set_updated_at()` (referenced by 009's
 *     trigger)
 *   - migration 009 creates the `dispatches` table (the surface 020 alters)
 *   - migration 020 up runs once at suite setup
 *   - down/up cycle test restores the columns before returning so
 *     subsequent tests still see the schema applied.
 */

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[020_dispatch_recover.test] skipping — local Postgres not reachable; run `docker compose up -d` to enable",
  );
} else {
  await runMigration(handle.pool, up001);
  await runMigration(handle.pool, up009);
  await runMigration(handle.pool, up);
}

async function runMigration(
  pool: Pool,
  fn: (client: PoolClient) => Promise<void>,
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

describe("migration 020 — dispatches.recover_count + parent_recover_id", () => {
  afterAll(async () => {
    if (handle) await handle.close();
  });

  it.skipIf(!handle)(
    "adds recover_count as INT NOT NULL DEFAULT 0",
    async () => {
      const rows = await handle!.pool.query<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'dispatches'
            AND column_name = 'recover_count'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].data_type).toBe("integer");
      expect(rows.rows[0].is_nullable).toBe("NO");
      expect(rows.rows[0].column_default).toBe("0");
    },
  );

  it.skipIf(!handle)(
    "adds parent_recover_id as nullable VARCHAR(255)",
    async () => {
      const rows = await handle!.pool.query<{
        data_type: string;
        is_nullable: string;
        character_maximum_length: number | null;
      }>(
        `SELECT data_type, is_nullable, character_maximum_length
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'dispatches'
            AND column_name = 'parent_recover_id'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].data_type).toBe("character varying");
      expect(rows.rows[0].is_nullable).toBe("YES");
      expect(rows.rows[0].character_maximum_length).toBe(255);
    },
  );

  it.skipIf(!handle)(
    "creates the partial index on parent_recover_id",
    async () => {
      const rows = await handle!.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
           WHERE schemaname = 'public'
             AND tablename = 'dispatches'
             AND indexname = 'idx_dispatches_parent_recover_id'`,
      );
      expect(rows.rows).toHaveLength(1);
      // Partial index — `WHERE parent_recover_id IS NOT NULL`. Encoded
      // in the index definition; presence proves the partial predicate
      // shipped (without it the index would scan every row including
      // the millions of non-recover NULLs in steady state).
      expect(rows.rows[0].indexdef.toLowerCase()).toContain(
        "where (parent_recover_id is not null)",
      );
    },
  );

  it.skipIf(!handle)(
    "INSERT without recover_count / parent_recover_id backfills 0 / NULL",
    async () => {
      // Insert minimum-viable dispatch row — omits the new columns to
      // exercise the column defaults. `started_at` + the JSON metadata
      // are required by the 009 schema (NOT NULL); the rest are
      // permitted to default.
      await handle!.pool.query(
        `INSERT INTO dispatches (id, repo_name, "trigger", trigger_metadata,
                                  "status", started_at, runtime_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          "test-dispatch-020",
          "test-repo",
          "api",
          JSON.stringify({ endpoint: "/api/launch", initialPrompt: "" }),
          "completed",
          Date.now(),
          "docker",
        ],
      );

      const rows = await handle!.pool.query<{
        recover_count: number;
        parent_recover_id: string | null;
      }>(
        `SELECT recover_count, parent_recover_id FROM dispatches
           WHERE id = $1`,
        ["test-dispatch-020"],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].recover_count).toBe(0);
      expect(rows.rows[0].parent_recover_id).toBeNull();

      await handle!.pool.query(
        `DELETE FROM dispatches WHERE id = $1`,
        ["test-dispatch-020"],
      );
    },
  );

  it.skipIf(!handle)(
    "up() is idempotent (re-applying after first up is a no-op)",
    async () => {
      await runMigration(handle!.pool, up);

      const cols = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'dispatches'
            AND column_name IN ('recover_count', 'parent_recover_id')`,
      );
      expect(cols.rows[0].count).toBe("2");
    },
  );

  it.skipIf(!handle)(
    "down() drops both columns + index; up() re-applies cleanly",
    async () => {
      await runMigration(handle!.pool, down);

      const colsAfterDown = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'dispatches'
            AND column_name IN ('recover_count', 'parent_recover_id')`,
      );
      expect(colsAfterDown.rows[0].count).toBe("0");

      const idxAfterDown = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname = 'idx_dispatches_parent_recover_id'`,
      );
      expect(idxAfterDown.rows[0].count).toBe("0");

      // Restore so any later test in this suite still sees the columns.
      await runMigration(handle!.pool, up);
      const colsAfterUp = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'dispatches'
            AND column_name IN ('recover_count', 'parent_recover_id')`,
      );
      expect(colsAfterUp.rows[0].count).toBe("2");
    },
  );

  it.skipIf(!handle)(
    "down() is idempotent (dropping a non-existent column is a no-op)",
    async () => {
      await runMigration(handle!.pool, down);
      // Second down — both columns + index already gone; must not throw.
      await runMigration(handle!.pool, down);
      // Restore so the suite leaves the schema applied.
      await runMigration(handle!.pool, up);
    },
  );
});
