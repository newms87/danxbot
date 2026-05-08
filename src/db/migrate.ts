import { readdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Pool, PoolClient } from "pg";
import { getPool, closePool, withTx } from "./connection.js";
import { createLogger } from "../logger.js";

const log = createLogger("migrate");

export interface Migration {
  up(client: PoolClient): Promise<void>;
  down?(client: PoolClient): Promise<void>;
}

const VERSION_RE = /^(\d+)_/;

function parseVersion(filename: string): number {
  const m = VERSION_RE.exec(filename);
  if (!m) {
    throw new Error(
      `Migration filename does not start with a number: ${filename}`,
    );
  }
  return parseInt(m[1], 10);
}

async function ensureSchemaMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadAppliedVersions(pool: Pool): Promise<Set<number>> {
  const { rows } = await pool.query<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return new Set(rows.map((r) => r.version));
}

async function listMigrationFiles(): Promise<string[]> {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "migrations",
  );
  let files: string[];
  try {
    files = (await readdir(migrationsDir)).filter(
      (f) =>
        (f.endsWith(".ts") || f.endsWith(".js")) &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test.js") &&
        !f.endsWith(".d.ts"),
    );
  } catch {
    log.info("No migrations directory found, skipping");
    return [];
  }
  files.sort();
  return files;
}

async function loadMigration(filename: string): Promise<Migration> {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "migrations",
  );
  const mod = await import(join(migrationsDir, filename));
  return mod as Migration;
}

/**
 * Run all pending database migrations.
 *
 * The Postgres database itself is created by the docker-compose
 * service (POSTGRES_DB env). This runner only manages the
 * schema_migrations tracking table and applies any unapplied
 * versioned migration in `src/db/migrations/`.
 *
 * Each migration runs inside its own transaction (withTx). On
 * failure the BEGIN/ROLLBACK wrapper aborts the migration AND skips
 * the schema_migrations row insert — so a partially-applied version
 * never ends up recorded as applied. Re-running picks up where the
 * failure left off.
 *
 * Idempotent: repeated boots are no-ops once every file is recorded.
 */
export async function runMigrations(): Promise<void> {
  try {
    const pool = getPool();
    await ensureSchemaMigrationsTable(pool);
    const applied = await loadAppliedVersions(pool);

    const files = await listMigrationFiles();
    let appliedCount = 0;
    for (const file of files) {
      const version = parseVersion(file);
      if (applied.has(version)) {
        log.debug(`Skipping already-applied migration: ${file}`);
        continue;
      }

      log.info(`Applying migration: ${file}`);
      const migration = await loadMigration(file);
      await withTx(async (client) => {
        await migration.up(client);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [version],
        );
      });
      appliedCount++;
      log.info(`Applied migration: ${file}`);
    }

    if (appliedCount === 0) {
      log.info("No pending migrations");
    } else {
      log.info(`Applied ${appliedCount} migration(s)`);
    }
  } finally {
    await closePool();
  }
}
