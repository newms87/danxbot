import type { PoolClient } from "pg";

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE events
    ADD COLUMN sql_queries_processed INT NULL
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE events DROP COLUMN sql_queries_processed`);
}
