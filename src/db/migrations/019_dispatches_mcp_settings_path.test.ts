import { describe, it, expect, afterAll } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createTestDb, type TestDbHandle } from "../test-db.js";
import { up as up001 } from "./001_initial_schema.js";
import { up as up009 } from "./009_dispatches_table.js";
import { up, down } from "./019_dispatches_mcp_settings_path.js";

/**
 * Real-Postgres integration tests for migration 019. Validates that the
 * `mcp_settings_path` column lands as a nullable VARCHAR(512), is
 * idempotent on re-up (so a partial-apply replay does not error), and
 * that the down direction drops the column without disturbing the rest
 * of the dispatches schema.
 *
 * Skip semantics mirror migration 016's test — when local Postgres is
 * not reachable (CI without docker, dev box without `make launch-infra`)
 * `createTestDb` returns null and every `it.skipIf(!handle, ...)` body
 * passes as skipped without setup.
 *
 * Each `it` runs against a single shared database. The fixture stack:
 *   - migration 009 creates the `dispatches` table (the surface 019 alters)
 *   - migration 019 up runs once at suite setup
 *   - down/up cycle test restores the column before returning so
 *     subsequent tests still see the schema applied.
 */

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[019_dispatches_mcp_settings_path.test] skipping — local Postgres not reachable; run `docker compose up -d` to enable",
  );
} else {
  // Migration 009 declares a BEFORE UPDATE trigger that calls
  // `set_updated_at()` — that function is created by migration 001.
  // Apply 001 first so 009's CREATE TRIGGER resolves the function ref.
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

describe("migration 019 — dispatches.mcp_settings_path", () => {
  afterAll(async () => {
    if (handle) await handle.close();
  });

  it.skipIf(!handle)(
    "adds mcp_settings_path as a nullable VARCHAR(512) column",
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
            AND column_name = 'mcp_settings_path'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].data_type).toBe("character varying");
      expect(rows.rows[0].is_nullable).toBe("YES");
      expect(rows.rows[0].character_maximum_length).toBe(512);
    },
  );

  it.skipIf(!handle)("up() is idempotent (re-applying after first up is a no-op)", async () => {
    // The column already exists (suite-level up). A second up() run must
    // not throw — protects against partial-apply replay where
    // schema_migrations rolled back but the DDL committed (rare but real).
    await runMigration(handle!.pool, up);

    const rows = await handle!.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'dispatches'
          AND column_name = 'mcp_settings_path'`,
    );
    expect(rows.rows[0].count).toBe("1");
  });

  it.skipIf(!handle)(
    "down() drops mcp_settings_path; up() re-applies cleanly",
    async () => {
      await runMigration(handle!.pool, down);
      const afterDown = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'dispatches'
            AND column_name = 'mcp_settings_path'`,
      );
      expect(afterDown.rows[0].count).toBe("0");

      // Restore so any later test in this suite still sees the column.
      await runMigration(handle!.pool, up);
      const afterUp = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'dispatches'
            AND column_name = 'mcp_settings_path'`,
      );
      expect(afterUp.rows[0].count).toBe("1");
    },
  );

  it.skipIf(!handle)(
    "down() is idempotent (dropping a non-existent column is a no-op)",
    async () => {
      await runMigration(handle!.pool, down);
      // Second down — the column is already gone; must not throw.
      await runMigration(handle!.pool, down);
      // Restore so the suite leaves the schema applied.
      await runMigration(handle!.pool, up);
    },
  );
});
