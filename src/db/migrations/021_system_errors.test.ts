import { describe, it, expect, afterAll } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createTestDb, type TestDbHandle } from "../test-db.js";
import { up, down } from "./021_system_errors.js";

/**
 * Real-Postgres integration tests for migration 021. Mirrors the skip
 * semantics of migrations 016 + 020 — when local PG is unreachable,
 * `createTestDb` returns null and each `it.skipIf(!handle, ...)` skips.
 *
 * Migration 021 stands alone — it adds `system_errors` +
 * `system_error_repairs` from scratch with no FK into the rest of the
 * schema (the only FK is internal: repairs.error_id → errors.id), so
 * no other migrations need pre-running for this suite.
 */

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[021_system_errors.test] skipping — local Postgres not reachable; run `docker compose up -d` to enable",
  );
} else {
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

describe("migration 021 — system_errors + system_error_repairs", () => {
  afterAll(async () => {
    if (handle) await handle.close();
  });

  it.skipIf(!handle)(
    "creates system_errors with all stated columns + types",
    async () => {
      const rows = await handle!.pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'system_errors'
          ORDER BY ordinal_position`,
      );
      const cols = new Map(rows.rows.map((r) => [r.column_name, r]));
      expect(cols.get("id")?.data_type).toBe("bigint");
      expect(cols.get("signature_hash")?.data_type).toBe("character");
      expect(cols.get("signature_hash")?.is_nullable).toBe("NO");
      expect(cols.get("category_key")?.data_type).toBe("text");
      expect(cols.get("component")?.data_type).toBe("text");
      expect(cols.get("err_class")?.data_type).toBe("text");
      expect(cols.get("normalized_msg")?.data_type).toBe("text");
      expect(cols.get("sample_payload")?.data_type).toBe("jsonb");
      expect(cols.get("count")?.data_type).toBe("integer");
      expect(cols.get("first_seen")?.data_type).toBe(
        "timestamp with time zone",
      );
      expect(cols.get("last_seen")?.data_type).toBe(
        "timestamp with time zone",
      );
      expect(cols.get("status")?.data_type).toBe("text");
      expect(cols.get("repo")?.data_type).toBe("text");
    },
  );

  it.skipIf(!handle)("enforces UNIQUE on signature_hash", async () => {
    const sig = "abcdef0123456789";
    await handle!.pool.query(
      `INSERT INTO system_errors (signature_hash, category_key, component,
        err_class, normalized_msg, sample_payload, count, first_seen, last_seen, repo)
        VALUES ($1, 'c:E', 'c', 'E', 'm', '{}'::jsonb, 1, NOW(), NOW(), 'r')`,
      [sig],
    );
    let conflicted = false;
    try {
      await handle!.pool.query(
        `INSERT INTO system_errors (signature_hash, category_key, component,
          err_class, normalized_msg, sample_payload, count, first_seen, last_seen, repo)
          VALUES ($1, 'c:E', 'c', 'E', 'm', '{}'::jsonb, 1, NOW(), NOW(), 'r')`,
        [sig],
      );
    } catch (err) {
      // PG SQLSTATE 23505 = unique violation
      conflicted =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === "23505";
    }
    expect(conflicted).toBe(true);
    await handle!.pool.query("DELETE FROM system_errors WHERE signature_hash = $1", [sig]);
  });

  it.skipIf(!handle)("creates system_errors_status_count_idx", async () => {
    const rows = await handle!.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'system_errors'
           AND indexname = 'system_errors_status_count_idx'`,
    );
    expect(rows.rows).toHaveLength(1);
    const def = rows.rows[0].indexdef.toLowerCase();
    expect(def).toContain("status");
    expect(def).toContain("count");
  });

  it.skipIf(!handle)(
    "creates system_error_repairs with FK + UNIQUE (error_id, attempt_n)",
    async () => {
      const rows = await handle!.pool.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'system_error_repairs'
          ORDER BY ordinal_position`,
      );
      const cols = new Map(rows.rows.map((r) => [r.column_name, r.data_type]));
      expect(cols.get("error_id")).toBe("bigint");
      expect(cols.get("attempt_n")).toBe("integer");
      expect(cols.get("card_id")).toBe("text");
      expect(cols.get("dispatch_id")).toBe("text");
      expect(cols.get("started_at")).toBe("timestamp with time zone");
      expect(cols.get("ended_at")).toBe("timestamp with time zone");
      expect(cols.get("verdict")).toBe("text");
      expect(cols.get("report_md")).toBe("text");

      // FK constraint
      const fk = await handle!.pool.query<{ confrelid: string }>(
        `SELECT confrelid::regclass::text AS confrelid
           FROM pg_constraint
          WHERE conrelid = 'system_error_repairs'::regclass
            AND contype = 'f'`,
      );
      expect(fk.rows.map((r) => r.confrelid)).toContain("system_errors");

      // UNIQUE (error_id, attempt_n) — insert into errors first so FK satisfies.
      const sig = "aaaabbbbccccdddd";
      const insErr = await handle!.pool.query<{ id: number }>(
        `INSERT INTO system_errors (signature_hash, category_key, component,
          err_class, normalized_msg, sample_payload, count, first_seen, last_seen, repo)
          VALUES ($1, 'c:E', 'c', 'E', 'm', '{}'::jsonb, 1, NOW(), NOW(), 'r')
          RETURNING id`,
        [sig],
      );
      const errorId = insErr.rows[0].id;

      await handle!.pool.query(
        `INSERT INTO system_error_repairs (error_id, attempt_n, started_at)
           VALUES ($1, 1, NOW())`,
        [errorId],
      );
      let conflicted = false;
      try {
        await handle!.pool.query(
          `INSERT INTO system_error_repairs (error_id, attempt_n, started_at)
             VALUES ($1, 1, NOW())`,
          [errorId],
        );
      } catch (err) {
        conflicted =
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: unknown }).code === "23505";
      }
      expect(conflicted).toBe(true);

      // ON DELETE CASCADE — delete parent, child should disappear.
      await handle!.pool.query("DELETE FROM system_errors WHERE id = $1", [errorId]);
      const child = await handle!.pool.query<{ id: number }>(
        "SELECT id FROM system_error_repairs WHERE error_id = $1",
        [errorId],
      );
      expect(child.rows).toHaveLength(0);
    },
  );

  it.skipIf(!handle)("count defaults to 0 + status defaults to 'open'", async () => {
    const sig = "default0000aaaa1";
    await handle!.pool.query(
      `INSERT INTO system_errors (signature_hash, category_key, component,
        err_class, normalized_msg, sample_payload, first_seen, last_seen, repo)
        VALUES ($1, 'c:E', 'c', 'E', 'm', '{}'::jsonb, NOW(), NOW(), 'r')`,
      [sig],
    );
    const r = await handle!.pool.query<{ count: number; status: string }>(
      "SELECT count, status FROM system_errors WHERE signature_hash = $1",
      [sig],
    );
    expect(r.rows[0].count).toBe(0);
    expect(r.rows[0].status).toBe("open");
    await handle!.pool.query("DELETE FROM system_errors WHERE signature_hash = $1", [sig]);
  });

  it.skipIf(!handle)(
    "rejects system_error_repairs insert with non-existent error_id",
    async () => {
      // FK enforcement direction — inserting a child whose parent
      // doesn't exist must raise SQLSTATE 23503 (foreign_key_violation).
      let code: string | undefined;
      try {
        await handle!.pool.query(
          `INSERT INTO system_error_repairs (error_id, attempt_n, started_at)
             VALUES ($1, 1, NOW())`,
          [999999999],
        );
      } catch (err) {
        if (typeof err === "object" && err !== null && "code" in err) {
          code = String((err as { code: unknown }).code);
        }
      }
      expect(code).toBe("23503");
    },
  );

  it.skipIf(!handle)(
    "down() drops both tables + the index; up() re-applies cleanly",
    async () => {
      await runMigration(handle!.pool, down);

      const tables = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('system_errors', 'system_error_repairs')`,
      );
      expect(tables.rows[0].count).toBe("0");

      await runMigration(handle!.pool, up);
      const back = await handle!.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('system_errors', 'system_error_repairs')`,
      );
      expect(back.rows[0].count).toBe("2");
    },
  );
});
