import type { ResultSetHeader } from "mysql2/promise";
import { getPool } from "./connection.js";
import type { ThreadState, ThreadMessage } from "../types.js";

interface ThreadRow {
  thread_ts: string;
  channel_id: string;
  session_id: string | null;
  messages: string | ThreadMessage[];
  created_at: Date;
  updated_at: Date;
}

function rowToThread(row: ThreadRow): ThreadState {
  const messages =
    typeof row.messages === "string" ? JSON.parse(row.messages) : row.messages;
  return {
    threadTs: row.thread_ts,
    channelId: row.channel_id,
    sessionId: row.session_id,
    messages,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function loadThreadFromDb(threadTs: string): Promise<ThreadState | null> {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT * FROM threads WHERE thread_ts = ?",
    [threadTs],
  );
  const dbRows = rows as ThreadRow[];
  if (dbRows.length === 0) return null;
  return rowToThread(dbRows[0]);
}

export async function saveThreadToDb(thread: ThreadState): Promise<void> {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO threads (thread_ts, channel_id, session_id, messages)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       channel_id = VALUES(channel_id),
       session_id = VALUES(session_id),
       messages = VALUES(messages)`,
    [
      thread.threadTs,
      thread.channelId,
      thread.sessionId,
      JSON.stringify(thread.messages),
    ],
  );
}

export async function deleteOldThreadsFromDb(maxAgeMs: number): Promise<number> {
  const pool = getPool();
  const maxAgeSeconds = Math.floor(maxAgeMs / 1000);
  const [result] = await pool.execute(
    "DELETE FROM threads WHERE updated_at < NOW() - INTERVAL ? SECOND",
    [maxAgeSeconds],
  );
  return (result as ResultSetHeader).affectedRows;
}

export async function isBotInThread(threadTs: string): Promise<boolean | null> {
  const thread = await loadThreadFromDb(threadTs);
  if (!thread) return null;
  return thread.messages.some((msg) => msg.isBot);
}
