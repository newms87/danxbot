/**
 * DX-569 (Phase 6a of DX-560 — Self-Repair): dashboard-side DB poll →
 * SSE bridge for `system_errors` / `system_error_repairs` changes.
 *
 * **Why this exists.** DX-565 wired `publishRepairErrorUpdated` into
 * every worker-side write path (only `recordError` remains after the
 * card-creating dispatcher was retired). Those writes run in the
 * per-repo worker process; `eventBus` is a process-local in-memory
 * singleton; the dashboard process's SSE subscribers never see them.
 * Operator actions (POST reset / unfixable) DO deliver live because
 * they execute in the dashboard process.
 *
 * Mirrors the shape of `dispatch-stream.ts#startDbChangeDetector`:
 * poll every 2s, diff against a lightweight snapshot map, re-emit
 * `system-repair-error:updated` to the dashboard's eventBus when a row
 * changes. Removed rows emit `{error_id, removed: true}`. The composable
 * (`useSelfRepairErrors.ts`) already reduces that exact payload shape
 * — same wire contract `publishRepairErrorUpdated` produces.
 *
 * Worker-side `publishRepairErrorUpdated` calls become defense-in-depth
 * after this lands (they still publish in-process for any same-process
 * subscribers but cross-process delivery is via this poller).
 */

import type { Pool } from "pg";
import { createLogger } from "../logger.js";
import { getPool } from "../db/connection.js";
import { eventBus } from "./event-bus.js";
import { getRepairErrorDetail } from "../system-repair/db-reads.js";

const log = createLogger("self-repair-stream");

const DEFAULT_POLL_INTERVAL_MS = 2_000;

interface RowSnapshot {
  status: string;
  count: number;
  last_seen: string;
  attempt_count: number;
}

interface SnapshotRow {
  id: number;
  status: string;
  count: number;
  last_seen: string | Date;
  attempt_count: string | number;
}

const SNAPSHOT_SQL = `
  SELECT se.id,
         se.status,
         se.count,
         se.last_seen,
         (SELECT COUNT(*) FROM system_error_repairs ser WHERE ser.error_id = se.id) AS attempt_count
  FROM system_errors se
`;

function rowsEqual(a: RowSnapshot, b: RowSnapshot): boolean {
  return (
    a.status === b.status &&
    a.count === b.count &&
    a.last_seen === b.last_seen &&
    a.attempt_count === b.attempt_count
  );
}

let poller: ReturnType<typeof setInterval> | null = null;
let pollDb: Pool | null = null;
let tickInFlight = false;
const knownErrors = new Map<number, RowSnapshot>();

async function pollTick(): Promise<void> {
  if (!pollDb) return;
  // Re-entrancy guard: a tick that exceeds the interval (slow DB,
  // many changed rows fanned out into per-row detail fetches) would
  // otherwise let setInterval fire a concurrent tick — two callers
  // reading the same knownErrors map both observe diff against the
  // prior snapshot and both publish, emitting a duplicate SSE event.
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const result = await pollDb.query<SnapshotRow>(SNAPSHOT_SQL);
    const seen = new Set<number>();

    for (const r of result.rows) {
      const id = Number(r.id);
      seen.add(id);
      const next: RowSnapshot = {
        status: r.status,
        count: Number(r.count),
        last_seen:
          r.last_seen instanceof Date ? r.last_seen.toISOString() : String(r.last_seen),
        attempt_count: Number(r.attempt_count),
      };
      const prev = knownErrors.get(id);
      if (!prev || !rowsEqual(prev, next)) {
        knownErrors.set(id, next);
        const detail = await getRepairErrorDetail({ db: pollDb, id });
        if (!detail) {
          // Row vanished between snapshot and detail fetch — emit removed.
          knownErrors.delete(id);
          eventBus.publish({
            topic: "system-repair-error:updated",
            data: { error_id: id, removed: true },
          });
        } else {
          eventBus.publish({
            topic: "system-repair-error:updated",
            data: { error_id: id, row: detail },
          });
        }
      }
    }

    for (const cachedId of knownErrors.keys()) {
      if (!seen.has(cachedId)) {
        knownErrors.delete(cachedId);
        eventBus.publish({
          topic: "system-repair-error:updated",
          data: { error_id: cachedId, removed: true },
        });
      }
    }
  } catch (err) {
    log.warn("self-repair DB poll tick failed", err);
  } finally {
    tickInFlight = false;
  }
}

export interface StartSelfRepairStreamOptions {
  /** Override the default pg Pool — used in tests. */
  db?: Pool;
  /** Override the default 2s interval — used in tests. */
  pollIntervalMs?: number;
}

/** Start the background self-repair DB → SSE bridge. Idempotent. */
export function startSelfRepairStream(
  options: StartSelfRepairStreamOptions = {},
): void {
  if (poller) return;
  pollDb = options.db ?? getPool();
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // Seed tick: runs immediately so a fresh dashboard process learns the
  // current world state without waiting `interval` ms.
  pollTick().catch(() => {});
  poller = setInterval(() => {
    pollTick().catch(() => {});
  }, interval);
  log.info(`self-repair stream started (poll interval: ${interval}ms)`);
}

/** Stop the background poller (idempotent). */
export function stopSelfRepairStream(): void {
  if (poller) {
    clearInterval(poller);
    poller = null;
  }
  pollDb = null;
  tickInFlight = false;
  knownErrors.clear();
}
