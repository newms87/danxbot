import type {
  ComplexityLevel,
  ComplexityProfile,
  RepoConfig,
  RepoContext,
  TrelloConfig,
} from "./types.js";
import { getReposBase, loadTrelloIds } from "./poller/constants.js";
import { required, optional } from "./env.js";
import { parseEnvFile } from "./env-file.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export const COMPLEXITY_PROFILES: Record<ComplexityLevel, ComplexityProfile> = {
  very_low: {
    model: "claude-haiku-4-5",
    maxTurns: 8,
    maxBudgetUsd: 0.5,
    maxThinkingTokens: 2048,
    systemPrompt: "fast",
  },
  low: {
    model: "claude-haiku-4-5",
    maxTurns: 12,
    maxBudgetUsd: 1.0,
    maxThinkingTokens: 4096,
    systemPrompt: "fast",
  },
  medium: {
    model: "claude-sonnet-4-6",
    maxTurns: 16,
    maxBudgetUsd: 2.0,
    maxThinkingTokens: 8192,
    systemPrompt: "full",
  },
  high: {
    model: "claude-sonnet-4-6",
    maxTurns: 24,
    maxBudgetUsd: 5.0,
    maxThinkingTokens: 8192,
    systemPrompt: "full",
  },
  very_high: {
    model: "claude-opus-4-6",
    maxTurns: 30,
    maxBudgetUsd: 10.0,
    maxThinkingTokens: 32768,
    systemPrompt: "full",
  },
};

function parseRepos(envValue: string): RepoConfig[] {
  if (!envValue.trim()) return [];
  return envValue.split(",").map((entry) => {
    const colonIndex = entry.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(
        `Invalid REPOS entry "${entry}" — expected "name:url" format`,
      );
    }
    const name = entry.slice(0, colonIndex).trim();
    const url = entry.slice(colonIndex + 1).trim();
    if (!name || !url) {
      throw new Error(
        `Invalid REPOS entry "${entry}" — name and url must not be empty`,
      );
    }
    return { name, url, localPath: `${getReposBase()}/${name}` };
  });
}

export const repos: RepoConfig[] = parseRepos(optional("REPOS", ""));

/**
 * Worker mode: DANXBOT_REPO_NAME is set — this process manages one repo only
 * (poller, Slack listener, dispatch API). Dashboard is not started.
 *
 * Dashboard mode: DANXBOT_REPO_NAME is not set — this process runs the shared
 * dashboard, migrations, and cleanup. No poller or Slack.
 */
export const workerRepoName = optional("DANXBOT_REPO_NAME", "");
export const isWorkerMode = !!workerRepoName;
export const isDashboardMode = !isWorkerMode;

export function getRepoPath(name: string): string {
  const repo = repos.find((r) => r.name === name);
  if (!repo) {
    throw new Error(`Repo "${name}" is not configured in REPOS env var`);
  }
  return repo.localPath;
}

const runtime = optional("DANXBOT_RUNTIME", "docker") as "docker" | "host";
if (runtime !== "docker" && runtime !== "host") {
  throw new Error(
    `DANXBOT_RUNTIME must be "docker" or "host" (got "${runtime}")`,
  );
}
const isHost = runtime === "host";

/**
 * Shared infrastructure config — NOT per-repo.
 * Per-repo config (trello, slack, db) lives in RepoContext.
 */
export const config = {
  runtime,
  isHost,
  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY", ""),
  },
  db: {
    host: required("DANXBOT_DB_HOST"),
    port: parseInt(optional("DANXBOT_DB_INTERNAL_PORT", "3306"), 10),
    user: required("DANXBOT_DB_USER"),
    password: required("DANXBOT_DB_PASSWORD"),
    database: optional("DANXBOT_DB_NAME", "danxbot_chat"),
    connectTimeoutMs: parseInt(optional("DB_CONNECT_TIMEOUT_MS", "5000"), 10),
    eventsMaxAgeDays: parseInt(optional("EVENTS_MAX_AGE_DAYS", "30"), 10),
  },
  agent: {
    model: optional("CLAUDE_MODEL", "claude-sonnet-4-6"),
    routerModel: optional("CLAUDE_ROUTER_MODEL", "claude-haiku-4-5-20251001"),
    maxTurns: parseInt(optional("MAX_TURNS", "10"), 10),
    maxBudgetUsd: parseFloat(optional("MAX_BUDGET_USD", "1.00")),
    maxThinkingTokens: parseInt(optional("MAX_THINKING_TOKENS", "8000"), 10),
    timeoutMs: parseInt(optional("AGENT_TIMEOUT_MS", "300000"), 10),
    maxThreadMessages: parseInt(optional("MAX_THREAD_MESSAGES", "20"), 10),
    maxRetries: Math.max(0, parseInt(optional("AGENT_MAX_RETRIES", "1"), 10)),
  },
  github: {
    webhookSecret: optional("GITHUB_WEBHOOK_SECRET", ""),
  },
  dispatch: {
    defaultApiUrl: optional("DEFAULT_API_URL", "http://localhost:80"),
    agentTimeoutMs:
      parseInt(optional("DISPATCH_AGENT_TIMEOUT", "3600"), 10) * 1000,
  },
  logLevel: optional("LOG_LEVEL", "info"),
  logsDir: optional("DANXBOT_LOGS_DIR", isHost ? "./logs" : "/danxbot/logs"),
  pollerIntervalMs: parseInt(optional("POLLER_INTERVAL_MS", "60000"), 10),
  pollerEnabled: optional("POLLER_ENABLED", "true") === "true",
  pollerBackoffScheduleMs: [60_000, 300_000, 900_000, 1_800_000] as readonly number[],
} as const;

interface NumericRule {
  path: string;
  value: number;
  min: number;
  exclusive: boolean;
}

export function validateConfig(): void {
  if (!/^[a-zA-Z0-9_]+$/.test(config.db.database)) {
    throw new Error(
      `Invalid database name: ${config.db.database} (must be alphanumeric/underscores only)`,
    );
  }

  const rules: NumericRule[] = [
    {
      path: "agent.maxTurns",
      value: config.agent.maxTurns,
      min: 1,
      exclusive: false,
    },
    {
      path: "agent.maxBudgetUsd",
      value: config.agent.maxBudgetUsd,
      min: 0,
      exclusive: true,
    },
    {
      path: "agent.maxThinkingTokens",
      value: config.agent.maxThinkingTokens,
      min: 1,
      exclusive: false,
    },
    {
      path: "agent.timeoutMs",
      value: config.agent.timeoutMs,
      min: 1,
      exclusive: false,
    },
    {
      path: "agent.maxThreadMessages",
      value: config.agent.maxThreadMessages,
      min: 1,
      exclusive: false,
    },
    {
      path: "agent.maxRetries",
      value: config.agent.maxRetries,
      min: 0,
      exclusive: false,
    },
    {
      path: "db.connectTimeoutMs",
      value: config.db.connectTimeoutMs,
      min: 1,
      exclusive: false,
    },
    {
      path: "db.eventsMaxAgeDays",
      value: config.db.eventsMaxAgeDays,
      min: 1,
      exclusive: false,
    },
  ];

  const errors: string[] = [];

  for (const rule of rules) {
    if (!Number.isFinite(rule.value)) {
      errors.push(`${rule.path} must be a finite number (got ${rule.value})`);
    } else if (rule.exclusive && rule.value <= rule.min) {
      errors.push(`${rule.path} must be > ${rule.min} (got ${rule.value})`);
    } else if (!rule.exclusive && rule.value < rule.min) {
      errors.push(`${rule.path} must be >= ${rule.min} (got ${rule.value})`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config:\n  - ${errors.join("\n  - ")}`);
  }
}

validateConfig();

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
 * Load RepoContext for all configured repos.
 * Each repo must have .danxbot/config/trello.yml and .danxbot/.env.
 */
export function loadRepoContexts(): RepoContext[] {
  return repos.map(loadRepoContext);
}

/**
 * All loaded repo contexts. Loaded at startup.
 *
 * Worker mode: loads only the named repo's context (one entry).
 * Dashboard mode: empty — dashboard reads repo names from REPOS env var
 * or the database, not from filesystem-loaded contexts.
 * Legacy mode (no DANXBOT_REPO_NAME, REPOS set): loads all repos (backwards compat for tests/host).
 */
function loadActiveRepoContexts(): RepoContext[] {
  if (isWorkerMode) {
    // Worker: load only the named repo
    const existing = repos.find((r) => r.name === workerRepoName);
    const repo = existing || { name: workerRepoName, url: "", localPath: `${getReposBase()}/${workerRepoName}` };
    return [loadRepoContext(repo)];
  }
  // Dashboard mode or no repos: don't load repo contexts
  // Legacy host mode (REPOS set, no DANXBOT_REPO_NAME): load all for backwards compat
  if (repos.length > 0 && runtime === "host") {
    return loadRepoContexts();
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
