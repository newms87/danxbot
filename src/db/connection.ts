import mysql from "mysql2/promise";
import type { Pool, PoolOptions } from "mysql2/promise";
import { config } from "../config.js";
import type { RepoDatabaseConfig } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger("db");

const CONNECTION_LIMIT = 5;

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

function createPoolOptions(dbConfig: DbConfig): PoolOptions {
  return {
    host: dbConfig.host,
    ...(dbConfig.port ? { port: dbConfig.port } : {}),
    user: dbConfig.user,
    password: dbConfig.password,
    ...(dbConfig.database ? { database: dbConfig.database } : {}),
    connectionLimit: CONNECTION_LIMIT,
    waitForConnections: true,
    connectTimeout: config.db.connectTimeoutMs,
  };
}

function basePoolOptions(): PoolOptions {
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
    log.info("Creating application database pool");
    pool = mysql.createPool({
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
    adminPool = mysql.createPool(basePoolOptions());
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
  platformPool = mysql.createPool(createPoolOptions(repoDb));
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
