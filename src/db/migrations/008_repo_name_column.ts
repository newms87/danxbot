import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE events
    ADD COLUMN repo_name VARCHAR(100) NOT NULL DEFAULT 'unknown'
    AFTER id
  `);
}
