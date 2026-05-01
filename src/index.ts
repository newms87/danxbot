import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startSlackListener } from "./slack/listener.js";
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
import { start as startPoller, syncRepoFiles } from "./poller/index.js";
import { syncSettingsFileOnBoot } from "./settings-file.js";

const log = createLogger("startup");

/**
 * Assert that the Claude Code session-log directory is accessible and writable.
 *
 * In docker runtime, Claude Code writes JSONL session logs to
 * `~/.claude/projects/` inside the worker container. The compose.yml volume
 * mount (`./repos/<name>/claude-projects:/home/danxbot/.claude/projects`)
 * makes those logs visible to the host so the dashboard can read them via the
 * per-repo override mounts. If that bind mount is missing or read-only, the
 * dashboard will silently see no session data.
 *
 * This function detects and warns about such mismatches at startup rather than
 * waiting for a live dispatch to fail silently.
 *
 * The optional `dir` parameter exists for testability; production callers omit
 * it and use the real Claude Code projects path.
 */
export async function assertJsonlDirectoryAccess(
  repoName: string,
  dir: string = join(homedir(), ".claude", "projects"),
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    log.info(`[${repoName}] JSONL projects dir OK: ${dir}`);
  } catch (err) {
    log.warn(
      `[${repoName}] JSONL projects dir NOT writable: ${dir} — ` +
        `ensure the compose.yml volume mount is correct so the dashboard can ` +
        `read session logs via the per-repo claude-projects bind. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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

  // Sync `.danxbot/settings.json` display section from RepoContext on
  // every worker boot. Creates the file on first boot AND refreshes
  // display on every restart so deploys (which always restart the
  // worker) automatically surface the latest masked config — operator
  // `overrides` are preserved across restarts. See
  // `.claude/rules/settings-file.md`.
  await syncSettingsFileOnBoot(repo, config.runtime);

  // Run the inject pipeline once at boot regardless of poller toggle.
  // Workspace fixtures, danx-* rules, skills, tools, and the mcp-servers/
  // symlink must exist for every dispatched agent — including agents from
  // /api/launch and Slack — even when the Trello poller is disabled. The
  // poll loop re-runs this on every tick when the poller is enabled, but
  // it never runs at all when the poller is disabled, which is why this
  // boot-time call is required.
  syncRepoFiles(repo);

  // Assert that the JSONL projects directory is accessible and writable.
  // Catches missing or misconfigured bind mounts early so operators see a
  // clear warning at startup rather than discovering it via a failed dispatch.
  await assertJsonlDirectoryAccess(repo.name);

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
  if (repo.slack.enabled) {
    await startSlackListener(repo);
    log.info(`[${repo.name}] Slack integration enabled`);
  } else {
    log.info(`[${repo.name}] Slack not configured`);
  }

  // Start poller for this repo
  startPoller();
  log.info(`[${repo.name}] Poller started`);

  initShutdownHandlers({});

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
