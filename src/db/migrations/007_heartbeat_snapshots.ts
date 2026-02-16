import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE events
    ADD COLUMN heartbeat_snapshots JSON NULL AFTER agent_log
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE events
    DROP COLUMN heartbeat_snapshots
  `);
}
