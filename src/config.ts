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

export const config = {
  slack: {
    botToken: required("SLACK_BOT_TOKEN"),
    appToken: required("SLACK_APP_TOKEN"),
    channelId: required("SLACK_CHANNEL_ID"),
  },
  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
  },
  platform: {
    repoUrl: required("PLATFORM_REPO_URL"),
    repoPath: "/flytebot/platform",
    db: {
      host: required("PLATFORM_DB_HOST"),
      user: required("PLATFORM_DB_USER"),
      password: required("PLATFORM_DB_PASSWORD"),
      database: required("PLATFORM_DB_NAME"),
    },
  },
  db: {
    host: process.env.FLYTEBOT_DB_HOST || process.env.PLATFORM_DB_HOST || "",
    user: process.env.FLYTEBOT_DB_USER || process.env.PLATFORM_DB_USER || "",
    password: process.env.FLYTEBOT_DB_PASSWORD || process.env.PLATFORM_DB_PASSWORD || "",
    database: optional("FLYTEBOT_DB_NAME", "flytebot_chat"),
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
    boardId: "698fc5b8847b787a3818ad82",
    todoListId: "698fc5be16a280cc321a13ec",
    bugLabelId: "698fc5b8847b787a3818adac",
  },
  rateLimitSeconds: parseInt(optional("RATE_LIMIT_SECONDS", "30"), 10),
  logLevel: optional("LOG_LEVEL", "info"),
  threadsDir: "/flytebot/threads",
  logsDir: "/flytebot/logs",
  eventsFile: optional("EVENTS_FILE", "/flytebot/data/events.json"),
} as const;

interface NumericRule {
  path: string;
  value: number;
  min: number;
  exclusive: boolean;
}

export function validateConfig(): void {
  if (config.db.database && !/^[a-zA-Z0-9_]+$/.test(config.db.database)) {
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
