import { getPool, query } from "../db/connection.js";
import { createLogger } from "../logger.js";
import {
  TERMINAL_STATUSES,
  type ApiTriggerMetadata,
  type Dispatch,
  type DispatchFilters,
  type DispatchStatus,
  type RuntimeMode,
  type SlackTriggerMetadata,
  type TrelloTriggerMetadata,
  type TriggerType,
} from "./dispatches.js";

const log = createLogger("dispatches-db");

const DEFAULT_LIST_LIMIT = 500;

/** Reserved SQL words in our `dispatches` schema that need PG quoting. */
const RESERVED_COLUMNS = new Set(["trigger", "status", "error"]);

function escapeColumn(raw: string): string {
  return RESERVED_COLUMNS.has(raw) ? `"${raw}"` : raw;
}

/** Ordered map: camelCase Dispatch field -> snake_case DB column. */
const COLUMN_MAP: Readonly<Record<keyof Dispatch, string>> = {
  id: "id",
  repoName: "repo_name",
  trigger: "trigger",
  triggerMetadata: "trigger_metadata",
  slackThreadTs: "slack_thread_ts",
  slackChannelId: "slack_channel_id",
  sessionUuid: "session_uuid",
  jsonlPath: "jsonl_path",
  parentJobId: "parent_job_id",
  issueId: "issue_id",
  status: "status",
  startedAt: "started_at",
  completedAt: "completed_at",
  summary: "summary",
  error: "error",
  runtimeMode: "runtime_mode",
  hostPid: "host_pid",
  hostPidAt: "host_pid_at",
  pidTerminatedAt: "pid_terminated_at",
  tokensTotal: "tokens_total",
  tokensIn: "tokens_in",
  tokensOut: "tokens_out",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
  toolCallCount: "tool_call_count",
  subagentCount: "subagent_count",
  nudgeCount: "nudge_count",
  danxbotCommit: "danxbot_commit",
  agentName: "agent_name",
};

const JSON_COLUMNS = new Set<keyof Dispatch>(["triggerMetadata"]);
const ORDERED_KEYS = Object.keys(COLUMN_MAP) as Array<keyof Dispatch>;

function toDbValue(key: keyof Dispatch, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (JSON_COLUMNS.has(key)) return JSON.stringify(value);
  return value;
}

export function dispatchToInsertParams(d: Dispatch): unknown[] {
  return ORDERED_KEYS.map((k) => toDbValue(k, d[k]));
}

export interface DispatchRow {
  id: string;
  repo_name: string;
  trigger: string;
  trigger_metadata: string | object;
  slack_thread_ts: string | null;
  slack_channel_id: string | null;
  session_uuid: string | null;
  jsonl_path: string | null;
  parent_job_id: string | null;
  issue_id: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
  summary: string | null;
  error: string | null;
  runtime_mode: string;
  host_pid: number | null;
  host_pid_at: number | null;
  pid_terminated_at: number | null;
  tokens_total: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  tool_call_count: number;
  subagent_count: number;
  nudge_count: number;
  danxbot_commit: string | null;
  agent_name: string | null;
}

function parseMetadata(
  raw: DispatchRow["trigger_metadata"],
): SlackTriggerMetadata | TrelloTriggerMetadata | ApiTriggerMetadata {
  if (typeof raw === "string") {
    return JSON.parse(raw);
  }
  return raw as unknown as
    | SlackTriggerMetadata
    | TrelloTriggerMetadata
    | ApiTriggerMetadata;
}

export function rowToDispatch(row: DispatchRow): Dispatch {
  return {
    id: row.id,
    repoName: row.repo_name,
    trigger: row.trigger as TriggerType,
    triggerMetadata: parseMetadata(row.trigger_metadata),
    slackThreadTs: row.slack_thread_ts,
    slackChannelId: row.slack_channel_id,
    sessionUuid: row.session_uuid,
    jsonlPath: row.jsonl_path,
    parentJobId: row.parent_job_id,
    issueId: row.issue_id,
    status: row.status as DispatchStatus,
    startedAt: Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    summary: row.summary,
    error: row.error,
    runtimeMode: row.runtime_mode as RuntimeMode,
    // Loose `==` on purpose: catches both DB `NULL` (driver returns
    // null) and missing-column / pre-migration test fixtures (undefined).
    // Do NOT "fix" to `===` — that would let `Number(undefined)` produce
    // NaN and silently corrupt every consumer of `hostPid`.
    hostPid: row.host_pid == null ? null : Number(row.host_pid),
    hostPidAt: row.host_pid_at == null ? null : Number(row.host_pid_at),
    pidTerminatedAt:
      row.pid_terminated_at == null ? null : Number(row.pid_terminated_at),
    tokensTotal: Number(row.tokens_total),
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
    toolCallCount: Number(row.tool_call_count),
    subagentCount: Number(row.subagent_count),
    nudgeCount: Number(row.nudge_count),
    danxbotCommit: row.danxbot_commit,
    // Loose `==` matches the surrounding pattern: tolerates pre-migration
    // test fixtures whose row shape predates DX-200 (column undefined) AND
    // production rows whose column is NULL.
    agentName: row.agent_name == null ? null : String(row.agent_name),
  };
}

const INSERT_COLUMNS = ORDERED_KEYS.map((k) =>
  escapeColumn(COLUMN_MAP[k]),
).join(", ");
const INSERT_PLACEHOLDERS = ORDERED_KEYS.map((_, i) => `$${i + 1}`).join(", ");
const INSERT_SQL = `INSERT INTO dispatches (${INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`;

export async function insertDispatch(d: Dispatch): Promise<void> {
  await query(INSERT_SQL, dispatchToInsertParams(d));
}

export async function updateDispatch(
  id: string,
  updates: Partial<Dispatch>,
): Promise<void> {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(updates) as Array<
    [keyof Dispatch, unknown]
  >) {
    const column = COLUMN_MAP[key];
    if (!column) continue;
    params.push(toDbValue(key, value));
    setClauses.push(`${escapeColumn(column)} = $${params.length}`);
  }

  if (setClauses.length === 0) return;

  params.push(id);
  await query(
    `UPDATE dispatches SET ${setClauses.join(", ")} WHERE id = $${params.length}`,
    params,
  );
}

export async function getDispatchById(id: string): Promise<Dispatch | null> {
  const rows = await query<DispatchRow>(
    "SELECT * FROM dispatches WHERE id = $1",
    [id],
  );
  if (rows.length === 0) return null;
  return rowToDispatch(rows[0]);
}

/**
 * Return the most recent successfully-completed dispatch for a Slack thread,
 * or `null` if no such row exists. Used by the Slack listener to decide
 * whether a follow-up message should resume the prior dispatch's Claude
 * session via `resumeSessionId`.
 */
export async function findLatestDispatchBySlackThread(
  threadTs: string,
): Promise<Dispatch | null> {
  const rows = await query<DispatchRow>(
    `SELECT * FROM dispatches
     WHERE slack_thread_ts = $1 AND "status" = 'completed'
     ORDER BY started_at DESC LIMIT 1`,
    [threadTs],
  );
  if (rows.length === 0) return null;
  return rowToDispatch(rows[0]);
}

export async function listDispatches(
  filters: DispatchFilters,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<Dispatch[]> {
  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (filters.trigger) {
    params.push(filters.trigger);
    whereClauses.push(`"trigger" = $${params.length}`);
  }
  if (filters.repo) {
    params.push(filters.repo);
    whereClauses.push(`repo_name = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    whereClauses.push(`"status" = $${params.length}`);
  }
  if (filters.since !== undefined) {
    params.push(filters.since);
    whereClauses.push(`started_at >= $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    whereClauses.push(`summary LIKE $${params.length}`);
  }

  const whereSql = whereClauses.length > 0
    ? ` WHERE ${whereClauses.join(" AND ")}`
    : "";

  params.push(limit);
  const sql = `SELECT * FROM dispatches${whereSql} ORDER BY started_at DESC LIMIT $${params.length}`;
  const rows = await query<DispatchRow>(sql, params);
  return rows.map(rowToDispatch);
}

const TERMINAL_LIST = TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");

export interface DeletedDispatch {
  id: string;
  jsonlPath: string | null;
}

export interface DispatchCountsByTrigger {
  total: number;
  slack: number;
  trello: number;
  api: number;
}

export interface RepoDispatchCounts {
  total: DispatchCountsByTrigger;
  last24h: DispatchCountsByTrigger;
  today: DispatchCountsByTrigger;
}

/**
 * Count dispatches per repo, broken out by trigger type across three time
 * windows (all time / last 24h / since midnight UTC today).
 */
export async function countDispatchesByRepo(): Promise<
  Record<string, RepoDispatchCounts>
> {
  const now = Date.now();
  const cutoff24h = now - 86_400_000;
  const midnightToday = new Date();
  midnightToday.setUTCHours(0, 0, 0, 0);
  const cutoffToday = midnightToday.getTime();

  const rows = await query<{
    repo_name: string;
    trigger: string;
    total: number | string;
    last_24h: number | string;
    today: number | string;
  }>(
    `SELECT
      repo_name,
      "trigger",
      COUNT(*) AS total,
      SUM(CASE WHEN started_at >= $1 THEN 1 ELSE 0 END) AS last_24h,
      SUM(CASE WHEN started_at >= $2 THEN 1 ELSE 0 END) AS today
    FROM dispatches
    GROUP BY repo_name, "trigger"`,
    [cutoff24h, cutoffToday],
  );

  const out: Record<string, RepoDispatchCounts> = {};
  for (const r of rows) {
    const entry =
      out[r.repo_name] ??
      (out[r.repo_name] = {
        total: { total: 0, slack: 0, trello: 0, api: 0 },
        last24h: { total: 0, slack: 0, trello: 0, api: 0 },
        today: { total: 0, slack: 0, trello: 0, api: 0 },
      });
    const total = Number(r.total);
    const last24h = Number(r.last_24h);
    const today = Number(r.today);
    const trigger = r.trigger as TriggerType;
    entry.total.total += total;
    entry.last24h.total += last24h;
    entry.today.total += today;
    if (trigger === "slack" || trigger === "trello" || trigger === "api") {
      entry.total[trigger] += total;
      entry.last24h[trigger] += last24h;
      entry.today[trigger] += today;
    }
  }
  return out;
}

/**
 * DX-84 — chat session listing helpers. The Agent Chat tab queries these
 * to populate the per-issue dispatch list (chat tab inside the drawer)
 * and the per-board chat session list (`workspace = "board-chat"` filter
 * on api dispatches).
 *
 * Both helpers return rows newest-first so the chat shell can default to
 * the most-recent session without sorting client-side.
 */

/**
 * List every dispatch ever launched for the given local issue id
 * (`<PREFIX>-N`). Sorted by `started_at DESC` so the chat shell defaults
 * to the most-recent dispatch — that's the one the Resume button hits.
 *
 * Returns rows from every trigger type. In practice the poller-driven
 * trello rows dominate here, but a future external dispatcher that
 * stamps `issue_id` would also appear in the list.
 */
export async function listDispatchesByIssueId(
  issueId: string,
): Promise<Dispatch[]> {
  const rows = await query<DispatchRow>(
    `SELECT * FROM dispatches
     WHERE issue_id = $1
     ORDER BY started_at DESC`,
    [issueId],
  );
  return rows.map(rowToDispatch);
}

/**
 * List every board-chat dispatch for the given repo. Filter is on
 * `triggerMetadata->>'workspace' = 'board-chat'` — workspace is a JSONB
 * key (no dedicated column). Newest-first.
 *
 * Limited to the dashboard's chat session picker; not a hot path. The
 * JSONB lookup uses the existing per-trigger indexes plus a hash index
 * is not added here — at chat-list scale (one repo, dozens of rows) the
 * scan is cheap.
 */
export async function listBoardChatDispatches(
  repoName: string,
): Promise<Dispatch[]> {
  const rows = await query<DispatchRow>(
    `SELECT * FROM dispatches
     WHERE repo_name = $1
       AND "trigger" = 'api'
       AND trigger_metadata->>'workspace' = 'board-chat'
     ORDER BY started_at DESC`,
    [repoName],
  );
  return rows.map(rowToDispatch);
}

/**
 * Walk a dispatch's resume chain root-first via `parent_job_id`.
 * Returns the chain ordered oldest-first (the original launch is index 0,
 * the youngest resume is the last entry). Used by the chat timeline
 * endpoint to merge JSONL blocks across the conversation history.
 *
 * Single SQL recursive CTE — no per-step round trip. Cycle protection
 * via a depth limit (32) so a malformed `parent_job_id` loop can't
 * spin the query forever.
 */
export async function getResumeChain(
  jobId: string,
): Promise<Dispatch[]> {
  const rows = await query<DispatchRow & { depth: number }>(
    `WITH RECURSIVE chain AS (
        SELECT *, 0 AS depth
          FROM dispatches
         WHERE id = $1
        UNION ALL
        SELECT d.*, c.depth + 1
          FROM dispatches d
          JOIN chain c ON d.id = c.parent_job_id
         WHERE c.depth < 32
     )
     SELECT * FROM chain ORDER BY depth DESC`,
    [jobId],
  );
  return rows.map((r) => rowToDispatch(r));
}

/**
 * Return every non-terminal dispatch row for `repoName` — `queued` and
 * `running`. Sorted oldest-first.
 */
export async function findNonTerminalDispatches(
  repoName: string,
): Promise<Dispatch[]> {
  const rows = await query<DispatchRow>(
    `SELECT * FROM dispatches
     WHERE repo_name = $1 AND "status" IN ('queued', 'running')
     ORDER BY started_at ASC`,
    [repoName],
  );
  return rows.map(rowToDispatch);
}

/**
 * Per-agent live busy state used by the Agents-tab roster (DX-164 Phase 6).
 *
 * `card_id` is the dispatch's `issue_id` when present, else `null` for
 * non-issue dispatch types (slack / api). `started_at` is the dispatch's
 * `started_at` epoch ms — the SPA renders elapsed time off this value
 * client-side so the card animates without a per-second poll.
 */
export interface AgentBusyOn {
  card_id: string | null;
  started_at: number;
  dispatch_id: string;
}

/**
 * Return per-agent busy state for `repoName`. Maps `agent_name` →
 * `{card_id, started_at, dispatch_id}` for every non-terminal dispatch
 * with an `agent_name` set. When an agent has multiple in-flight
 * dispatches (rare — the lock invariant is one-per-agent, but a stale
 * legacy row could violate it), the OLDEST wins so the card shows the
 * dispatch the operator most needs to attend to. Pre-Phase-5 dispatches
 * with `agent_name = NULL` are excluded.
 */
export async function agentBusyOn(
  repoName: string,
): Promise<Map<string, AgentBusyOn>> {
  const rows = await query<{
    agent_name: string;
    issue_id: string | null;
    started_at: number | string;
    id: string;
  }>(
    // `TERMINAL_LIST` is built from `TERMINAL_STATUSES` (the canonical
    // terminal-status const) so adding a new terminal status anywhere
    // — e.g. `"timeout"` — flows through this query automatically.
    // Inlining the literal list once would have silently shown ghost-
    // busy agents for every dispatch that landed in the new terminal.
    `SELECT agent_name, issue_id, started_at, id FROM dispatches
       WHERE repo_name = $1
         AND agent_name IS NOT NULL
         AND "status" NOT IN (${TERMINAL_LIST})
       ORDER BY started_at ASC`,
    [repoName],
  );
  const out = new Map<string, AgentBusyOn>();
  for (const r of rows) {
    if (typeof r.agent_name !== "string" || r.agent_name.length === 0) continue;
    if (out.has(r.agent_name)) continue; // oldest wins
    out.set(r.agent_name, {
      card_id: r.issue_id ?? null,
      started_at: Number(r.started_at),
      dispatch_id: r.id,
    });
  }
  return out;
}

export async function deleteOldDispatches(
  maxAgeMs: number,
): Promise<DeletedDispatch[]> {
  const cutoff = Date.now() - maxAgeMs;
  const pool = getPool();

  const sel = await pool.query<{ id: string; jsonl_path: string | null }>(
    `SELECT id, jsonl_path FROM dispatches WHERE started_at < $1 AND "status" IN (${TERMINAL_LIST})`,
    [cutoff],
  );
  const dbRows = sel.rows;

  if (dbRows.length === 0) return [];

  const del = await pool.query(
    `DELETE FROM dispatches WHERE started_at < $1 AND "status" IN (${TERMINAL_LIST})`,
    [cutoff],
  );
  const affected = del.rowCount ?? 0;
  log.info(`Deleted ${affected} old dispatch row(s)`);

  return dbRows.map((r) => ({ id: r.id, jsonlPath: r.jsonl_path }));
}
