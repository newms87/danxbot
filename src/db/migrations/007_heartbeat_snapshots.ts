import type { PoolClient } from "pg";

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE events
    ADD COLUMN heartbeat_snapshots JSONB NULL
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE events DROP COLUMN heartbeat_snapshots`);
}
