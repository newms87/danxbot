import type { PoolClient } from "pg";

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE events
    RENAME COLUMN agent_cost_usd TO subscription_cost_usd
  `);
  await client.query(`
    ALTER TABLE events
    ALTER COLUMN subscription_cost_usd TYPE NUMERIC(10,6)
  `);
  await client.query(`
    ALTER TABLE events
    ADD COLUMN api_calls JSONB NULL,
    ADD COLUMN api_cost_usd NUMERIC(10,6) NULL,
    ADD COLUMN agent_usage JSONB NULL
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE events
    DROP COLUMN api_calls,
    DROP COLUMN api_cost_usd,
    DROP COLUMN agent_usage
  `);
  await client.query(`
    ALTER TABLE events
    RENAME COLUMN subscription_cost_usd TO agent_cost_usd
  `);
}
