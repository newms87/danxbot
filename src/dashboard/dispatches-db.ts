import type { ResultSetHeader } from "mysql2/promise";
import { getPool } from "../db/connection.js";
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

/** Reserved SQL words in our `dispatches` schema that need backtick escaping. */
const RESERVED_COLUMNS = new Set(["trigger", "status", "error"]);

function escapeColumn(raw: string): string {
  return RESERVED_COLUMNS.has(raw) ? `\`${raw}\`` : raw;
}

/** Ordered map: camelCase Dispatch field -> snake_case DB column. */
const COLUMN_MAP: Readonly<Record<keyof Dispatch, string>> = {
  id: "id",
  repoName: "repo_name",
  trigger: "trigger",
  triggerMetadata: "trigger_metadata",
  sessionUuid: "session_uuid",
  jsonlPath: "jsonl_path",
  status: "status",
  startedAt: "started_at",
  completedAt: "completed_at",
  summary: "summary",
  error: "error",
  runtimeMode: "runtime_mode",
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
  session_uuid: string | null;
  jsonl_path: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
  summary: string | null;
  error: string | null;
  runtime_mode: string;
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
    sessionUuid: row.session_uuid,
    jsonlPath: row.jsonl_path,
    status: row.status as DispatchStatus,
    startedAt: Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    summary: row.summary,
    error: row.error,
    runtimeMode: row.runtime_mode as RuntimeMode,
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
const INSERT_PLACEHOLDERS = ORDERED_KEYS.map(() => "?").join(", ");
const INSERT_SQL = `INSERT INTO dispatches (${INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`;

export async function insertDispatch(d: Dispatch): Promise<void> {
  const pool = getPool();
  await pool.execute(INSERT_SQL, dispatchToInsertParams(d));
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
    setClauses.push(`${escapeColumn(column)} = ?`);
    params.push(toDbValue(key, value));
  }

  if (setClauses.length === 0) return;

  params.push(id);
  const pool = getPool();
  await pool.execute(
    `UPDATE dispatches SET ${setClauses.join(", ")} WHERE id = ?`,
    params,
  );
}

export async function getDispatchById(id: string): Promise<Dispatch | null> {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM dispatches WHERE id = ?",
    [id],
  );
  const dbRows = rows as DispatchRow[];
  if (dbRows.length === 0) return null;
  return rowToDispatch(dbRows[0]);
}

export async function listDispatches(
  filters: DispatchFilters,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<Dispatch[]> {
  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (filters.trigger) {
    whereClauses.push("`trigger` = ?");
    params.push(filters.trigger);
  }
  if (filters.repo) {
    whereClauses.push("repo_name = ?");
    params.push(filters.repo);
  }
  if (filters.status) {
    whereClauses.push("`status` = ?");
    params.push(filters.status);
  }
  if (filters.since !== undefined) {
    whereClauses.push("started_at >= ?");
    params.push(filters.since);
  }
  if (filters.q) {
    whereClauses.push("summary LIKE ?");
    params.push(`%${filters.q}%`);
  }

  const whereSql = whereClauses.length > 0
    ? ` WHERE ${whereClauses.join(" AND ")}`
    : "";

  params.push(limit);

  const sql = `SELECT * FROM dispatches${whereSql} ORDER BY started_at DESC LIMIT ?`;
  const pool = getPool();
  const [rows] = await pool.query(sql, params);
  return (rows as DispatchRow[]).map(rowToDispatch);
}

const TERMINAL_LIST = TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");

export interface DeletedDispatch {
  id: string;
  jsonlPath: string | null;
}

/**
 * Delete dispatches older than `maxAgeMs` that are in a terminal state.
 * Returns the deleted rows' ids + jsonl paths so the caller can unlink
 * the corresponding JSONL files. Non-terminal dispatches (queued, running)
 * are preserved regardless of age.
 */
export async function deleteOldDispatches(
  maxAgeMs: number,
): Promise<DeletedDispatch[]> {
  const cutoff = Date.now() - maxAgeMs;
  const pool = getPool();

  const [rows] = await pool.query(
    `SELECT id, jsonl_path FROM dispatches WHERE started_at < ? AND \`status\` IN (${TERMINAL_LIST})`,
    [cutoff],
  );
  const dbRows = rows as Array<{ id: string; jsonl_path: string | null }>;

  if (dbRows.length === 0) return [];

  const [result] = await pool.execute(
    `DELETE FROM dispatches WHERE started_at < ? AND \`status\` IN (${TERMINAL_LIST})`,
    [cutoff],
  );
  const affected = (result as ResultSetHeader).affectedRows;
  log.info(`Deleted ${affected} old dispatch row(s)`);

  return dbRows.map((r) => ({ id: r.id, jsonlPath: r.jsonl_path }));
}
