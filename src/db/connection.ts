import { Pool, types as pgTypes } from "pg";
import type { PoolClient, PoolConfig } from "pg";
import { config } from "../config.js";
import type { RepoDatabaseConfig } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger("db");

const POOL_MAX = 10;
const IDLE_TIMEOUT_MS = 30_000;

// pg returns BIGINT (oid 20) as string by default to preserve precision.
// Every BIGINT id column we use stays well under Number.MAX_SAFE_INTEGER,
// so coerce to number on the way out — consumer modules treat ids as
// JS numbers, not strings.
pgTypes.setTypeParser(20, (s: string) => parseInt(s, 10));

let pool: Pool | null = null;
let adminPool: Pool | null = null;
let platformPool: Pool | null = null;
let platformPoolInitialized = false;

interface DbConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
}

function createPoolOptions(dbConfig: DbConfig): PoolConfig {
  return {
    host: dbConfig.host,
    ...(dbConfig.port ? { port: dbConfig.port } : {}),
    user: dbConfig.user,
    password: dbConfig.password,
    ...(dbConfig.database ? { database: dbConfig.database } : {}),
    max: POOL_MAX,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.db.connectTimeoutMs,
    // DX-616: enable TCP keepalive on every pg socket so the OS detects
    // a remote-side FIN/RST before the pool hands the dead client back
    // out on `pool.connect()`. Pre-DX-616 the mirror saw "Connection
    // terminated due to connection timeout" every few minutes — a stale
    // idle conn (Postgres or network middlebox dropped the socket while
    // it was parked in the pool). Keepalive flips that into a clean
    // ECONNRESET that pg-pool itself prunes before checkout.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

function basePoolOptions(): PoolConfig {
  const {
    database: _,
    connectTimeoutMs: __,
    ...dbWithoutDatabase
  } = config.db;
  return createPoolOptions(dbWithoutDatabase);
}

/**
 * Get a connection pool connected to the danxbot_chat database.
 * Used for normal application queries.
 */
export function getPool(): Pool {
  if (!pool) {
    log.debug("Creating application database pool");
    pool = new Pool({
      ...basePoolOptions(),
      database: config.db.database,
    });
  }
  return pool;
}

/**
 * Get a connection pool without a database specified.
 * Used for migrations that need to create the database.
 */
export function getAdminPool(): Pool {
  if (!adminPool) {
    log.info("Creating admin database pool");
    adminPool = new Pool(basePoolOptions());
  }
  return adminPool;
}

/**
 * Close the application pool.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Close the admin pool.
 */
export async function closeAdminPool(): Promise<void> {
  if (adminPool) {
    await adminPool.end();
    adminPool = null;
  }
}

/**
 * Initialize the platform database pool from the repo's database config.
 * Called once at worker startup. No-op when the repo has db.enabled=false
 * (the repo has no platform DB configured and no consumer will call
 * getPlatformPool). Throws if called a second time — initialization is
 * a startup responsibility; a second call indicates a bug.
 */
export function initPlatformPool(repoDb: RepoDatabaseConfig): void {
  if (platformPoolInitialized) {
    throw new Error("Platform pool already initialized — initPlatformPool must be called exactly once at worker startup");
  }
  platformPoolInitialized = true;
  if (!repoDb.enabled) return;
  log.info("Creating platform database pool");
  platformPool = new Pool(createPoolOptions(repoDb));
}

/**
 * Thrown by getPlatformPool when the pool is unavailable. Callers
 * classify failures with `instanceof` instead of regex-matching the
 * error message — see src/worker/sql-executor.ts#classifyError.
 */
export class PlatformPoolUnavailableError extends Error {
  constructor() {
    super(
      "Platform DB pool not available — repo has db.enabled=false (no DANX_DB_HOST/DANX_DB_USER in .danxbot/.env) or initPlatformPool was not called at worker startup",
    );
    this.name = "PlatformPoolUnavailableError";
  }
}

/**
 * Get the initialized platform pool. Throws PlatformPoolUnavailableError
 * when the pool is unavailable — either initPlatformPool was never called
 * (a wiring bug) or the repo's db.enabled is false (the repo has no
 * platform DB configured).
 */
export function getPlatformPool(): Pool {
  if (!platformPool) {
    throw new PlatformPoolUnavailableError();
  }
  return platformPool;
}

/**
 * Close the platform pool.
 */
export async function closePlatformPool(): Promise<void> {
  if (platformPool) {
    await platformPool.end();
    platformPool = null;
  }
  platformPoolInitialized = false;
}

/**
 * Run a parameterized query against the application pool and return the
 * `rows` array directly. Use $1, $2, … positional parameters. Kept lean —
 * no logging, no retry — consumer modules layer those when needed.
 */
export async function query<T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await getPool().query<T extends import("pg").QueryResultRow ? T : never>(
    sql,
    params,
  );
  return result.rows as unknown as T[];
}

/**
 * Run `fn` inside a single transaction acquired from the application pool.
 * BEGIN before fn, COMMIT after success, ROLLBACK on throw, then release
 * the client in a finally block whether or not COMMIT/ROLLBACK itself
 * threw. Phase 1.2's migration runner uses this so each migration commits
 * atomically.
 */
export async function withTx<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Swallow ROLLBACK failure so the original error surfaces. PG
      // typically aborts the transaction itself when a query throws,
      // making the explicit ROLLBACK best-effort.
    }
    throw err;
  } finally {
    client.release();
  }
}

const SQLSTATE_MAP: Record<string, string> = {
  "23505": "duplicate_entry",
  "23503": "foreign_key_violation",
  "23502": "not_null_violation",
  "23514": "check_violation",
};

function sqlstateToCode(sqlstate: string): string {
  return SQLSTATE_MAP[sqlstate] ?? "unknown";
}

/**
 * Engine-agnostic database error. Consumer modules branch on `code`
 * instead of binding to PG-specific shapes (or, transiently, the legacy
 * pg-specific shapes.
 */
export class DbError extends Error {
  code: string;
  cause?: unknown;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = "DbError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }

  /**
   * Translate a raw pg error (carries `code` as SQLSTATE) into a DbError
   * with the engine-agnostic `code` consumers branch on.
   */
  static fromPgError(err: unknown): DbError {
    const sqlstate =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    const code = sqlstateToCode(sqlstate);
    const message =
      typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : "Database error";
    return new DbError(message, code, err);
  }
}
