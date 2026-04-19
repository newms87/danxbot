/**
 * Repo context loading — reads per-repo .danxbot/ config and secrets.
 *
 * Separated from config.ts to keep infrastructure config and repo context
 * loading as distinct concerns.
 */

import type { RepoConfig, RepoContext } from "./types.js";
import { getReposBase, loadTrelloIds } from "./poller/constants.js";
import { parseEnvFile } from "./env-file.js";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { repos, isWorkerMode, workerRepoName, config } from "./config.js";

/**
 * Resolve DANXBOT_WORKER_PORT. Production (deploy): compose injects it from
 * .danxbot/deployments/<target>.yml per-repo `worker_port`, so it arrives as
 * process.env.DANXBOT_WORKER_PORT and settings.local.json is never required.
 * Local dev: falls back to <repo>/.claude/settings.local.json env block so
 * host runtime and MCP tools continue to source it from one place.
 */
function readWorkerPort(repoLocalPath: string): number {
  const envValue = process.env.DANXBOT_WORKER_PORT;
  if (envValue) return validatePort(envValue, "process.env.DANXBOT_WORKER_PORT");

  const settingsPath = resolve(repoLocalPath, ".claude/settings.local.json");
  if (!existsSync(settingsPath)) {
    throw new Error(
      `Missing ${settingsPath}. Add {"env": {"DANXBOT_WORKER_PORT": "<port>"}} to configure the worker port, or set DANXBOT_WORKER_PORT in the process env.`,
    );
  }
  const raw = readFileSync(settingsPath, "utf-8");
  const parsed = JSON.parse(raw) as { env?: Record<string, string> };
  const value = parsed?.env?.DANXBOT_WORKER_PORT;
  if (!value) {
    throw new Error(
      `Missing env.DANXBOT_WORKER_PORT in ${settingsPath}`,
    );
  }
  return validatePort(value, settingsPath);
}

function validatePort(value: string, source: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid DANXBOT_WORKER_PORT "${value}" from ${source} — must be an integer 1-65535`,
    );
  }
  return port;
}

/**
 * A "docker service name" is a bare alphanumeric/hyphen hostname with no
 * dots, colons, or numeric IP pattern — the kind docker-compose generates.
 * These names are unreachable from the host; the caller translates them to
 * 127.0.0.1 when the worker runs on host (ports are exposed via compose).
 */
function isDockerServiceName(host: string): boolean {
  if (!host) return false;
  if (host === "localhost") return false;
  if (host.includes(".")) return false;       // FQDN or IPv4
  if (host.includes(":")) return false;       // IPv6 literal
  return true;
}

/**
 * Load a single repo's context from its .danxbot/ directory.
 * Reads trello.yml for board IDs and .env for secrets (Slack, Trello API, DB).
 */
export function loadRepoContext(repo: RepoConfig): RepoContext {
  const envPath = resolve(repo.localPath, ".danxbot/.env");
  if (!existsSync(envPath)) {
    throw new Error(
      `Per-repo .env not found at ${envPath}. Create ${repo.name}/.danxbot/.env with DANX_* variables.`,
    );
  }
  const env = parseEnvFile(envPath);

  function reqEnv(key: string): string {
    const value = env[key];
    if (!value) {
      throw new Error(
        `Missing required variable '${key}' in ${envPath}`,
      );
    }
    return value;
  }

  function optEnv(key: string, fallback: string): string {
    return env[key] || fallback;
  }

  const trelloIds = loadTrelloIds(repo.localPath);

  const slackBotToken = optEnv("DANX_SLACK_BOT_TOKEN", "");
  const slackAppToken = optEnv("DANX_SLACK_APP_TOKEN", "");
  const slackChannelId = optEnv("DANX_SLACK_CHANNEL_ID", "");
  const slackEnabled = !!(slackBotToken && slackAppToken && slackChannelId);

  const rawDbHost = optEnv("DANX_DB_HOST", "");
  const dbPort = parseInt(optEnv("DANX_DB_PORT", "3306"), 10);
  // Docker service names (e.g. "ssap-mysql-1") are unreachable from the
  // host. When running on host, translate them to 127.0.0.1 — docker-compose
  // exposes the same port on localhost. One deterministic rule, no fallback.
  const dbHost = config.isHost && isDockerServiceName(rawDbHost)
    ? "127.0.0.1"
    : rawDbHost;
  const dbUser = optEnv("DANX_DB_USER", "");
  const dbPassword = optEnv("DANX_DB_PASSWORD", "");
  const dbName = optEnv("DANX_DB_NAME", "");
  const dbEnabled = !!(rawDbHost && dbUser);

  return {
    name: repo.name,
    url: repo.url,
    localPath: repo.localPath,
    trello: {
      apiKey: reqEnv("DANX_TRELLO_API_KEY"),
      apiToken: reqEnv("DANX_TRELLO_API_TOKEN"),
      ...trelloIds,
    },
    trelloEnabled: optEnv("DANX_TRELLO_ENABLED", "false") === "true",
    slack: {
      enabled: slackEnabled,
      botToken: slackBotToken,
      appToken: slackAppToken,
      channelId: slackChannelId,
    },
    db: {
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPassword,
      database: dbName,
      enabled: dbEnabled,
    },
    githubToken: optEnv("DANX_GITHUB_TOKEN", ""),
    workerPort: readWorkerPort(repo.localPath),
  };
}

/**
 * All loaded repo contexts. Loaded at startup.
 *
 * Worker mode: loads only the named repo's context (one entry).
 * Dashboard mode: empty — dashboard reads repo names from REPOS env var
 * or the database, not from filesystem-loaded contexts.
 */
function loadActiveRepoContexts(): RepoContext[] {
  if (isWorkerMode) {
    const existing = repos.find((r) => r.name === workerRepoName);
    const repo = existing || { name: workerRepoName, url: "", localPath: `${getReposBase()}/${workerRepoName}` };
    return [loadRepoContext(repo)];
  }
  return [];
}

export const repoContexts: RepoContext[] = loadActiveRepoContexts();

/**
 * Get a specific repo's context by name. Throws if not found.
 */
export function getRepoContext(name: string): RepoContext {
  const ctx = repoContexts.find((r) => r.name === name);
  if (!ctx) {
    throw new Error(`Repo "${name}" is not configured or not loaded`);
  }
  return ctx;
}
