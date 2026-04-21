/**
 * Server-side event producers for the dashboard EventBus.
 *
 * Two background processes run inside the dashboard process:
 *
 * 1. **DB change detector** — polls `listDispatches` every POLL_INTERVAL_MS.
 *    Compares the result against a cached snapshot to detect new dispatches
 *    and status/token changes, then publishes `dispatch:created` and
 *    `dispatch:updated` events.
 *
 * 2. **Per-dispatch JSONL poller** — started lazily when the first SSE client
 *    subscribes to `dispatch:jsonl:<jobId>`, and stopped when the last
 *    subscriber unsubscribes. Reads new JSONL blocks from the dispatch's
 *    JSONL file and publishes `dispatch:jsonl:<jobId>` events.
 *
 * Both producers use the shared `eventBus` singleton. When no SSE clients are
 * connected, the DB poller still runs (keeping the cached state fresh) but
 * publishes to an empty subscriber set at negligible cost.
 */

import { open, readFile } from "node:fs/promises";
import { createLogger } from "../logger.js";
import { listDispatches } from "./dispatches-db.js";
import { parseJsonlContent } from "./jsonl-reader.js";
import { eventBus } from "./event-bus.js";
import type { Dispatch } from "./dispatches.js";

const log = createLogger("dispatch-stream");

/** DB polling interval for change detection. */
const DB_POLL_INTERVAL_MS = 2_000;

/** JSONL file polling interval (matches the old `/follow` tick). */
const JSONL_POLL_INTERVAL_MS = 1_000;

/** How many of the most-recent dispatches to snapshot for change detection. */
const SNAPSHOT_LIMIT = 200;

// ─── DB change detector ───────────────────────────────────────────────────────

/** Lightweight snapshot: id + fields we watch for changes. */
interface DispatchSnapshot {
  id: string;
  status: Dispatch["status"];
  tokensTotal: number;
  summary: string | null;
  error: string | null;
  completedAt: number | null;
}

function toSnapshot(d: Dispatch): DispatchSnapshot {
  return {
    id: d.id,
    status: d.status,
    tokensTotal: d.tokensTotal,
    summary: d.summary,
    error: d.error,
    completedAt: d.completedAt,
  };
}

function snapshotChanged(prev: DispatchSnapshot, next: DispatchSnapshot): boolean {
  return (
    prev.status !== next.status ||
    prev.tokensTotal !== next.tokensTotal ||
    prev.summary !== next.summary ||
    prev.error !== next.error ||
    prev.completedAt !== next.completedAt
  );
}

let dbPoller: ReturnType<typeof setInterval> | null = null;
const knownDispatches = new Map<string, DispatchSnapshot>();

async function dbPollTick(): Promise<void> {
  try {
    const rows = await listDispatches({ since: 0 }, SNAPSHOT_LIMIT);

    for (const dispatch of rows) {
      const next = toSnapshot(dispatch);
      const prev = knownDispatches.get(dispatch.id);

      if (!prev) {
        // New dispatch.
        knownDispatches.set(dispatch.id, next);
        eventBus.publish({ topic: "dispatch:created", data: dispatch });
      } else if (snapshotChanged(prev, next)) {
        // Changed dispatch.
        knownDispatches.set(dispatch.id, next);
        eventBus.publish({
          topic: "dispatch:updated",
          data: {
            id: dispatch.id,
            status: dispatch.status,
            tokensTotal: dispatch.tokensTotal,
            summary: dispatch.summary,
            error: dispatch.error,
            completedAt: dispatch.completedAt,
          },
        });
      }
    }
  } catch (err) {
    log.warn("DB change detection tick failed", err);
  }
}

/** Start the background DB change detector. Idempotent. */
export function startDbChangeDetector(): void {
  if (dbPoller) return;
  // Run immediately on start to seed the snapshot cache.
  dbPollTick().catch(() => {});
  dbPoller = setInterval(() => {
    dbPollTick().catch(() => {});
  }, DB_POLL_INTERVAL_MS);
  log.info(
    `DB change detector started (poll interval: ${DB_POLL_INTERVAL_MS}ms)`,
  );
}

/** Stop the background DB change detector (for tests). */
export function stopDbChangeDetector(): void {
  if (dbPoller) {
    clearInterval(dbPoller);
    dbPoller = null;
  }
  knownDispatches.clear();
}

// ─── Per-dispatch JSONL file poller ───────────────────────────────────────────

interface JsonlWatcher {
  offset: number;
  timer: ReturnType<typeof setInterval>;
  jsonlPath: string;
}

const jsonlWatchers = new Map<string, JsonlWatcher>();

async function jsonlPollTick(jobId: string, watcher: JsonlWatcher): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(watcher.jsonlPath, "r");
    const s = await fh.stat();
    if (s.size > watcher.offset) {
      const buf = Buffer.alloc(s.size - watcher.offset);
      await fh.read(buf, 0, buf.length, watcher.offset);
      watcher.offset = s.size;
      const text = buf.toString("utf-8");
      const { blocks } = parseJsonlContent(text);
      if (blocks.length > 0) {
        eventBus.publish({
          topic: `dispatch:jsonl:${jobId}`,
          data: blocks,
        });
      }
    }
  } catch {
    // File may not exist yet or may have been deleted.
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Start watching a JSONL file for a dispatch. Hydrates immediately with
 * existing content, then polls for new blocks. Idempotent per jobId.
 */
export async function startJsonlWatcher(
  jobId: string,
  jsonlPath: string,
): Promise<void> {
  if (jsonlWatchers.has(jobId)) return;

  let offset = 0;
  // Hydrate: read existing content so new subscribers see history.
  try {
    const existing = await readFile(jsonlPath, "utf-8");
    const { blocks } = parseJsonlContent(existing);
    if (blocks.length > 0) {
      eventBus.publish({ topic: `dispatch:jsonl:${jobId}`, data: blocks });
    }
    offset = Buffer.byteLength(existing, "utf-8");
  } catch {
    // File doesn't exist yet — tick will retry.
  }

  const watcher: JsonlWatcher = {
    offset,
    jsonlPath,
    timer: setInterval(() => {
      jsonlPollTick(jobId, watcher).catch(() => {});
    }, JSONL_POLL_INTERVAL_MS),
  };

  jsonlWatchers.set(jobId, watcher);
}

/**
 * Stop watching a dispatch's JSONL file. Called when all subscribers for
 * `dispatch:jsonl:<jobId>` have disconnected.
 */
export function stopJsonlWatcher(jobId: string): void {
  const watcher = jsonlWatchers.get(jobId);
  if (watcher) {
    clearInterval(watcher.timer);
    jsonlWatchers.delete(jobId);
  }
}

/** For testing — stop all watchers and detectors. */
export function _stopAll(): void {
  stopDbChangeDetector();
  for (const [jobId] of jsonlWatchers) {
    stopJsonlWatcher(jobId);
  }
}
