import { startSlackListener, getSlackClient } from "./slack/listener.js";
import { startThreadCleanup } from "./threads.js";
import { startDashboard } from "./dashboard/server.js";
import { loadEvents } from "./dashboard/events.js";
import { initShutdownHandlers } from "./shutdown.js";
import { createLogger } from "./logger.js";
import { runMigrations } from "./db/migrate.js";

const log = createLogger("startup");

async function main(): Promise<void> {
  log.info("Starting Flytebot...");

  // Run database migrations
  await runMigrations();

  // Start periodic thread file cleanup
  const threadCleanupInterval = startThreadCleanup();

  // Load persisted events from disk before starting the dashboard
  await loadEvents();

  // Start the monitoring dashboard
  await startDashboard();

  // Start Slack Socket Mode listener
  await startSlackListener();

  // Initialize shutdown handlers
  const slackClient = getSlackClient();
  initShutdownHandlers({ threadCleanupInterval, slackClient });
}

main().catch((error) => {
  log.error("Fatal error", error);
  process.exit(1);
});
