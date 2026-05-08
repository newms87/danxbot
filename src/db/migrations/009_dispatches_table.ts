import type { PoolClient } from "pg";

export async function up(client: PoolClient): Promise<void> {
  await client.query("DROP TABLE IF EXISTS events");

  await client.query(`
    CREATE TABLE IF NOT EXISTS dispatches (
      id VARCHAR(255) PRIMARY KEY,
      repo_name VARCHAR(255) NOT NULL,
      "trigger" VARCHAR(20) NOT NULL,
      trigger_metadata JSONB NOT NULL,
      session_uuid VARCHAR(255) NULL,
      jsonl_path TEXT NULL,
      "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
      started_at BIGINT NOT NULL,
      completed_at BIGINT NULL,
      summary TEXT NULL,
      "error" TEXT NULL,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_dispatches_status ON dispatches ("status")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_dispatches_trigger ON dispatches ("trigger")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_dispatches_repo ON dispatches (repo_name)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_dispatches_started ON dispatches (started_at)`);
  await client.query(`
    CREATE TRIGGER trg_dispatches_updated_at
    BEFORE UPDATE ON dispatches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query("DROP TABLE IF EXISTS dispatches");
}
