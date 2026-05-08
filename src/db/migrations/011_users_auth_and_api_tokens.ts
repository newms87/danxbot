import type { PoolClient } from "pg";

/**
 * Augments `users` with auth columns + creates `api_tokens`.
 *
 * Postgres equivalent of the original MySQL migration:
 *   - `users.id` becomes a `BIGSERIAL` surrogate primary key (was
 *     `slack_user_id`).
 *   - `slack_user_id` keeps the unique-but-nullable constraint so
 *     password-only users can exist without a Slack identity.
 *   - `username` + `password_hash` added (nullable; password auth is
 *     opt-in).
 *   - `api_tokens` mirrors the MySQL definition with `bigserial` ids
 *     and the same FK to `users(id)`.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE users DROP CONSTRAINT users_pkey`);
  await client.query(`ALTER TABLE users ADD COLUMN id BIGSERIAL PRIMARY KEY`);
  await client.query(`ALTER TABLE users ALTER COLUMN slack_user_id DROP NOT NULL`);
  await client.query(`
    ALTER TABLE users
    ADD CONSTRAINT uq_users_slack_user_id UNIQUE (slack_user_id)
  `);
  await client.query(`ALTER TABLE users ADD COLUMN username VARCHAR(64) NULL`);
  await client.query(`
    ALTER TABLE users
    ADD CONSTRAINT uq_users_username UNIQUE (username)
  `);
  await client.query(`ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NULL,
      revoked_at TIMESTAMPTZ NULL,
      CONSTRAINT fk_api_tokens_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_revoked
    ON api_tokens (user_id, revoked_at)
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS api_tokens`);
  await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS password_hash`);
  await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_username`);
  await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS username`);
  await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_slack_user_id`);
  await client.query(`ALTER TABLE users ALTER COLUMN slack_user_id SET NOT NULL`);
  await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pkey`);
  await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS id`);
  await client.query(`ALTER TABLE users ADD PRIMARY KEY (slack_user_id)`);
}
