import type { WebClient } from "@slack/web-api";
import { upsertUser } from "../db/users-db.js";
import { createLogger } from "../logger.js";

const log = createLogger("user-cache");
const userCache = new Map<string, string>();

export async function resolveUserName(
  client: Pick<WebClient, "users">,
  userId: string,
): Promise<string> {
  const cached = userCache.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const user = result.user as
      | { profile?: { display_name?: string; real_name?: string }; real_name?: string }
      | undefined;
    const name =
      user?.profile?.display_name || user?.profile?.real_name || user?.real_name;
    if (!name) return userId;
    userCache.set(userId, name);
    // Fire-and-forget persist to DB
    upsertUser(userId, name).catch((err) =>
      log.error("Failed to persist user to DB", err),
    );
    return name;
  } catch {
    return userId;
  }
}

export function resetUserCache(): void {
  userCache.clear();
}
