/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair): REST surface for the
 * dashboard's "Self-Repair" tab. Three operator-facing routes against
 * the `system_errors` + `system_error_repairs` tables that Phases 1–4
 * populated.
 *
 *   GET  /api/self-repair/errors?repo=<name>
 *     → RepairErrorWithAttempts[] — every row, ordered count DESC,
 *       last_seen DESC.
 *   GET  /api/self-repair/errors/:id
 *     → RepairErrorWithAttempts — single row with full sample payload
 *       and the complete attempt history.
 *   POST /api/self-repair/errors/:id/reset
 *     → operator-only reset: clears attempts + flips status='open'.
 *   POST /api/self-repair/errors/:id/unfixable
 *     → operator override: flips status='unfixable'.
 *
 * Auth: all four routes are gated by the blanket `/api/*` per-user
 * bearer in `server.ts` (the same gate that protects every other
 * dashboard write surface). The dispatch token is NOT accepted —
 * these are human-driven operations.
 *
 * Live updates flow through the multiplexed SSE stream's
 * `system-repair-error:updated` topic. The REST endpoints exist to
 * seed a freshly-mounted tab with the recent backlog before it
 * switches to live mode (mirror of the `useDispatches` pattern from
 * DX-227).
 */

import type { IncomingMessage, ServerResponse } from "http";
import { createLogger } from "../logger.js";
import { json } from "../http/helpers.js";
import {
  getRepairErrorDetail,
  listRepairErrors,
  markUnfixable,
  resetRepairError,
} from "../system-repair/db-reads.js";
import { publishRepairErrorUpdated } from "../system-repair/publish.js";
import type { Pool } from "pg";

const log = createLogger("self-repair-routes");

export interface SelfRepairRouteDeps {
  db: Pool;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  if (raw == null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function handleListRepairErrors(
  res: ServerResponse,
  params: URLSearchParams,
  deps: SelfRepairRouteDeps,
): Promise<void> {
  try {
    const repo = params.get("repo");
    const limit = parseLimit(params.get("limit"));
    const rows = await listRepairErrors({
      db: deps.db,
      repo: repo && repo.length > 0 ? repo : null,
      limit,
    });
    json(res, 200, { errors: rows });
  } catch (err) {
    log.error("listRepairErrors failed", err);
    json(res, 500, { error: "Failed to list repair errors" });
  }
}

export async function handleGetRepairError(
  res: ServerResponse,
  idRaw: string,
  deps: SelfRepairRouteDeps,
): Promise<void> {
  const id = parseId(idRaw);
  if (id === null) {
    json(res, 400, { error: "Invalid id" });
    return;
  }
  try {
    const detail = await getRepairErrorDetail({ db: deps.db, id });
    if (!detail) {
      json(res, 404, { error: "Repair error not found" });
      return;
    }
    json(res, 200, detail);
  } catch (err) {
    log.error("getRepairErrorDetail failed", err);
    json(res, 500, { error: "Failed to fetch repair error" });
  }
}

export async function handleResetRepairError(
  _req: IncomingMessage,
  res: ServerResponse,
  idRaw: string,
  deps: SelfRepairRouteDeps,
): Promise<void> {
  const id = parseId(idRaw);
  if (id === null) {
    json(res, 400, { error: "Invalid id" });
    return;
  }
  try {
    const result = await resetRepairError({ db: deps.db, id });
    if (result.kind === "not-found") {
      json(res, 404, { error: "Repair error not found" });
      return;
    }
    // Fan out the post-mutation snapshot to SSE subscribers. Operator
    // mutations run in the dashboard process, so the in-memory bus
    // delivery reaches every connected client.
    void publishRepairErrorUpdated({ db: deps.db, errorId: id });
    json(res, 200, { row: result.row });
  } catch (err) {
    log.error("resetRepairError failed", err);
    json(res, 500, { error: "Failed to reset repair error" });
  }
}

export async function handleMarkUnfixable(
  _req: IncomingMessage,
  res: ServerResponse,
  idRaw: string,
  deps: SelfRepairRouteDeps,
): Promise<void> {
  const id = parseId(idRaw);
  if (id === null) {
    json(res, 400, { error: "Invalid id" });
    return;
  }
  try {
    const result = await markUnfixable({ db: deps.db, id });
    if (result.kind === "not-found") {
      json(res, 404, { error: "Repair error not found" });
      return;
    }
    void publishRepairErrorUpdated({ db: deps.db, errorId: id });
    json(res, 200, { row: result.row });
  } catch (err) {
    log.error("markUnfixable failed", err);
    json(res, 500, { error: "Failed to mark unfixable" });
  }
}
