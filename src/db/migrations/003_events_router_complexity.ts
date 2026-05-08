import type { PoolClient } from "pg";

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE events
    ADD COLUMN router_complexity VARCHAR(10) NULL
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query("ALTER TABLE events DROP COLUMN router_complexity");
}
