import { readdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Pool } from "mysql2/promise";
import { getAdminPool, closeAdminPool } from "./connection.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("migrate");

export interface Migration {
  up(pool: Pool): Promise<void>;
  down(pool: Pool): Promise<void>;
}

/**
 * Run all pending database migrations.
 * Creates the database and migrations table if they don't exist.
 * Errors are logged but do not crash the bot (graceful degradation).
 */
export async function runMigrations(): Promise<void> {
  if (!config.db.host) {
    log.warn("Database host not configured, skipping migrations");
    return;
  }

  try {
    const pool = getAdminPool();
    const dbName = config.db.database;

    // Create database if it doesn't exist, then switch to it
    await pool.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await pool.query(`USE \`${dbName}\``);
    log.info(`Database '${dbName}' ready`);

    // Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Get already-applied migrations
    const [rows] = await pool.query(
      "SELECT name FROM migrations ORDER BY id",
    );
    const applied = new Set(
      (rows as Array<{ name: string }>).map((r) => r.name),
    );

    // Scan migration files
    const migrationsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "migrations",
    );
    let files: string[];
    try {
      files = (await readdir(migrationsDir)).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
      );
    } catch {
      log.info("No migrations directory found, skipping");
      return;
    }
    files.sort();

    // Apply pending migrations
    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        log.debug(`Skipping already-applied migration: ${file}`);
        continue;
      }

      log.info(`Applying migration: ${file}`);
      const modulePath = join(migrationsDir, file);
      const migration: Migration = await import(modulePath);
      await migration.up(pool);

      await pool.query("INSERT INTO migrations (name) VALUES (?)", [file]);
      appliedCount++;
      log.info(`Applied migration: ${file}`);
    }

    if (appliedCount === 0) {
      log.info("No pending migrations");
    } else {
      log.info(`Applied ${appliedCount} migration(s)`);
    }
  } catch (error) {
    log.error("Migration failed (bot will continue without database)", error);
  } finally {
    await closeAdminPool();
  }
}
