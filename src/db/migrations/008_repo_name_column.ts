import type { PoolClient } from "pg";

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE events
    ADD COLUMN repo_name VARCHAR(100) NOT NULL DEFAULT 'unknown'
  `);
}
