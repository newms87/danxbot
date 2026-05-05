import type { Pool } from "mysql2/promise";

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
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_restarts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      requesting_dispatch_id VARCHAR(255) NOT NULL,
      repo VARCHAR(255) NOT NULL,
      reason TEXT NOT NULL,
      outcome ENUM(
        'started',
        'success',
        'cooldown',
        'cross_repo',
        'docker_self',
        'spawn_failed',
        'health_timeout'
      ) NOT NULL,
      old_pid INT NULL,
      new_pid INT NULL,
      started_at DATETIME NOT NULL,
      completed_at DATETIME NULL,
      duration_ms INT NULL,
      INDEX idx_worker_restarts_repo_outcome (repo, outcome),
      INDEX idx_worker_restarts_started (started_at)
    )
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS worker_restarts");
}
