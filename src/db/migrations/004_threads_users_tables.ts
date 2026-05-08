import type { PoolClient } from "pg";

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_ts VARCHAR(50) PRIMARY KEY,
      channel_id VARCHAR(50) NOT NULL,
      session_id VARCHAR(255) NULL,
      messages JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads (updated_at)`);
  await client.query(`
    CREATE TRIGGER trg_threads_updated_at
    BEFORE UPDATE ON threads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      slack_user_id VARCHAR(50) PRIMARY KEY,
      display_name VARCHAR(255) NULL,
      preferences JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query("DROP TABLE IF EXISTS threads");
  await client.query("DROP TABLE IF EXISTS users");
}
