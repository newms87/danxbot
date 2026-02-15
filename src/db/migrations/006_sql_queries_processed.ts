import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE events
    ADD COLUMN sql_queries_processed INT NULL AFTER agent_retried
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE events
    DROP COLUMN sql_queries_processed
  `);
}
