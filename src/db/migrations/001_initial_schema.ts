import type { PoolClient } from "pg";

/**
 * Bootstrap migration — adds the `set_updated_at()` trigger function used
 * by every later table that wants `updated_at` to auto-bump on UPDATE,
 * plus the `health_check` table.
 *
 * MySQL had `TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
 * built in. Postgres has no equivalent column option, so each table that
 * wants the same behavior installs a BEFORE UPDATE trigger that calls
 * `set_updated_at()`.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS health_check (
      id SERIAL PRIMARY KEY,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query("DROP TABLE IF EXISTS health_check");
  await client.query("DROP FUNCTION IF EXISTS set_updated_at()");
}
