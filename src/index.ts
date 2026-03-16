import { startSlackListener, getSlackClient } from "./slack/listener.js";
import { startThreadCleanup } from "./threads.js";
import { startDashboard } from "./dashboard/server.js";
import { loadEvents, startEventCleanup } from "./dashboard/events.js";
import { initShutdownHandlers } from "./shutdown.js";
import { createLogger } from "./logger.js";
import { runMigrations } from "./db/migrate.js";
import { config } from "./config.js";

const log = createLogger("startup");

async function main(): Promise<void> {
  log.info("Starting Danxbot...");

  // Run database migrations
  await runMigrations();

  // Start periodic thread file cleanup
  const threadCleanupInterval = startThreadCleanup();

  // Load persisted events from disk before starting the dashboard
  await loadEvents();

  // Start periodic event cleanup
  const eventCleanupInterval = startEventCleanup();

  // Start the monitoring dashboard
  await startDashboard();

  // Start Slack Socket Mode listener (only if configured)
  if (config.slack.enabled) {
    await startSlackListener();
    log.info("Slack integration enabled");
  } else {
    log.info("Slack not configured — running without Slack integration");
  }

  // Initialize shutdown handlers
  const slackClient = config.slack.enabled ? getSlackClient() : undefined;
  initShutdownHandlers({ threadCleanupInterval, eventCleanupInterval, slackClient });
}

main().catch((error) => {
  log.error("Fatal error", error);
  process.exit(1);
});
