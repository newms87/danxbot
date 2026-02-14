import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_ts VARCHAR(50) PRIMARY KEY,
      channel_id VARCHAR(50) NOT NULL,
      session_id VARCHAR(255) NULL,
      messages JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_threads_updated_at (updated_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      slack_user_id VARCHAR(50) PRIMARY KEY,
      display_name VARCHAR(255) NULL,
      preferences JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS threads");
  await pool.query("DROP TABLE IF EXISTS users");
}
