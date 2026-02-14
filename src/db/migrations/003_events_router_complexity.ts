import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE events
    ADD COLUMN router_complexity VARCHAR(10) NULL
    AFTER router_needs_agent
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query("ALTER TABLE events DROP COLUMN router_complexity");
}
