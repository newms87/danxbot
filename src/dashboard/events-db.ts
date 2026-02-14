import { getPool } from "../db/connection.js";
import { createLogger } from "../logger.js";
import type { MessageEvent } from "./events.js";
import type { AgentLogEntry } from "../types.js";

const log = createLogger("events-db");

/** Map from camelCase MessageEvent key to raw snake_case DB column name */
export const COLUMN_MAP: Record<string, string> = {
  id: "id",
  threadTs: "thread_ts",
  messageTs: "message_ts",
  channelId: "channel_id",
  user: "user",
  userName: "user_name",
  text: "text",
  receivedAt: "received_at",
  routerResponseAt: "router_response_at",
  routerResponse: "router_response",
  routerNeedsAgent: "router_needs_agent",
  routerComplexity: "router_complexity",
  agentResponseAt: "agent_response_at",
  agentResponse: "agent_response",
  agentCostUsd: "agent_cost_usd",
  agentTurns: "agent_turns",
  status: "status",
  error: "error",
  routerRequest: "router_request",
  routerRawResponse: "router_raw_response",
  agentConfig: "agent_config",
  agentLog: "agent_log",
  agentRetried: "agent_retried",
  feedback: "feedback",
  responseTs: "response_ts",
};

/** JSON-typed columns that need JSON.stringify for DB and JSON.parse on read */
const JSON_COLUMNS = new Set(["routerRequest", "routerRawResponse", "agentConfig", "agentLog"]);

/** Boolean columns stored as TINYINT(1) */
const BOOL_COLUMNS = new Set(["routerNeedsAgent", "agentRetried"]);

/** Reserved SQL words that need backtick escaping */
const RESERVED_COLUMNS = new Set(["user", "text", "status", "error"]);

/** Escape a raw column name with backticks if it is a reserved word */
function escapeColumn(raw: string): string {
  return RESERVED_COLUMNS.has(raw) ? `\`${raw}\`` : raw;
}

function toDbValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (JSON_COLUMNS.has(key)) return JSON.stringify(value);
  if (BOOL_COLUMNS.has(key)) return value ? 1 : 0;
  return value;
}

/** Derive ordered column keys, escaped column names, and placeholder string from COLUMN_MAP */
const ORDERED_KEYS = Object.keys(COLUMN_MAP);
const INSERT_COLUMNS = ORDERED_KEYS.map((k) => escapeColumn(COLUMN_MAP[k])).join(", ");
const INSERT_PLACEHOLDERS = ORDERED_KEYS.map(() => "?").join(", ");

export function eventToRow(event: MessageEvent): unknown[] {
  return ORDERED_KEYS.map((key) => toDbValue(key, event[key as keyof MessageEvent]));
}

export interface EventRow {
  id: string;
  thread_ts: string;
  message_ts: string;
  channel_id: string;
  user: string;
  user_name: string | null;
  text: string;
  received_at: number;
  router_response_at: number | null;
  router_response: string | null;
  router_needs_agent: number | null;
  router_complexity: string | null;
  agent_response_at: number | null;
  agent_response: string | null;
  agent_cost_usd: string | number | null;
  agent_turns: number | null;
  status: string;
  error: string | null;
  router_request: string | null;
  router_raw_response: string | null;
  agent_config: string | null;
  agent_log: string | null;
  agent_retried: number;
  feedback: string | null;
  response_ts: string | null;
}

function parseJson(value: string | null, columnName: string): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    log.warn(`Failed to parse JSON in column ${columnName}`, error as Error);
    return null;
  }
}

export function rowToEvent(row: EventRow): MessageEvent {
  return {
    id: row.id,
    threadTs: row.thread_ts,
    messageTs: row.message_ts,
    channelId: row.channel_id,
    user: row.user,
    userName: row.user_name,
    text: row.text,
    receivedAt: row.received_at,
    routerResponseAt: row.router_response_at,
    routerResponse: row.router_response,
    routerNeedsAgent: row.router_needs_agent === null ? null : row.router_needs_agent === 1,
    routerComplexity: row.router_complexity as MessageEvent["routerComplexity"],
    agentResponseAt: row.agent_response_at,
    agentResponse: row.agent_response,
    agentCostUsd: row.agent_cost_usd === null ? null : Number(row.agent_cost_usd),
    agentTurns: row.agent_turns,
    status: row.status as MessageEvent["status"],
    error: row.error,
    routerRequest: parseJson(row.router_request, "router_request"),
    routerRawResponse: parseJson(row.router_raw_response, "router_raw_response"),
    agentConfig: parseJson(row.agent_config, "agent_config"),
    agentLog: parseJson(row.agent_log, "agent_log") as AgentLogEntry[] | null,
    agentRetried: row.agent_retried === 1,
    feedback: row.feedback as MessageEvent["feedback"],
    responseTs: row.response_ts,
  };
}

export async function persistEventToDb(event: MessageEvent): Promise<void> {
  try {
    const pool = getPool();
    const params = eventToRow(event);
    await pool.execute(
      `INSERT INTO events (${INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`,
      params,
    );
  } catch (error) {
    log.error("Failed to persist event to DB", error);
  }
}

export async function updateEventInDb(id: string, updates: Partial<MessageEvent>): Promise<void> {
  try {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      const column = COLUMN_MAP[key];
      if (!column) continue;
      setClauses.push(`${escapeColumn(column)} = ?`);
      params.push(toDbValue(key, value));
    }

    if (setClauses.length === 0) return;

    params.push(id);
    const pool = getPool();
    await pool.execute(
      `UPDATE events SET ${setClauses.join(", ")} WHERE id = ?`,
      params,
    );
  } catch (error) {
    log.error("Failed to update event in DB", error);
  }
}

export async function loadEventsFromDb(maxEvents: number): Promise<MessageEvent[]> {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      "SELECT * FROM events ORDER BY received_at DESC LIMIT ?",
      [maxEvents],
    );
    const dbRows = rows as EventRow[];
    return dbRows.map(rowToEvent);
  } catch (error) {
    log.error("Failed to load events from DB", error);
    return [];
  }
}
