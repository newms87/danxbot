import type { PoolClient } from "pg";

/**
 * DX-207 (Phase 2a of DB-driven full-stack reattach epic DX-141): add
 * `mcp_settings_path` so the reattach pass in Phase 2c can resolve each
 * non-terminal dispatch's per-dispatch MCP settings file
 * (`/tmp/danxbot-mcp-XXXX/settings.json`) from the row alone — no
 * cross-session ferrying required. The path is written by
 * `writeMcpSettingsFile` in `src/dispatch/core.ts` at spawn time and
 * embeds `DANXBOT_STOP_URL = http://localhost:<old_port>/api/stop/<id>`.
 * After a worker restart on a different port, Phase 2c rewrites the
 * file with the current worker's URL on the spot — without this column,
 * the path lives only in the spawning worker's memory and is lost.
 *
 * `mcp_settings_path` is NULLable — pre-migration rows have no value and
 * legacy / no-MCP test paths legitimately omit it. Phase 2c falls
 * through to mark-failed for any non-terminal row whose column is
 * NULL (no path → cannot rewrite the URL → cannot prove the agent's
 * `danxbot_complete` callback will reach the new worker).
 *
 * Idempotent on both directions via `IF NOT EXISTS` / `IF EXISTS`. The
 * runner's `schema_migrations` table already prevents normal re-applies,
 * but a partial-apply replay (DDL committed before the migrations row
 * insert succeeded) lands here without erroring.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE dispatches
    ADD COLUMN IF NOT EXISTS mcp_settings_path VARCHAR(512) NULL
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE dispatches
    DROP COLUMN IF EXISTS mcp_settings_path
  `);
}
