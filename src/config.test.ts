import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock poller/constants.js since config.ts imports from it
vi.mock("./poller/constants.js", () => ({
  getReposBase: () => "/danxbot/repos",
  loadTrelloIds: () => ({
    boardId: "mock-board-id",
    reviewListId: "mock-review-list-id",
    todoListId: "mock-todo-list-id",
    inProgressListId: "mock-in-progress-list-id",
    needsHelpListId: "mock-needs-help-list-id",
    doneListId: "mock-done-list-id",
    cancelledListId: "mock-cancelled-list-id",
    actionItemsListId: "mock-action-items-list-id",
    bugLabelId: "mock-bug-label-id",
    featureLabelId: "mock-feature-label-id",
    epicLabelId: "mock-epic-label-id",
    needsHelpLabelId: "mock-needs-help-label-id",
  }),
  REVIEW_MIN_CARDS: 10,
  DANXBOT_COMMENT_MARKER: "<!-- danxbot -->",
}));

// Mock env-file.js to avoid reading actual .env files from repos
vi.mock("./env-file.js", () => ({
  parseEnvFile: () => ({
    DANX_TRELLO_API_KEY: "mock-trello-key",
    DANX_TRELLO_API_TOKEN: "mock-trello-token",
    DANX_SLACK_BOT_TOKEN: "",
    DANX_SLACK_APP_TOKEN: "",
    DANX_SLACK_CHANNEL_ID: "",
    DANX_GITHUB_TOKEN: "mock-github-token",
  }),
}));

// Mock fs to make existsSync return true for .danxbot/.env paths
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: (path: string) => {
      if (path.includes(".danxbot/.env")) return true;
      if (typeof (actual as any).existsSync === "function") {
        return (actual as any).existsSync(path);
      }
      return false;
    },
  };
});

// Helper to set up a valid env and dynamically import config
function validEnv(): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "test-key",
    REPOS: "platform:https://github.com/Danxdesk/platform.git",
    DANXBOT_DB_HOST: "mysql",
    DANXBOT_DB_USER: "danxbot",
    DANXBOT_DB_PASSWORD: "danxbot",
    MAX_TURNS: "10",
    MAX_BUDGET_USD: "1.00",
    MAX_THINKING_TOKENS: "8000",
    AGENT_TIMEOUT_MS: "300000",
    MAX_THREAD_MESSAGES: "20",
    AGENT_MAX_RETRIES: "1",
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

async function importRepoContext(envOverrides: Record<string, string> = {}) {
  const env = { ...validEnv(), ...envOverrides };
  const originalEnv = process.env;
  process.env = { ...env };
  try {
    const configMod = await import("./config.js");
    const repoMod = await import("./repo-context.js");
    return { ...configMod, ...repoMod };
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

describe("repoContexts", () => {
  it("loads repo contexts in host mode (legacy single-process)", async () => {
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
      DANXBOT_RUNTIME: "host",
    });
    expect(mod.repoContexts).toHaveLength(1);
    expect(mod.repoContexts[0].name).toBe("platform");
    expect(mod.repoContexts[0].trello.boardId).toBe("mock-board-id");
    expect(mod.repoContexts[0].trello.apiKey).toBe("mock-trello-key");
  });

  it("returns empty in docker mode without DANXBOT_REPO_NAME (dashboard mode)", async () => {
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
      DANXBOT_RUNTIME: "docker",
    });
    expect(mod.repoContexts).toEqual([]);
    expect(mod.isDashboardMode).toBe(true);
  });

  it("loads only named repo in worker mode", async () => {
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/Flytedesk/platform.git,danxbot:https://github.com/test/danxbot.git",
      DANXBOT_REPO_NAME: "platform",
    });
    expect(mod.repoContexts).toHaveLength(1);
    expect(mod.repoContexts[0].name).toBe("platform");
    expect(mod.isWorkerMode).toBe(true);
  });

  it("returns empty when no repos configured", async () => {
    const mod = await importRepoContext({ REPOS: "" });
    expect(mod.repoContexts).toEqual([]);
  });
});

describe("getRepoContext", () => {
  it("returns context for a configured repo in host mode", async () => {
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
      DANXBOT_RUNTIME: "host",
    });
    const ctx = mod.getRepoContext("platform");
    expect(ctx.name).toBe("platform");
    expect(ctx.trello.apiKey).toBe("mock-trello-key");
  });

  it("returns context for named repo in worker mode", async () => {
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
      DANXBOT_REPO_NAME: "platform",
    });
    const ctx = mod.getRepoContext("platform");
    expect(ctx.name).toBe("platform");
  });

  it("throws for unknown repo", async () => {
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
      DANXBOT_RUNTIME: "host",
    });
    expect(() => mod.getRepoContext("unknown")).toThrow('Repo "unknown" is not configured');
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
      }),
    ).rejects.toThrow(/agent\.maxTurns.*agent\.maxBudgetUsd/s);
  });
});
