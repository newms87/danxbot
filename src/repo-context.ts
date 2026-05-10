/**
 * Repo context loading — reads per-repo .danxbot/ config and secrets.
 *
 * Separated from config.ts to keep infrastructure config and repo context
 * loading as distinct concerns.
 */

import type { RepoConfig, RepoContext } from "./types.js";
import { getReposBase, loadTrelloIds } from "./poller/constants.js";
import { parseEnvFile } from "./env-file.js";
import { ISSUE_PREFIX_SHAPE } from "./issue-tracker/yaml.js";
import { loadIssuePrefix } from "./issue-tracker/load-issue-prefix.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { repos, isWorkerMode, workerRepoName, config } from "./config.js";
import { DANXBOT_REPO_HOST_PATH_ENV } from "./agent/portable-path.js";

// Re-export the prefix shape + loader so existing callers (and tests) that
// import them from `repo-context.js` keep compiling. Single source for the
// shape lives in `issue-tracker/yaml.ts`; the loader itself moved to
// `issue-tracker/load-issue-prefix.ts` in Phase 2 of DX-99 so leaf consumers
// (the dashboard reader) can import it without transitively pulling
// `src/config.ts`'s required-env-var checks. Phase 4 of DX-99 retired the
// `DEFAULT_ISSUE_PREFIX` constant + the warn-once-default fallback.
export { ISSUE_PREFIX_SHAPE, loadIssuePrefix };

/**
 * Resolve DANXBOT_WORKER_PORT. Production (deploy): compose injects it from
 * deploy/targets/<target>.yml per-repo `worker_port`, so it arrives as
 * process.env.DANXBOT_WORKER_PORT. Local dev: falls back to the repo's
 * .danxbot/.env — the one place danxbot-owned per-repo config lives. The
 * repo-root `.claude/` is strictly developer territory and danxbot never
 * reads from it (agent-isolation epic, Trello `7ha2CSpc`).
 */
function readWorkerPort(env: Record<string, string>, envPath: string): number {
  const processValue = process.env.DANXBOT_WORKER_PORT;
  if (processValue) return validatePort(processValue, "process.env.DANXBOT_WORKER_PORT");

  const value = env.DANXBOT_WORKER_PORT;
  if (!value) {
    throw new Error(
      `Missing DANXBOT_WORKER_PORT in ${envPath}. Add \`DANXBOT_WORKER_PORT=<port>\` or set it in the process env.`,
    );
  }
  return validatePort(value, envPath);
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
 *
 * Only the identity fields (`name`, `url`, `localPath`) are read off the
 * input — `workerPort` is sourced from the per-repo `.danxbot/.env`
 * (the authoritative runtime source via `readWorkerPort`), not from any
 * RepoConfig the caller might pass in. Typed as `Pick<...>` so worker
 * mode can construct an identity stub without inventing a workerPort
 * placeholder it doesn't need.
 */
export function loadRepoContext(
  repo: Pick<RepoConfig, "name" | "url" | "localPath">,
): RepoContext {
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

  // Canonical repo path (DX-230). In container runtime the per-repo
  // compose.yml MUST inject DANXBOT_REPO_HOST_PATH (worker-env.sh
  // exports it from DANXBOT_REPO_ROOT, compose passes it through), so
  // a missing value here = misconfig and we fail loud. On host runtime
  // localPath IS the host abs path — they're the same string.
  const envHostPath = process.env[DANXBOT_REPO_HOST_PATH_ENV];
  if (!config.isHost && !envHostPath) {
    throw new Error(
      `Missing required environment variable '${DANXBOT_REPO_HOST_PATH_ENV}' (container runtime). The per-repo compose.yml must pass it through — see src/agent/portable-path.ts.`,
    );
  }
  const hostPath = envHostPath || repo.localPath;

  return {
    name: repo.name,
    url: repo.url,
    localPath: repo.localPath,
    hostPath,
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
    workerPort: readWorkerPort(env, envPath),
    issuePrefix: loadIssuePrefix(repo.localPath),
  };
}

/**
 * All loaded repo contexts. Loaded at startup.
 *
 * Worker mode: loads only the named repo's context (one entry).
 * Dashboard mode: empty — dashboard reads repo names from the active
 * deploy target (`deploy/targets/<DANXBOT_TARGET>.yml`) or the database,
 * not from filesystem-loaded contexts.
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
