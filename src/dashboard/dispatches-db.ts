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
