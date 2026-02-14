import mysql from "mysql2/promise";
import type { Pool, PoolOptions } from "mysql2/promise";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("db");

const CONNECTION_LIMIT = 5;

let pool: Pool | null = null;
let adminPool: Pool | null = null;

function basePoolOptions(): PoolOptions {
  return {
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    connectionLimit: CONNECTION_LIMIT,
    waitForConnections: true,
    connectTimeout: config.db.connectTimeoutMs,
  };
}

/**
 * Get a connection pool connected to the flytebot_chat database.
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
