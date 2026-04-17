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
import { existsSync } from "node:fs";
import { repos, isWorkerMode, workerRepoName } from "./config.js";

/**
 * Load a single repo's context from its .danxbot/ directory.
 * Reads trello.yml for board IDs and .env for secrets (Slack, Trello API, DB).
 */
function loadRepoContext(repo: RepoConfig): RepoContext {
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

  const dbHost = optEnv("DANX_DB_HOST", "");
  const dbUser = optEnv("DANX_DB_USER", "");
  const dbPassword = optEnv("DANX_DB_PASSWORD", "");
  const dbName = optEnv("DANX_DB_NAME", "");
  const dbEnabled = !!(dbHost && dbUser);

  return {
    name: repo.name,
    url: repo.url,
    localPath: repo.localPath,
    trello: {
      apiKey: reqEnv("DANX_TRELLO_API_KEY"),
      apiToken: reqEnv("DANX_TRELLO_API_TOKEN"),
      ...trelloIds,
    },
    slack: {
      enabled: slackEnabled,
      botToken: slackBotToken,
      appToken: slackAppToken,
      channelId: slackChannelId,
    },
    db: {
      host: dbHost,
      user: dbUser,
      password: dbPassword,
      database: dbName,
      enabled: dbEnabled,
    },
    githubToken: optEnv("DANX_GITHUB_TOKEN", ""),
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
