/**
 * DB-backed lock queries for the multi-worker pick algorithm
 * (DX-200 / DX-158 epic Phase 5).
 *
 * Two lookups, both keyed off the per-repo `dispatches` and `issues` rows
 * the chokidar mirror keeps in sync with the local YAMLs:
 *
 *   - `busyAgents(repo)` — names of every agent currently holding an
 *     in-flight dispatch slot on this repo. The poller's pick step
 *     subtracts this from the configured roster to find FREE agents.
 *     A dispatch is "in-flight" while its `status` is non-terminal
 *     (`queued` / `running` / `pending`) — the dispatches table's
 *     terminal set is `('completed','failed','cancelled')`. Migration
 *     018 adds the matching partial index so the lookup hits an index
 *     even on a long-lived dispatches table.
 *
 *   - `assignedCards(repo)` — every open issue that has stamped an
 *     `assigned_agent` claim, returned as a `Map<id, agentName>`. The
 *     pick step uses this to allow an agent to RE-CLAIM the same card
 *     across ticks (e.g. orphan-resume after a crash, or a single
 *     mid-flight dispatch that finishes and bounces back to ToDo).
 *     Generated column `issues.assigned_agent` (migration 016) backs
 *     this query.
 *
 * Why query the DB instead of walking YAMLs:
 *   - The poller already runs once per repo per tick; both lookups land
 *     on indexed columns and complete in <1ms even with hundreds of
 *     dispatches and thousands of cards.
 *   - The chokidar mirror is the single source of truth for "what does
 *     the YAML say right now" — every reader downstream of DX-155 reads
 *     through the DB. Adding a YAML walk here would re-introduce the
 *     pre-DX-155 split-source-of-truth bug.
 *
 * Why this module is `src/agent/agent-locks.ts` instead of
 * `src/poller/agent-locks.ts`: the helpers also surface useful for the
 * dashboard's per-repo agent panel + future agent-CRUD endpoints (which
 * need to know "is this agent currently busy?" before the operator can
 * delete it). Keeping them in `src/agent/` lets non-poller callers
 * import without taking a dep on the poller's heavy env-loading config
 * chain.
 */

import { query as defaultQuery } from "../db/connection.js";

type QueryFn = <T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

let queryFn: QueryFn = defaultQuery;

/**
 * Test hook — swap the underlying query function. Production never
 * touches this; integration tests bind to a `createTestDb()` pool, unit
 * tests typically use `vi.mock("../db/connection.js")` instead.
 */
export function setAgentLocksQueryFn(fn: QueryFn): void {
  queryFn = fn;
}

export function resetAgentLocksQueryFn(): void {
  queryFn = defaultQuery;
}

/**
 * Names of every agent currently holding a non-terminal dispatch on the
 * repo. The pick step does `roster.filter(a => !busy.has(a.name))` to
 * find candidates.
 *
 * Returns an empty Set when no agent is busy — never null. The
 * underlying query reads through the partial index added by migration
 * 018 (`idx_dispatches_agent_name_active`) so the lookup is O(busy)
 * regardless of historical row count. Pre-Phase-5 dispatches whose
 * `agent_name` is NULL are excluded by the index predicate, so a repo
 * that has never used the multi-agent picker returns an empty set even
 * with thousands of legacy rows.
 */
export async function busyAgents(repoName: string): Promise<Set<string>> {
  // Active = NOT terminal. Terminal set must include every DispatchStatus
  // that signals "agent process is gone" — completed, failed, cancelled,
  // timeout, recovered (DX-246 stream-idle auto-recover collapses to this),
  // critical_failure, api_error_failed. Omitting any one (e.g. the
  // pre-DX-246 list of only completed/failed/cancelled) leaves stale rows
  // marking the agent busy forever → picker sees roster as fully busy →
  // silent zero-dispatch loop with cards available.
  const rows = await queryFn<{ agent_name: string }>(
    `SELECT DISTINCT agent_name FROM dispatches
       WHERE repo_name = $1
         AND agent_name IS NOT NULL
         AND "status" NOT IN (
           'completed', 'failed', 'cancelled', 'timeout',
           'recovered', 'critical_failure', 'api_error_failed'
         )`,
    [repoName],
  );
  const out = new Set<string>();
  for (const r of rows) {
    if (typeof r.agent_name === "string" && r.agent_name.length > 0) {
      out.add(r.agent_name);
    }
  }
  return out;
}

/**
 * Set of `<PREFIX>-N` issue IDs that have at least one non-terminal
 * dispatch row right now. This is the LIVENESS truth — distinct from
 * the YAML's `status: "In Progress"` field which goes stale whenever a
 * dispatch dies outside the orderly completion path (worker OOM,
 * operator DB cancel, claude-auth failure, broken-worktree sync
 * abort, etc.).
 *
 * The picker uses this to compute the conflict-check `inProgress`
 * input — without it, orphan YAMLs whose status never got cleared back
 * to ToDo trigger a $0.01-per-tick conflict-check triage forever
 * (DX-262 root cause once the worktree side was fixed).
 *
 * `pid_terminated_at IS NULL` excludes rows the worker recovery path
 * marked terminated-but-not-yet-finalized; those are effectively dead.
 */
export async function liveDispatchIssueIds(
  repoName: string,
): Promise<Set<string>> {
  const rows = await queryFn<{ issue_id: string }>(
    `SELECT DISTINCT issue_id FROM dispatches
       WHERE repo_name = $1
         AND issue_id IS NOT NULL
         AND "status" NOT IN (
           'completed', 'failed', 'cancelled', 'timeout',
           'recovered', 'critical_failure', 'api_error_failed'
         )
         AND pid_terminated_at IS NULL`,
    [repoName],
  );
  const out = new Set<string>();
  for (const r of rows) {
    if (typeof r.issue_id === "string" && r.issue_id.length > 0) {
      out.add(r.issue_id);
    }
  }
  return out;
}

/**
 * Map of `<PREFIX>-N` → agent name for every open issue that has
 * stamped an `assigned_agent` claim. The pick step consults this map
 * when filtering candidate cards — a card claimed by another agent is
 * skipped even if it shows up in the dispatchable list.
 *
 * "Open" matches the same `status NOT IN ('Done','Cancelled')`
 * predicate the poller's `dbListOpenIssues` uses, so a Done card whose
 * mirror happens to still carry an `assigned_agent` value (race window
 * between status flip and column refresh) cannot leak into the map.
 */
export async function assignedCards(
  repoName: string,
): Promise<Map<string, string>> {
  const rows = await queryFn<{ id: string; assigned_agent: string }>(
    `SELECT id, assigned_agent FROM issues
       WHERE repo_name = $1
         AND assigned_agent IS NOT NULL
         AND "status" NOT IN ('Done', 'Cancelled')`,
    [repoName],
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (
      typeof r.id === "string" &&
      r.id.length > 0 &&
      typeof r.assigned_agent === "string" &&
      r.assigned_agent.length > 0
    ) {
      out.set(r.id, r.assigned_agent);
    }
  }
  return out;
}
