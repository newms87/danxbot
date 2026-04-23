import { stopSlackListener } from "./slack/listener.js";
import { stopThreadCleanup } from "./threads.js";
import { stopRetentionCron } from "./dashboard/retention.js";
import { clearJobCleanupIntervals } from "./worker/dispatch.js";
import { listActiveJobs } from "./dispatch/core.js";
import { closePool, closePlatformPool } from "./db/connection.js";
import { createLogger } from "./logger.js";

const log = createLogger("shutdown");

interface ShutdownOptions {
  exitProcess?: boolean;
  threadCleanupInterval?: NodeJS.Timeout;
  retentionInterval?: NodeJS.Timeout;
}

export async function shutdown(options: ShutdownOptions = {}): Promise<void> {
  const { exitProcess = true, threadCleanupInterval, retentionInterval } = options;

  log.info("Shutdown signal received, stopping new message processing...");

  // Stop accepting new messages
  stopSlackListener();

  // Drain in-flight dispatches. Every dispatched agent (Slack, Trello poller,
  // /api/launch) is registered in `activeJobs` by `dispatch()` — SIGTERM the
  // underlying claude process via `job.stop()` so the JSONL finalizes and the
  // dispatch row records a terminal status. Stops are issued in parallel and
  // we wait for all of them; `job.stop()` is already bounded (SIGTERM +
  // 5s grace + SIGKILL) so the wall-clock ceiling is fixed.
  const running = listActiveJobs().filter((job) => job.status === "running");
  if (running.length > 0) {
    log.info(`Draining ${running.length} in-flight dispatch(es)...`);
    const stops = running.map((job) =>
      job.stop("failed", "Worker shutdown").catch((err) => {
        log.error(`Failed to stop job ${job.id}`, err);
      }),
    );
    await Promise.allSettled(stops);
  }

  // Stop thread cleanup interval
  if (threadCleanupInterval) {
    stopThreadCleanup(threadCleanupInterval);
  }

  if (retentionInterval) {
    stopRetentionCron(retentionInterval);
  }

  // Clear per-job cleanup intervals from worker dispatch
  clearJobCleanupIntervals();

  // Close database connection pools
  await closePool();
  await closePlatformPool();

  log.info("Shutdown complete");

  if (exitProcess) {
    process.exit(0);
  }
}

export function initShutdownHandlers(options: {
  threadCleanupInterval?: NodeJS.Timeout;
  retentionInterval?: NodeJS.Timeout;
}): void {
  const handleShutdown = () => {
    shutdown({
      exitProcess: true,
      threadCleanupInterval: options.threadCleanupInterval,
      retentionInterval: options.retentionInterval,
    }).catch((error) => {
      log.error("Error during shutdown", error);
      process.exit(1);
    });
  };

  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);
}
