// Slack-domain user storage. Keyed on `slack_user_id`; tracks display name and
// per-user Slack prefs. Dashboard login lives in `src/dashboard/auth-db.ts` —
// see `upsertDashboardUser` there. The two paths share the `users` table but
// never overwrite each other's columns (Slack uses slack_user_id+display_name;
// dashboard uses username+password_hash; migration 011 extended the table).
import { query } from "./connection.js";

interface UserRow {
  slack_user_id: string;
  display_name: string | null;
  preferences: Record<string, unknown> | null;
}

export interface User {
  slackUserId: string;
  displayName: string | null;
  preferences: Record<string, unknown> | null;
}

export async function upsertUser(slackUserId: string, displayName: string): Promise<void> {
  await query(
    `INSERT INTO users (slack_user_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (slack_user_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [slackUserId, displayName],
  );
}

export async function getUser(slackUserId: string): Promise<User | null> {
  const rows = await query<UserRow>(
    "SELECT slack_user_id, display_name, preferences FROM users WHERE slack_user_id = $1",
    [slackUserId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    slackUserId: row.slack_user_id,
    displayName: row.display_name,
    preferences: row.preferences ?? null,
  };
}
