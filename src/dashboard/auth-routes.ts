/**
 * Dashboard auth routes — human login / logout / who-am-I.
 *
 *   POST /api/auth/login   — body {username, password} → {token, user}
 *   POST /api/auth/logout  — bearer → 204 (revokes all of the user's tokens)
 *   GET  /api/auth/me      — bearer → {user: {username}}
 *
 * Pairs with `auth-middleware.ts::requireUser` for the gate applied to
 * every other dashboard route.
 *
 * Contract: rotate-on-login is single-session-per-user (see
 * `issueFreshToken` in auth-db.ts). The SPA's 401 handler should treat a
 * rejected session token as "signed in from another session / expired"
 * rather than "invalid credentials."
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import {
  loginDashboardUser,
  revokeAllTokensForUser,
} from "./auth-db.js";
import { requireUser } from "./auth-middleware.js";

const log = createLogger("auth-routes");

export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const username = body["username"];
  const password = body["password"];

  if (
    typeof username !== "string" ||
    username.length === 0 ||
    typeof password !== "string" ||
    password.length === 0
  ) {
    json(res, 400, { error: "username and password are required" });
    return;
  }

  try {
    const result = await loginDashboardUser(username, password);
    if (!result) {
      json(res, 401, { error: "Invalid username or password" });
      return;
    }
    json(res, 200, {
      token: result.rawToken,
      user: { username },
    });
  } catch (err) {
    log.error(`Login failed for ${username}`, err);
    json(res, 500, { error: "Login failed" });
  }
}

export async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok || !auth.user) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  try {
    await revokeAllTokensForUser(auth.user.userId);
    res.writeHead(204);
    res.end();
  } catch (err) {
    log.error(`Logout failed for user ${auth.user.username}`, err);
    json(res, 500, { error: "Logout failed" });
  }
}

export async function handleMe(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok || !auth.user) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  json(res, 200, { user: { username: auth.user.username } });
}
