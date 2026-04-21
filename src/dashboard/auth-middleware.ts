/**
 * Per-user auth gate for the dashboard. Consumed by every dashboard API
 * route that mutates state — PATCH /api/agents/:repo/toggles today,
 * additional write routes as they land.
 *
 * `requireUser` reads `Authorization: Bearer <token>`, validates the
 * token against `api_tokens` via `validateToken`, and returns the user.
 *
 * Dispatch-proxy routes (/api/launch, /api/resume, /api/status/:jobId,
 * /api/cancel/:jobId, /api/stop/:jobId) are NEVER gated by requireUser —
 * they authenticate with `DANXBOT_DISPATCH_TOKEN` internally. The two
 * credentials are deliberately separate: dispatch token = bot↔repo,
 * user token = human↔dashboard. See `.claude/rules/agent-dispatch.md`.
 */

import type { IncomingMessage } from "http";
import { validateToken } from "./auth-db.js";
import { extractBearer } from "./dispatch-proxy.js";

export interface AuthedUser {
  userId: number;
  username: string;
}

/**
 * Discriminated union: when `ok: true`, `user` is always present; when
 * `ok: false`, only `status` is set. Callers can narrow on `auth.ok`
 * and skip the `|| !auth.user` defensive guard.
 */
export type RequireUserResult =
  | { ok: true; user: AuthedUser }
  | { ok: false; status: 401 };

export async function requireUser(
  req: IncomingMessage,
): Promise<RequireUserResult> {
  const rawToken = extractBearer(req.headers.authorization);
  if (!rawToken) return { ok: false, status: 401 };
  const validated = await validateToken(rawToken);
  if (!validated) return { ok: false, status: 401 };
  return { ok: true, user: validated };
}
