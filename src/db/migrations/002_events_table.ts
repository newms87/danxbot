import type { PoolClient } from "pg";

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS events (
      id VARCHAR(255) PRIMARY KEY,
      thread_ts VARCHAR(50) NOT NULL,
      message_ts VARCHAR(50) NOT NULL,
      channel_id VARCHAR(50) NOT NULL,
      "user" VARCHAR(50) NOT NULL,
      user_name VARCHAR(255) NULL,
      "text" TEXT NOT NULL,
      received_at BIGINT NOT NULL,
      router_response_at BIGINT NULL,
      router_response TEXT NULL,
      router_needs_agent BOOLEAN NULL,
      agent_response_at BIGINT NULL,
      agent_response TEXT NULL,
      agent_cost_usd NUMERIC(10,4) NULL,
      agent_turns INT NULL,
      "status" VARCHAR(20) NOT NULL DEFAULT 'received',
      "error" TEXT NULL,
      router_request JSONB NULL,
      router_raw_response JSONB NULL,
      agent_config JSONB NULL,
      agent_log JSONB NULL,
      agent_retried BOOLEAN NOT NULL DEFAULT FALSE,
      feedback VARCHAR(10) NULL,
      response_ts VARCHAR(50) NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_events_status ON events ("status")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_events_channel_id ON events (channel_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_events_received_at ON events (received_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_events_feedback ON events (feedback)`);
  await client.query(`
    CREATE TRIGGER trg_events_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query("DROP TABLE IF EXISTS events");
}
