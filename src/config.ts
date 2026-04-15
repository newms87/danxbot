import type { RepoConfig } from "./types.js";
import { getReposBase } from "./poller/constants.js";
import { required, optional } from "./env.js";

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

const runtimeValue = optional("DANXBOT_RUNTIME", "docker") as "docker" | "host";
if (runtimeValue !== "docker" && runtimeValue !== "host") {
  throw new Error(
    `DANXBOT_RUNTIME must be "docker" or "host" (got "${runtimeValue}")`,
  );
}
const isHost = runtimeValue === "host";

/**
 * Shared infrastructure config — NOT per-repo.
 * Per-repo config (trello, slack, db) lives in RepoContext.
 */
export const config = {
  runtime: runtimeValue,
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
