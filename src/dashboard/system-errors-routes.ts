/**
 * REST handler for the buffered system-errors tail.
 *
 * GET /api/system-errors?repo=<name>&limit=<n>
 *
 * Returns `{ events: SystemError[] }` newest-first. Live updates flow over
 * the multiplexed SSE stream at `GET /api/stream?topics=system-errors` —
 * this route exists only to seed a freshly-mounted banner with the recent
 * backlog before it switches to live mode. Auth is handled by the blanket
 * `/api/*` `requireUser` gate in `server.ts`.
 */

import type { ServerResponse } from "http";
import { json } from "../http/helpers.js";
import { listSystemErrors } from "./system-errors.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  if (raw == null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export function handleListSystemErrors(
  res: ServerResponse,
  params: URLSearchParams,
): void {
  const repo = params.get("repo");
  const limit = parseLimit(params.get("limit"));
  const events = listSystemErrors({
    repo: repo && repo.length > 0 ? repo : null,
    limit,
  });
  json(res, 200, { events });
}
