import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS events");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatches (
      id VARCHAR(255) PRIMARY KEY,
      repo_name VARCHAR(255) NOT NULL,
      \`trigger\` VARCHAR(20) NOT NULL,
      trigger_metadata JSON NOT NULL,
      session_uuid VARCHAR(255) NULL,
      jsonl_path TEXT NULL,
      \`status\` VARCHAR(20) NOT NULL DEFAULT 'queued',
      started_at BIGINT NOT NULL,
      completed_at BIGINT NULL,
      summary MEDIUMTEXT NULL,
      \`error\` TEXT NULL,
      runtime_mode VARCHAR(10) NOT NULL,
      tokens_total BIGINT NOT NULL DEFAULT 0,
      tokens_in BIGINT NOT NULL DEFAULT 0,
      tokens_out BIGINT NOT NULL DEFAULT 0,
      cache_read BIGINT NOT NULL DEFAULT 0,
      cache_write BIGINT NOT NULL DEFAULT 0,
      tool_call_count INT NOT NULL DEFAULT 0,
      subagent_count INT NOT NULL DEFAULT 0,
      nudge_count INT NOT NULL DEFAULT 0,
      danxbot_commit VARCHAR(40) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_dispatches_status (\`status\`),
      INDEX idx_dispatches_trigger (\`trigger\`),
      INDEX idx_dispatches_repo (repo_name),
      INDEX idx_dispatches_started (started_at)
    )
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS dispatches");
}
