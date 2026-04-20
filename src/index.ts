import { startSlackListener, getSlackClient } from "./slack/listener.js";
import { startThreadCleanup } from "./threads.js";
import { startDashboard } from "./dashboard/server.js";
import { startWorkerServer } from "./worker/server.js";
import { startRetentionCron } from "./dashboard/retention.js";
import { initShutdownHandlers } from "./shutdown.js";
import { createLogger } from "./logger.js";
import { runMigrations } from "./db/migrate.js";
import { initPlatformPool } from "./db/connection.js";
import { config, isWorkerMode, workerRepoName } from "./config.js";
import { repoContexts } from "./repo-context.js";
import { start as startPoller } from "./poller/index.js";
import { ensureSettingsFile } from "./settings-file.js";

const log = createLogger("startup");

/**
 * Dashboard mode: runs shared infrastructure (migrations, dashboard server, cleanup).
 * No poller, no Slack — those run in per-repo worker containers.
 */
async function startDashboardMode(): Promise<void> {
  log.info("Starting Danxbot dashboard...");

  await runMigrations();

  const threadCleanupInterval = startThreadCleanup();
  const retentionInterval = startRetentionCron();

  await startDashboard();

  initShutdownHandlers({ threadCleanupInterval, retentionInterval });

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

  // Seed `.danxbot/settings.json` with a `display` snapshot if it's
  // missing so the dashboard has something to render before deploy/setup
  // write the authoritative values. This NEVER clobbers existing state —
  // it's a first-boot backstop only. See `.claude/rules/settings-file.md`.
  await ensureSettingsFile(repo, config.runtime);

  // Platform pool must be ready before any sql:execute block runs.
  // Disabled repos skip pool creation.
  initPlatformPool(repo.db);

  // Propagate resolved DB credentials to process.env so that child processes
  // (the Claude CLI and any Bash tool it spawns, e.g. describe-tables.sh)
  // can reach the same database the worker is using. Resolved values —
  // docker-service-name → 127.0.0.1 translation has already happened in
  // repo-context when running on host.
  if (repo.db.enabled) {
    process.env.DANX_DB_HOST = repo.db.host;
    process.env.DANX_DB_PORT = String(repo.db.port);
    process.env.DANX_DB_USER = repo.db.user;
    process.env.DANX_DB_PASSWORD = repo.db.password;
    process.env.DANX_DB_NAME = repo.db.database;
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

async function main(): Promise<void> {
  if (isWorkerMode) {
    await startWorkerMode();
  } else {
    await startDashboardMode();
  }
}

main().catch((error) => {
  log.error("Fatal error", error);
  process.exit(1);
});
