import type { PoolClient } from "pg";

/**
 * DX-200 (Phase 5 of multi-worker dispatch epic DX-158): add `agent_name` so
 * the poller's lock query (`busyAgents`) can read which agents currently
 * own a non-terminal dispatch directly off the index instead of walking
 * issue YAMLs.
 *
 * The poller-side `busyAgents(repo)` lookup runs once per pick step and is
 * the hot path for the Phase 5 multi-agent picker. The partial index keeps
 * it O(busy-agents) regardless of historical row count — terminal rows are
 * skipped at the index level. `(repo_name, agent_name) WHERE status NOT IN
 * ('completed','failed','cancelled')` matches the predicate in the lock
 * query verbatim so the planner can use it without a heap probe.
 *
 * `agent_name` is NULLable because every existing dispatch (and every
 * future Slack / ideator / external `/api/launch` dispatch) is
 * agent-agnostic. Only the issue-worker poller path, after picking a free
 * agent, stamps a value; everything else leaves it NULL.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE dispatches
    ADD COLUMN agent_name VARCHAR(64) NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_agent_name_active
      ON dispatches (repo_name, agent_name)
      WHERE agent_name IS NOT NULL
        AND "status" NOT IN ('completed', 'failed', 'cancelled')
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_dispatches_agent_name_active`);
  await client.query(`ALTER TABLE dispatches DROP COLUMN agent_name`);
}
