import { startSlackListener, getSlackClient } from "./slack/listener.js";
import { startThreadCleanup } from "./threads.js";
import { startDashboard } from "./dashboard/server.js";
import { loadEvents, startEventCleanup } from "./dashboard/events.js";
import { initShutdownHandlers } from "./shutdown.js";
import { createLogger } from "./logger.js";
import { runMigrations } from "./db/migrate.js";
import { repoContexts } from "./config.js";

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

  // Start Slack listeners for each repo that has Slack configured
  const slackClients: ReturnType<typeof getSlackClient>[] = [];
  for (const repo of repoContexts) {
    if (repo.slack.enabled) {
      await startSlackListener(repo);
      slackClients.push(getSlackClient());
      log.info(`[${repo.name}] Slack integration enabled`);
    } else {
      log.info(`[${repo.name}] Slack not configured — running without Slack integration`);
    }
  }

  if (repoContexts.length === 0) {
    log.info("No repos configured — running dashboard only");
  }

  // Initialize shutdown handlers (use last Slack client for cleanup)
  const slackClient = slackClients.length > 0 ? slackClients[slackClients.length - 1] : undefined;
  initShutdownHandlers({ threadCleanupInterval, eventCleanupInterval, slackClient });
}

main().catch((error) => {
  log.error("Fatal error", error);
  process.exit(1);
});
