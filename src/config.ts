import type { ComplexityLevel, ComplexityProfile, RepoConfig } from "./types.js";

export const COMPLEXITY_PROFILES: Record<ComplexityLevel, ComplexityProfile> = {
  very_low:  { model: "claude-haiku-4-5",   maxTurns: 5,  maxBudgetUsd: 0.10, maxThinkingTokens: 2048,  systemPrompt: "fast" },
  low:       { model: "claude-haiku-4-5",   maxTurns: 6,  maxBudgetUsd: 0.20, maxThinkingTokens: 4096,  systemPrompt: "fast" },
  medium:    { model: "claude-sonnet-4-5",  maxTurns: 8,  maxBudgetUsd: 0.50, maxThinkingTokens: 8192,  systemPrompt: "full" },
  high:      { model: "claude-sonnet-4-5",  maxTurns: 12, maxBudgetUsd: 1.00, maxThinkingTokens: 8192,  systemPrompt: "full" },
  very_high: { model: "claude-opus-4-6",    maxTurns: 18, maxBudgetUsd: 5.00, maxThinkingTokens: 32768, systemPrompt: "full" },
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function parseRepos(envValue: string): RepoConfig[] {
  if (!envValue.trim()) return [];
  return envValue.split(",").map((entry) => {
    const colonIndex = entry.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(`Invalid REPOS entry "${entry}" — expected "name:url" format`);
    }
    const name = entry.slice(0, colonIndex).trim();
    const url = entry.slice(colonIndex + 1).trim();
    if (!name || !url) {
      throw new Error(`Invalid REPOS entry "${entry}" — name and url must not be empty`);
    }
    return { name, url, localPath: `/flytebot/repos/${name}` };
  });
}

export const repos: RepoConfig[] = parseRepos(optional("REPOS", ""));

export function getRepoPath(name: string): string {
  const repo = repos.find((r) => r.name === name);
  if (!repo) {
    throw new Error(`Repo "${name}" is not configured in REPOS env var`);
  }
  return repo.localPath;
}

const slackBotToken = optional("SLACK_BOT_TOKEN", "");
const slackAppToken = optional("SLACK_APP_TOKEN", "");
const slackChannelId = optional("SLACK_CHANNEL_ID", "");
const slackEnabled = !!(slackBotToken && slackAppToken && slackChannelId);

export const config = {
  slack: {
    enabled: slackEnabled,
    botToken: slackBotToken,
    appToken: slackAppToken,
    channelId: slackChannelId,
  },
  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
  },
  platform: {
    db: {
      host: optional("PLATFORM_DB_HOST", ""),
      user: optional("PLATFORM_DB_USER", ""),
      password: optional("PLATFORM_DB_PASSWORD", ""),
      database: optional("PLATFORM_DB_NAME", ""),
      enabled: !!(process.env.PLATFORM_DB_HOST && process.env.PLATFORM_DB_USER),
    },
  },
  db: {
    host: required("FLYTEBOT_DB_HOST"),
    user: required("FLYTEBOT_DB_USER"),
    password: required("FLYTEBOT_DB_PASSWORD"),
    database: optional("FLYTEBOT_DB_NAME", "flytebot_chat"),
    connectTimeoutMs: parseInt(optional("DB_CONNECT_TIMEOUT_MS", "5000"), 10),
    eventsMaxAgeDays: parseInt(optional("EVENTS_MAX_AGE_DAYS", "30"), 10),
  },
  agent: {
    model: optional("CLAUDE_MODEL", "claude-sonnet-4-5"),
    maxTurns: parseInt(optional("MAX_TURNS", "10"), 10),
    maxBudgetUsd: parseFloat(optional("MAX_BUDGET_USD", "1.00")),
    maxThinkingTokens: parseInt(optional("MAX_THINKING_TOKENS", "8000"), 10),
    timeoutMs: parseInt(optional("AGENT_TIMEOUT_MS", "300000"), 10),
    maxThreadMessages: parseInt(optional("MAX_THREAD_MESSAGES", "20"), 10),
    maxRetries: Math.max(0, parseInt(optional("AGENT_MAX_RETRIES", "1"), 10)),
  },
  github: {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
  },
  trello: {
    apiKey: process.env.TRELLO_API_KEY || "",
    apiToken: process.env.TRELLO_API_TOKEN || "",
    boardId: process.env.TRELLO_BOARD_ID || "",
    reviewListId: process.env.TRELLO_REVIEW_LIST_ID || "",
    todoListId: process.env.TRELLO_TODO_LIST_ID || "",
    bugLabelId: process.env.TRELLO_BUG_LABEL_ID || "",
    needsHelpListId: process.env.TRELLO_NEEDS_HELP_LIST_ID || "",
    needsHelpLabelId: process.env.TRELLO_NEEDS_HELP_LABEL_ID || "",
  },
  rateLimitSeconds: parseInt(optional("RATE_LIMIT_SECONDS", "30"), 10),
  logLevel: optional("LOG_LEVEL", "info"),
  logsDir: "/flytebot/logs",
} as const;

interface NumericRule {
  path: string;
  value: number;
  min: number;
  exclusive: boolean;
}

export function validateConfig(): void {
  if (!/^[a-zA-Z0-9_]+$/.test(config.db.database)) {
    throw new Error(`Invalid database name: ${config.db.database} (must be alphanumeric/underscores only)`);
  }

  const rules: NumericRule[] = [
    { path: "agent.maxTurns", value: config.agent.maxTurns, min: 1, exclusive: false },
    { path: "agent.maxBudgetUsd", value: config.agent.maxBudgetUsd, min: 0, exclusive: true },
    { path: "agent.maxThinkingTokens", value: config.agent.maxThinkingTokens, min: 1, exclusive: false },
    { path: "agent.timeoutMs", value: config.agent.timeoutMs, min: 1, exclusive: false },
    { path: "agent.maxThreadMessages", value: config.agent.maxThreadMessages, min: 1, exclusive: false },
    { path: "agent.maxRetries", value: config.agent.maxRetries, min: 0, exclusive: false },
    { path: "rateLimitSeconds", value: config.rateLimitSeconds, min: 1, exclusive: false },
    { path: "db.connectTimeoutMs", value: config.db.connectTimeoutMs, min: 1, exclusive: false },
    { path: "db.eventsMaxAgeDays", value: config.db.eventsMaxAgeDays, min: 1, exclusive: false },
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
