import type { Pool } from "mysql2/promise";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE users
      DROP PRIMARY KEY,
      ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST,
      MODIFY slack_user_id VARCHAR(50) NULL,
      ADD UNIQUE KEY uq_users_slack_user_id (slack_user_id),
      ADD COLUMN username VARCHAR(64) NULL AFTER id,
      ADD UNIQUE KEY uq_users_username (username),
      ADD COLUMN password_hash VARCHAR(255) NULL AFTER username
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP NULL,
      revoked_at TIMESTAMP NULL,
      INDEX idx_api_tokens_user_revoked (user_id, revoked_at),
      CONSTRAINT fk_api_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS api_tokens");
  await pool.query(`
    ALTER TABLE users
      DROP COLUMN password_hash,
      DROP INDEX uq_users_username,
      DROP COLUMN username,
      DROP INDEX uq_users_slack_user_id,
      MODIFY slack_user_id VARCHAR(50) NOT NULL,
      DROP PRIMARY KEY,
      DROP COLUMN id,
      ADD PRIMARY KEY (slack_user_id)
  `);
}
