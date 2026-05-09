import { Pool, types as pgTypes } from "pg";
import type { PoolConfig } from "pg";
import { randomBytes } from "crypto";

/**
 * Real-Postgres integration test helper. Creates an isolated database on the
 * local `danxbot-postgres` instance, returns a Pool connected to it, and
 * exposes a `close()` that drops the database when the test is done.
 *
 * Skip semantics: if PG is not reachable (CI without docker, dev box without
 * `make launch-infra`), `createTestDb()` returns `null`. Callers wrap the
 * test body in `it.skipIf(!handle, ...)` so the suite passes — green when
 * PG is up (full verification), green when PG is down (skip with no-op).
 *
 * Connection params come from env (`DANXBOT_DB_HOST/USER/PASSWORD/PORT`)
 * with defaults matching local dev (`127.0.0.1:5433`, user/pass `danxbot`).
 * The helper does NOT use `src/config.ts` — config.ts asserts required env
 * vars at import time, which is the wrong shape for a test helper that
 * needs to soft-fail when PG is unavailable.
 */

// pg returns BIGINT (oid 20) as string by default; coerce to number to
// match the production setting in src/db/connection.ts. Doing it here
// keeps tests aligned with prod row shapes.
pgTypes.setTypeParser(20, (s: string) => parseInt(s, 10));

export interface TestDbHandle {
  pool: Pool;
  database: string;
  close: () => Promise<void>;
}

function adminPoolOptions(): PoolConfig {
  // Test always runs on the host — the docker-network hostname `postgres`
  // does not resolve there, so `127.0.0.1` is hard-coded. `DANXBOT_DB_PORT`
  // matches `src/config.ts`'s host-mode reader.
  return {
    host: "127.0.0.1",
    port: parseInt(process.env.DANXBOT_DB_PORT ?? "5433", 10),
    user: process.env.DANXBOT_DB_USER ?? "danxbot",
    password: process.env.DANXBOT_DB_PASSWORD ?? "danxbot",
    database: "postgres",
    max: 1,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 2000,
  };
}

function uniqueDbName(): string {
  return `danxbot_test_${randomBytes(6).toString("hex")}`;
}

/**
 * Create a fresh database on the local PG instance and return a Pool
 * connected to it. Returns `null` when PG is unreachable so tests can
 * gracefully skip via `it.skipIf(!handle, ...)`.
 */
export async function createTestDb(): Promise<TestDbHandle | null> {
  const adminOpts = adminPoolOptions();
  const adminPool = new Pool(adminOpts);

  let database: string;
  try {
    // Probe connectivity first — fail fast and quietly when PG is down.
    const client = await adminPool.connect();
    try {
      database = uniqueDbName();
      // CREATE DATABASE cannot run inside a transaction; quote the
      // identifier so the random suffix can never inject SQL even
      // though randomBytes hex is intrinsically safe.
      await client.query(`CREATE DATABASE "${database}"`);
    } finally {
      client.release();
    }
  } catch (err) {
    // Surface WHY the probe failed so a misconfigured port / wrong
    // password / authentication failure is distinguishable from "PG
    // simply not running" (the documented soft-fail case).
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[test-db] Postgres unreachable, suite will skip: ${msg}`);
    await adminPool.end().catch(() => undefined);
    return null;
  }

  await adminPool.end();

  const pool = new Pool({
    ...adminOpts,
    database,
    max: 4,
  });

  return {
    pool,
    database,
    async close() {
      await pool.end();
      const drop = new Pool(adminOpts);
      try {
        // Terminate stragglers before DROP — PG refuses to drop a DB
        // with active connections.
        await drop.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
        await drop.query(`DROP DATABASE IF EXISTS "${database}"`);
      } finally {
        await drop.end();
      }
    },
  };
}
