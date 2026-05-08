import type { PoolClient } from "pg";

/**
 * Audit table for `POST /api/restart/:dispatchId` (ISS-71).
 *
 * Every restart attempt — accepted, rejected by a guard, succeeded, or
 * timed out waiting for the new worker — writes a row here. The row is
 * the post-restart record because the original worker process is gone
 * by the time `completed_at` / `new_pid` / `duration_ms` are known, so
 * the HTTP caller cannot receive them in the response.
 *
 * Cooldown enforcement queries the latest `success` row per repo on
 * worker boot to seed the in-memory cooldown map — this survives a
 * restart-then-restart-again attempt that would otherwise bypass the
 * 30s window.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS worker_restarts (
      id SERIAL PRIMARY KEY,
      requesting_dispatch_id VARCHAR(255) NOT NULL,
      repo VARCHAR(255) NOT NULL,
      reason TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN (
        'started',
        'success',
        'cooldown',
        'cross_repo',
        'docker_self',
        'spawn_failed',
        'health_timeout'
      )),
      old_pid INT NULL,
      new_pid INT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NULL,
      duration_ms INT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_worker_restarts_repo_outcome
    ON worker_restarts (repo, outcome)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_worker_restarts_started
    ON worker_restarts (started_at)
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query("DROP TABLE IF EXISTS worker_restarts");
}
