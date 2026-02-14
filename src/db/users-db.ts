import { getPool } from "./connection.js";

interface UserRow {
  slack_user_id: string;
  display_name: string | null;
  preferences: string | Record<string, unknown> | null;
}

export interface User {
  slackUserId: string;
  displayName: string | null;
  preferences: Record<string, unknown> | null;
}

function parsePreferences(value: string | Record<string, unknown> | null): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function upsertUser(slackUserId: string, displayName: string): Promise<void> {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO users (slack_user_id, display_name)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
    [slackUserId, displayName],
  );
}

export async function getUser(slackUserId: string): Promise<User | null> {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT slack_user_id, display_name, preferences FROM users WHERE slack_user_id = ?",
    [slackUserId],
  );
  const dbRows = rows as UserRow[];
  if (dbRows.length === 0) return null;
  const row = dbRows[0];
  return {
    slackUserId: row.slack_user_id,
    displayName: row.display_name,
    preferences: parsePreferences(row.preferences),
  };
}
