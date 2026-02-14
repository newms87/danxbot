import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id VARCHAR(255) PRIMARY KEY,
      thread_ts VARCHAR(50) NOT NULL,
      message_ts VARCHAR(50) NOT NULL,
      channel_id VARCHAR(50) NOT NULL,
      \`user\` VARCHAR(50) NOT NULL,
      user_name VARCHAR(255) NULL,
      \`text\` TEXT NOT NULL,
      received_at BIGINT NOT NULL,
      router_response_at BIGINT NULL,
      router_response TEXT NULL,
      router_needs_agent TINYINT(1) NULL,
      agent_response_at BIGINT NULL,
      agent_response MEDIUMTEXT NULL,
      agent_cost_usd DECIMAL(10,4) NULL,
      agent_turns INT NULL,
      \`status\` VARCHAR(20) NOT NULL DEFAULT 'received',
      \`error\` TEXT NULL,
      router_request JSON NULL,
      router_raw_response JSON NULL,
      agent_config JSON NULL,
      agent_log JSON NULL,
      agent_retried TINYINT(1) NOT NULL DEFAULT 0,
      feedback VARCHAR(10) NULL,
      response_ts VARCHAR(50) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_events_status (\`status\`),
      INDEX idx_events_channel_id (channel_id),
      INDEX idx_events_received_at (received_at),
      INDEX idx_events_feedback (feedback)
    )
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS events");
}
