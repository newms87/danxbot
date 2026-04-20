/**
 * Per-user auth gate for the dashboard. Consumed by every dashboard API
 * route except the explicitly-open ones (health, POST /api/auth/login,
 * static assets, the SPA shell at `/`).
 *
 * `requireUser` reads `Authorization: Bearer <token>`, validates the
 * token against `api_tokens` via `validateToken`, and returns the user.
 *
 * `checkAuthEither` accepts either a valid user token or the
 * `DANXBOT_DISPATCH_TOKEN`. Used on PATCH /api/agents/:repo/toggles so
 * gpt-manager and other external clients with only the dispatch token
 * keep working alongside signed-in humans.
 *
 * Dispatch-proxy routes (/api/launch, /api/resume, /api/status/:jobId,
 * /api/cancel/:jobId, /api/stop/:jobId) are NEVER gated by requireUser —
 * they authenticate with the dispatch token internally. That separation
 * (bot↔repo credential vs human↔dashboard credential) is codified in
 * .claude/rules/agent-dispatch.md.
 */

import type { IncomingMessage } from "http";
import { validateToken } from "./auth-db.js";
import { checkAuth, extractBearer } from "./dispatch-proxy.js";

export interface AuthedUser {
  userId: number;
  username: string;
}

export interface RequireUserResult {
  ok: boolean;
  status?: 401;
  user?: AuthedUser;
}

export async function requireUser(
  req: IncomingMessage,
): Promise<RequireUserResult> {
  const rawToken = extractBearer(req.headers.authorization);
  if (!rawToken) return { ok: false, status: 401 };
  const validated = await validateToken(rawToken);
  if (!validated) return { ok: false, status: 401 };
  return { ok: true, user: validated };
}

/**
 * Accept either a valid user token OR the dispatch token. Returns the
 * resolved user on the user-path (so handlers can record provenance);
 * on the dispatch-token path returns `{ok: true}` with no user.
 */
export async function checkAuthEither(
  req: IncomingMessage,
  dispatchToken: string,
): Promise<RequireUserResult> {
  const userResult = await requireUser(req);
  if (userResult.ok) return userResult;

  const dispatchResult = checkAuth(req, dispatchToken);
  if (dispatchResult.ok) return { ok: true };

  return { ok: false, status: 401 };
}
