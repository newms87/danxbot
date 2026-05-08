import { getPool, query } from "./connection.js";
import type { ThreadState, ThreadMessage } from "../types.js";

interface ThreadRow {
  thread_ts: string;
  channel_id: string;
  session_id: string | null;
  messages: ThreadMessage[];
  created_at: Date;
  updated_at: Date;
}

function rowToThread(row: ThreadRow): ThreadState {
  return {
    threadTs: row.thread_ts,
    channelId: row.channel_id,
    sessionId: row.session_id,
    messages: row.messages,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function loadThreadFromDb(threadTs: string): Promise<ThreadState | null> {
  const rows = await query<ThreadRow>(
    "SELECT * FROM threads WHERE thread_ts = $1",
    [threadTs],
  );
  if (rows.length === 0) return null;
  return rowToThread(rows[0]);
}

export async function saveThreadToDb(thread: ThreadState): Promise<void> {
  await query(
    `INSERT INTO threads (thread_ts, channel_id, session_id, messages)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (thread_ts) DO UPDATE SET
       channel_id = EXCLUDED.channel_id,
       session_id = EXCLUDED.session_id,
       messages = EXCLUDED.messages`,
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
  const result = await pool.query(
    `DELETE FROM threads WHERE updated_at < NOW() - ($1::int * INTERVAL '1 second')`,
    [maxAgeSeconds],
  );
  return result.rowCount ?? 0;
}

export async function isBotInThread(threadTs: string): Promise<boolean | null> {
  const thread = await loadThreadFromDb(threadTs);
  if (!thread) return null;
  return thread.messages.some((msg) => msg.isBot);
}
