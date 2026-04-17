import { unlink } from "node:fs/promises";
import { createLogger } from "../logger.js";
import { deleteOldDispatches } from "./dispatches-db.js";

const log = createLogger("retention");

/** 30 days in milliseconds. */
export const RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Default run cadence: daily. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete terminal-state dispatches older than `maxAgeMs` and unlink their
 * JSONL files. Non-terminal dispatches (queued, running) are preserved
 * regardless of age — multi-day agent runs must not be truncated.
 * Returns the count of rows deleted.
 */
export async function runRetentionOnce(
  maxAgeMs: number = RETENTION_MAX_AGE_MS,
): Promise<number> {
  let deleted: Array<{ id: string; jsonlPath: string | null }>;
  try {
    deleted = await deleteOldDispatches(maxAgeMs);
  } catch (err) {
    log.error("Failed to delete old dispatches", err);
    return 0;
  }

  for (const row of deleted) {
    if (!row.jsonlPath) continue;
    try {
      await unlink(row.jsonlPath);
    } catch (err) {
      // ENOENT is expected — the file may have been moved or cleaned already.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn(
          `Failed to unlink JSONL for dispatch ${row.id}: ${row.jsonlPath}`,
          err,
        );
      }
    }
  }

  if (deleted.length > 0) {
    log.info(`Retention: deleted ${deleted.length} dispatch(es) + JSONLs`);
  }
  return deleted.length;
}

export function startRetentionCron(
  intervalMs: number = RETENTION_INTERVAL_MS,
  maxAgeMs: number = RETENTION_MAX_AGE_MS,
): NodeJS.Timeout {
  // Run once at startup, then on the interval. Fire-and-forget so startup
  // never blocks on retention.
  runRetentionOnce(maxAgeMs).catch((err) =>
    log.error("Initial retention run failed", err),
  );
  return setInterval(() => {
    runRetentionOnce(maxAgeMs).catch((err) =>
      log.error("Retention run failed", err),
    );
  }, intervalMs);
}

export function stopRetentionCron(interval: NodeJS.Timeout): void {
  clearInterval(interval);
}
