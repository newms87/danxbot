import { stopSlackListener } from "./slack/listener.js";
import { stopThreadCleanup } from "./threads.js";
import { stopRetentionCron } from "./dashboard/retention.js";
import { clearJobCleanupIntervals } from "./worker/dispatch.js";
import { listActiveJobs } from "./dispatch/core.js";
import { unwatchAllSettingsFiles } from "./dispatch/scheduler.js";
import { unwatchAllRepoEnvFiles } from "./dashboard/repo-env-writer.js";
import { stopAllIssuesWatchers } from "./dashboard/issues-watcher.js";
import { stopAllAgentsWatchers } from "./dashboard/agents-watcher.js";
import { shutdownAllHmr } from "./template-hmr/index.js";
import { closePool, closePlatformPool } from "./db/connection.js";
import { createLogger } from "./logger.js";
import type { WorkerCronLoopHandle } from "./cron/worker-loop.js";
import type { EventLoopMonitorHandle } from "./observability/event-loop-monitor.js";

const log = createLogger("shutdown");

interface ShutdownOptions {
  exitProcess?: boolean;
  threadCleanupInterval?: NodeJS.Timeout;
  retentionInterval?: NodeJS.Timeout;
  workerCronLoop?: WorkerCronLoopHandle | null;
  eventLoopMonitor?: EventLoopMonitorHandle | null;
}

export async function shutdown(options: ShutdownOptions = {}): Promise<void> {
  const {
    exitProcess = true,
    threadCleanupInterval,
    retentionInterval,
    workerCronLoop,
    eventLoopMonitor,
  } = options;

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

  // DX-551 — clear the worker-internal cron loop's setInterval. The
  // handle is null in dashboard mode (no worker cron) and in worker
  // mode when the boot pass threw.
  if (workerCronLoop) {
    workerCronLoop.stop();
  }

  // DX-636 — disable the perf_hooks histogram + clear its tick interval.
  // Null in dashboard mode (worker-only) and in worker mode when the boot
  // path threw before the monitor was started.
  if (eventLoopMonitor) {
    eventLoopMonitor.stop();
  }

  // Clear per-job cleanup intervals from worker dispatch
  clearJobCleanupIntervals();

  // Phase 4b.2 (DX-289). Drain every per-repo settings.json chokidar
  // watcher so handles don't outlive the worker on SIGTERM.
  await unwatchAllSettingsFiles();

  // DX-303 — drain every per-repo `.env` chokidar watcher for the same
  // shutdown-cleanliness reason as settings.json above.
  await unwatchAllRepoEnvFiles();

  // DX-226 — drain the dashboard's per-repo issues-watcher chokidar
  // instances so handles don't outlive the dashboard process on SIGTERM.
  // No-op in worker mode (the registry is empty when only the worker is
  // running — only `startDashboard` adds entries).
  await stopAllIssuesWatchers();

  // DX-369 (Phase 6 of DX-363) — drain the dashboard's per-repo
  // agents-watcher chokidar instances on `<repo>/.danxbot/settings.json`.
  // Same dashboard-mode-only ownership as the issues watcher above.
  await stopAllAgentsWatchers();

  // SG-189 — kill every Vite child spawned by the template-hmr module so
  // a graceful shutdown does not leak dev-server processes onto the
  // operator's box. Worker restart re-acquires HMR per live dispatch on
  // the next dispatch reattach pass.
  await shutdownAllHmr();

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
  workerCronLoop?: WorkerCronLoopHandle | null;
  eventLoopMonitor?: EventLoopMonitorHandle | null;
}): void {
  const handleShutdown = () => {
    shutdown({
      exitProcess: true,
      threadCleanupInterval: options.threadCleanupInterval,
      retentionInterval: options.retentionInterval,
      workerCronLoop: options.workerCronLoop,
      eventLoopMonitor: options.eventLoopMonitor,
    }).catch((error) => {
      log.error("Error during shutdown", error);
      process.exit(1);
    });
  };

  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);
}
