import { describe, it, expect, afterAll } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createTestDb, type TestDbHandle } from "../test-db.js";
import { up as up021 } from "./021_system_errors.js";
import { up as up022, down as down022 } from "./022_system_errors_recurrence.js";

/**
 * Real-Postgres integration tests for migration 022 (DX-566 Phase 6).
 * Adds `recurrence_count INT NOT NULL DEFAULT 0` on `system_errors`.
 * Mirrors the skip semantics of migrations 016 / 020 / 021.
 */

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[022_system_errors_recurrence.test] skipping — local Postgres not reachable",
  );
} else {
  await runMigration(handle.pool, up021);
  await runMigration(handle.pool, up022);
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

describe("migration 022 — system_errors.recurrence_count", () => {
  afterAll(async () => {
    if (handle) await handle.close();
  });

  it.skipIf(!handle)(
    "adds recurrence_count column (integer, NOT NULL, default 0)",
    async () => {
      const rows = await handle!.pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name='system_errors'
            AND column_name='recurrence_count'`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].data_type).toBe("integer");
      expect(rows.rows[0].is_nullable).toBe("NO");
      expect(rows.rows[0].column_default).toBe("0");
    },
  );

  it.skipIf(!handle)(
    "pre-existing inserts default to recurrence_count=0",
    async () => {
      const sig = "rec0000countdef0";
      await handle!.pool.query(
        `INSERT INTO system_errors (signature_hash, category_key, component,
          err_class, normalized_msg, sample_payload, count, first_seen, last_seen, repo)
          VALUES ($1, 'c:E', 'c', 'E', 'm', '{}'::jsonb, 1, NOW(), NOW(), 'r')`,
        [sig],
      );
      const r = await handle!.pool.query<{ recurrence_count: number }>(
        "SELECT recurrence_count FROM system_errors WHERE signature_hash=$1",
        [sig],
      );
      expect(r.rows[0].recurrence_count).toBe(0);
      await handle!.pool.query(
        "DELETE FROM system_errors WHERE signature_hash=$1",
        [sig],
      );
    },
  );

  it.skipIf(!handle)(
    "down() removes the column; up() re-applies cleanly",
    async () => {
      await runMigration(handle!.pool, down022);
      const gone = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.columns
          WHERE table_schema='public' AND table_name='system_errors'
            AND column_name='recurrence_count'`,
      );
      expect(gone.rows[0].count).toBe("0");
      await runMigration(handle!.pool, up022);
      const back = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.columns
          WHERE table_schema='public' AND table_name='system_errors'
            AND column_name='recurrence_count'`,
      );
      expect(back.rows[0].count).toBe("1");
    },
  );
});
