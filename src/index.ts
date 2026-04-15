import { startSlackListener, getSlackClient } from "./slack/listener.js";
import { startThreadCleanup } from "./threads.js";
import { startDashboard } from "./dashboard/server.js";
import { startWorkerServer } from "./worker/server.js";
import { loadEvents, startEventCleanup } from "./dashboard/events.js";
import { initShutdownHandlers } from "./shutdown.js";
import { createLogger } from "./logger.js";
import { runMigrations } from "./db/migrate.js";
import { isWorkerMode, isDashboardMode, workerRepoName } from "./config.js";
import { repoContexts } from "./repo-context.js";
import { start as startPoller } from "./poller/index.js";

const log = createLogger("startup");

/**
 * Dashboard mode: runs shared infrastructure (migrations, dashboard server, cleanup).
 * No poller, no Slack — those run in per-repo worker containers.
 */
async function startDashboardMode(): Promise<void> {
  log.info("Starting Danxbot dashboard...");

  await runMigrations();

  const threadCleanupInterval = startThreadCleanup();
  await loadEvents();
  const eventCleanupInterval = startEventCleanup();

  await startDashboard();

  initShutdownHandlers({ threadCleanupInterval, eventCleanupInterval });

  log.info("Dashboard mode ready — no poller or Slack (workers handle those)");
}

/**
 * Worker mode: manages a single repo (poller, Slack listener, dispatch API).
 * No dashboard — that runs in the shared infrastructure container.
 */
async function startWorkerMode(): Promise<void> {
  log.info(`Starting Danxbot worker for repo: ${workerRepoName}...`);

  const repo = repoContexts[0];
  if (!repo) {
    throw new Error(`Worker mode: no repo context loaded for "${workerRepoName}"`);
  }

  // Start the worker HTTP server (dispatch API + health)
  await startWorkerServer(repo);

  // Start Slack listener for this repo (if configured)
  let slackClient: ReturnType<typeof getSlackClient> | undefined;
  if (repo.slack.enabled) {
    await startSlackListener(repo);
    slackClient = getSlackClient();
    log.info(`[${repo.name}] Slack integration enabled`);
  } else {
    log.info(`[${repo.name}] Slack not configured`);
  }

  // Start poller for this repo
  startPoller();
  log.info(`[${repo.name}] Poller started`);

  initShutdownHandlers({ slackClient });

  log.info(`Worker mode ready for repo: ${repo.name}`);
}

/**
 * Legacy host mode: runs everything in a single process (dashboard + all repos).
 * Used for local development when DANXBOT_REPO_NAME is not set.
 */
async function startLegacyMode(): Promise<void> {
  log.info("Starting Danxbot (legacy single-process mode)...");

  await runMigrations();

  const threadCleanupInterval = startThreadCleanup();
  await loadEvents();
  const eventCleanupInterval = startEventCleanup();

  await startDashboard();

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

  const slackClient = slackClients.length > 0 ? slackClients[slackClients.length - 1] : undefined;
  initShutdownHandlers({ threadCleanupInterval, eventCleanupInterval, slackClient });
}

async function main(): Promise<void> {
  if (isWorkerMode) {
    await startWorkerMode();
  } else if (isDashboardMode && repoContexts.length === 0) {
    await startDashboardMode();
  } else {
    // Legacy: host mode with repos loaded — single process handles everything
    await startLegacyMode();
  }
}

main().catch((error) => {
  log.error("Fatal error", error);
  process.exit(1);
});
