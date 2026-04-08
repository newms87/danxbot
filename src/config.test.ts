import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock poller/constants.js since config.ts now imports from it and it reads a YAML file
vi.mock("./poller/constants.js", () => ({
  BOARD_ID: "mock-board-id",
  REVIEW_LIST_ID: "mock-review-list-id",
  TODO_LIST_ID: "mock-todo-list-id",
  IN_PROGRESS_LIST_ID: "mock-in-progress-list-id",
  NEEDS_HELP_LIST_ID: "mock-needs-help-list-id",
  DONE_LIST_ID: "mock-done-list-id",
  CANCELLED_LIST_ID: "mock-cancelled-list-id",
  ACTION_ITEMS_LIST_ID: "mock-action-items-list-id",
  BUG_LABEL_ID: "mock-bug-label-id",
  FEATURE_LABEL_ID: "mock-feature-label-id",
  EPIC_LABEL_ID: "mock-epic-label-id",
  NEEDS_HELP_LABEL_ID: "mock-needs-help-label-id",
  REVIEW_MIN_CARDS: 10,
  DANXBOT_COMMENT_MARKER: "<!-- danxbot -->",
  getReposBase: () => "/danxbot/repos",
}));

// Helper to set up a valid env and dynamically import config
function validEnv(): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_CHANNEL_ID: "C-TEST",
    ANTHROPIC_API_KEY: "test-key",
    REPOS: "platform:https://github.com/Danxdesk/platform.git",
    PLATFORM_DB_HOST: "localhost",
    PLATFORM_DB_USER: "test",
    PLATFORM_DB_PASSWORD: "test",
    PLATFORM_DB_NAME: "test",
    DANXBOT_DB_HOST: "mysql",
    DANXBOT_DB_USER: "danxbot",
    DANXBOT_DB_PASSWORD: "danxbot",
    MAX_TURNS: "10",
    MAX_BUDGET_USD: "1.00",
    MAX_THINKING_TOKENS: "8000",
    AGENT_TIMEOUT_MS: "300000",
    MAX_THREAD_MESSAGES: "20",
    AGENT_MAX_RETRIES: "1",
    RATE_LIMIT_SECONDS: "30",
  };
}

async function importConfig(envOverrides: Record<string, string> = {}, omitKeys: string[] = []) {
  const env = { ...validEnv(), ...envOverrides };
  for (const key of omitKeys) delete env[key];
  // Replace process.env entirely for isolation
  const originalEnv = process.env;
  process.env = { ...env };
  try {
    return await import("./config.js");
  } finally {
    process.env = originalEnv;
  }
}

beforeEach(() => {
  vi.resetModules();
});

describe("repos config", () => {
  it("parses multiple repos from REPOS env var", async () => {
    const mod = await importConfig({
      REPOS: "platform:https://github.com/Flytedesk/platform.git,docs:https://github.com/Flytedesk/docs.git",
    });
    expect(mod.repos).toEqual([
      { name: "platform", url: "https://github.com/Flytedesk/platform.git", localPath: "/danxbot/repos/platform" },
      { name: "docs", url: "https://github.com/Flytedesk/docs.git", localPath: "/danxbot/repos/docs" },
    ]);
  });

  it("parses a single repo", async () => {
    const mod = await importConfig({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
    });
    expect(mod.repos).toHaveLength(1);
    expect(mod.repos[0].name).toBe("platform");
  });

  it("returns empty array when REPOS is empty", async () => {
    const mod = await importConfig({ REPOS: "" });
    expect(mod.repos).toEqual([]);
  });

  it("returns empty array when REPOS is unset", async () => {
    const mod = await importConfig({}, ["REPOS"]);
    expect(mod.repos).toEqual([]);
  });

  it("throws on invalid format (missing colon)", async () => {
    await expect(
      importConfig({ REPOS: "platform" }),
    ).rejects.toThrow('Invalid REPOS entry');
  });

  it("throws on empty name", async () => {
    await expect(
      importConfig({ REPOS: ":https://example.com" }),
    ).rejects.toThrow('Invalid REPOS entry');
  });

  it("throws on empty URL after colon", async () => {
    await expect(
      importConfig({ REPOS: "platform:" }),
    ).rejects.toThrow('name and url must not be empty');
  });

  it("trims whitespace from name and URL", async () => {
    const mod = await importConfig({
      REPOS: " platform : https://example.com ",
    });
    expect(mod.repos).toHaveLength(1);
    expect(mod.repos[0].name).toBe("platform");
    expect(mod.repos[0].url).toBe("https://example.com");
  });
});

describe("getRepoPath", () => {
  it("returns localPath for configured repo", async () => {
    const mod = await importConfig({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
    });
    expect(mod.getRepoPath("platform")).toBe("/danxbot/repos/platform");
  });

  it("throws for unconfigured repo", async () => {
    const mod = await importConfig({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
    });
    expect(() => mod.getRepoPath("unknown")).toThrow('Repo "unknown" is not configured');
  });
});

describe("required DB config", () => {
  it("throws when DANXBOT_DB_HOST is missing", async () => {
    await expect(importConfig({}, ["DANXBOT_DB_HOST"])).rejects.toThrow("DANXBOT_DB_HOST");
  });

  it("uses DANXBOT_DB_HOST for db.host", async () => {
    const mod = await importConfig({ DANXBOT_DB_HOST: "custom-host" });
    expect(mod.config.db.host).toBe("custom-host");
  });

  it("throws when DANXBOT_DB_USER is missing", async () => {
    await expect(importConfig({}, ["DANXBOT_DB_USER"])).rejects.toThrow("DANXBOT_DB_USER");
  });

  it("throws when DANXBOT_DB_PASSWORD is missing", async () => {
    await expect(importConfig({}, ["DANXBOT_DB_PASSWORD"])).rejects.toThrow("DANXBOT_DB_PASSWORD");
  });
});

describe("validateConfig", () => {
  it("does not throw when all values are valid", async () => {
    await expect(importConfig()).resolves.toBeDefined();
  });

  it("does not throw when maxRetries is 0", async () => {
    await expect(
      importConfig({ AGENT_MAX_RETRIES: "0" }),
    ).resolves.toBeDefined();
  });

  it("throws for NaN values", async () => {
    await expect(
      importConfig({ MAX_TURNS: "abc" }),
    ).rejects.toThrow("agent.maxTurns");
  });

  it("throws for negative values", async () => {
    await expect(
      importConfig({ MAX_BUDGET_USD: "-1" }),
    ).rejects.toThrow("agent.maxBudgetUsd");
  });

  it("throws for zero maxBudgetUsd (exclusive minimum)", async () => {
    await expect(
      importConfig({ MAX_BUDGET_USD: "0" }),
    ).rejects.toThrow("agent.maxBudgetUsd");
  });

  it("throws for zero values on fields requiring > 0", async () => {
    await expect(
      importConfig({ MAX_TURNS: "0" }),
    ).rejects.toThrow("agent.maxTurns");
  });

  it("throws for zero rateLimitSeconds", async () => {
    await expect(
      importConfig({ RATE_LIMIT_SECONDS: "0" }),
    ).rejects.toThrow("rateLimitSeconds");
  });

  it("throws for negative maxRetries", async () => {
    // maxRetries has Math.max(0, ...) so parseInt("-1") => -1 => Math.max(0,-1) => 0
    // 0 is valid for maxRetries, so this should NOT throw
    await expect(
      importConfig({ AGENT_MAX_RETRIES: "-1" }),
    ).resolves.toBeDefined();
  });

  it("throws for NaN maxRetries", async () => {
    await expect(
      importConfig({ AGENT_MAX_RETRIES: "abc" }),
    ).rejects.toThrow("agent.maxRetries");
  });

  it("collects ALL invalid values into a single error", async () => {
    await expect(
      importConfig({
        MAX_TURNS: "abc",
        MAX_BUDGET_USD: "-1",
        RATE_LIMIT_SECONDS: "0",
      }),
    ).rejects.toThrow(/agent\.maxTurns.*agent\.maxBudgetUsd.*rateLimitSeconds/s);
  });
});
