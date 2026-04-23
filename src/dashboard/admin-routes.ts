/**
 * Admin / danger-zone routes for the dashboard.
 *
 * Today the only route is `POST /api/admin/reset`, which wipes the
 * operational data tables (dispatches, threads, events, health_check)
 * while leaving auth (users, api_tokens) intact. The route is auth-gated
 * via the blanket `/api/*` bearer check in `server.ts` — no second
 * `requireUser` call is needed here.
 *
 * The request body must be `{ "confirm": "RESET" }`. This is defense in
 * depth against accidental POSTs — a misrouted fetch, an old bookmark,
 * or an autocomplete mistake won't wipe the DB. The dashboard UI
 * supplies the sentinel string from a DanxDialog confirm flow.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { resetAllData } from "./reset-data.js";

const log = createLogger("admin-routes");

const CONFIRM_SENTINEL = "RESET";

export async function handleAdminReset(
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

  if (body.confirm !== CONFIRM_SENTINEL) {
    json(res, 400, {
      error: `Missing or invalid confirm token. Body must include {"confirm":"${CONFIRM_SENTINEL}"}.`,
    });
    return;
  }

  try {
    const result = await resetAllData();
    log.warn(
      `Admin reset executed: ${result.rowsDeleted} row(s) deleted across ${result.tablesCleared.length} table(s)`,
    );
    json(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Admin reset failed: ${message}`);
    json(res, 500, { error: "Reset failed", details: message });
  }
}
