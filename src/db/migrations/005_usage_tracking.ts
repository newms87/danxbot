import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE events
    CHANGE COLUMN agent_cost_usd subscription_cost_usd DECIMAL(10,6) NULL,
    ADD COLUMN api_calls JSON NULL AFTER agent_turns,
    ADD COLUMN api_cost_usd DECIMAL(10,6) NULL AFTER api_calls,
    ADD COLUMN agent_usage JSON NULL AFTER api_cost_usd
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE events
    CHANGE COLUMN subscription_cost_usd agent_cost_usd DECIMAL(10,6) NULL,
    DROP COLUMN api_calls,
    DROP COLUMN api_cost_usd,
    DROP COLUMN agent_usage
  `);
}
