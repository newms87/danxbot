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
    apiKey: process.env.ANTHROPIC_API_KEY || "",
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
  agent: {
    model: optional("CLAUDE_MODEL", "claude-sonnet-4-5"),
    maxTurns: parseInt(optional("MAX_TURNS", "30"), 10),
    maxBudgetUsd: parseFloat(optional("MAX_BUDGET_USD", "1.00")),
  },
  github: {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
  },
  logLevel: optional("LOG_LEVEL", "info"),
  threadsDir: "/flytebot/threads",
} as const;
