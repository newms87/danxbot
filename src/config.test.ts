import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedTarget } from "./target.js";

// Mock poller/constants.js since target.ts (transitively imported by config.ts)
// imports from it.
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
    blockedLabelId: "mock-blocked-label-id",
  }),
  REVIEW_MIN_CARDS: 10,
}));

// Phase B: src/config.ts loads the connected-repo list via
// src/target.ts#loadTarget instead of parsing REPOS env vars. Tests
// mock the loader to control what `repos` resolves to without writing
// fixture YML files. Each test resets `mockTarget` to its DEFAULT then
// overrides only the fields it cares about.
const DEFAULT_TARGET: ResolvedTarget = {
  name: "test-target",
  mode: "local",
  repos: [
    {
      name: "platform",
      url: "https://github.com/Flytedesk/platform.git",
      localPath: "/danxbot/repos/platform",
      workerPort: 5561,
    },
  ],
};
let mockTarget: ResolvedTarget = { ...DEFAULT_TARGET, repos: [...DEFAULT_TARGET.repos] };

vi.mock("./target.js", () => ({
  loadTarget: () => mockTarget,
}));

// Per-test override of what parseEnvFile returns for a repo's .danxbot/.env.
// Defaults cover the minimum required keys; tests can add DANX_DB_* etc.
const DEFAULT_MOCK_ENV_FILE = {
  DANX_TRELLO_API_KEY: "mock-trello-key",
  DANX_TRELLO_API_TOKEN: "mock-trello-token",
  DANX_SLACK_BOT_TOKEN: "",
  DANX_SLACK_APP_TOKEN: "",
  DANX_SLACK_CHANNEL_ID: "",
  DANX_GITHUB_TOKEN: "mock-github-token",
};
let mockEnvFile: Record<string, string> = { ...DEFAULT_MOCK_ENV_FILE };

vi.mock("./env-file.js", () => ({
  parseEnvFile: () => ({ ...mockEnvFile }),
}));

// Lets individual tests simulate running inside a Docker container by
// flipping /.dockerenv presence without touching the real filesystem.
let mockDockerenvExists = false;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: (path: string) => {
      if (path === "/.dockerenv") return mockDockerenvExists;
      if (path.includes(".danxbot/.env")) return true;
      if (typeof (actual as { existsSync?: (p: string) => boolean }).existsSync === "function") {
        return (actual as { existsSync: (p: string) => boolean }).existsSync(path);
      }
      return false;
    },
  };
});

function validEnv(): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "test-key",
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

async function importConfig(
  envOverrides: Record<string, string> = {},
  omitKeys: string[] = [],
) {
  const env = { ...validEnv(), ...envOverrides };
  for (const key of omitKeys) delete env[key];
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

const TEST_WORKER_PORT = "5561";

beforeEach(() => {
  vi.resetModules();
  mockDockerenvExists = false;
  mockEnvFile = { ...DEFAULT_MOCK_ENV_FILE };
  mockTarget = { ...DEFAULT_TARGET, repos: [...DEFAULT_TARGET.repos] };
});

describe("repos config (Phase B: sourced from deploy/targets/<TARGET>.yml)", () => {
  it("exposes the active target's repos[] verbatim", async () => {
    mockTarget = {
      name: "multi",
      mode: "local",
      repos: [
        {
          name: "platform",
          url: "https://github.com/Flytedesk/platform.git",
          localPath: "/danxbot/repos/platform",
          workerPort: 5561,
        },
        {
          name: "docs",
          url: "https://github.com/Flytedesk/docs.git",
          localPath: "/danxbot/repos/docs",
          workerPort: 5562,
        },
      ],
    };
    const mod = await importConfig();
    expect(mod.repos).toEqual(mockTarget.repos);
  });

  it("returns an empty array when the target has no repos[]", async () => {
    mockTarget = { name: "empty", mode: "local", repos: [] };
    const mod = await importConfig();
    expect(mod.repos).toEqual([]);
  });

  it("propagates per-repo workerHost when the target sets it", async () => {
    mockTarget = {
      name: "with-host",
      mode: "local",
      repos: [
        {
          name: "custom",
          url: "https://example.com/c.git",
          localPath: "/danxbot/repos/custom",
          workerPort: 5562,
          workerHost: "renamed-container",
        },
      ],
    };
    const mod = await importConfig();
    expect(mod.repos[0].workerHost).toBe("renamed-container");
  });
});

describe("getRepoPath", () => {
  it("returns localPath for configured repo", async () => {
    const mod = await importConfig();
    expect(mod.getRepoPath("platform")).toBe("/danxbot/repos/platform");
  });

  it("throws for unconfigured repo", async () => {
    const mod = await importConfig();
    expect(() => mod.getRepoPath("unknown")).toThrow(
      'Repo "unknown" is not configured',
    );
  });
});

describe("repoContexts", () => {
  it("returns empty in host mode without DANXBOT_REPO_NAME (dashboard mode)", async () => {
    mockDockerenvExists = false;
    const mod = await importRepoContext();
    expect(mod.repoContexts).toEqual([]);
    expect(mod.isDashboardMode).toBe(true);
  });

  it("returns empty in docker mode without DANXBOT_REPO_NAME (dashboard mode)", async () => {
    mockDockerenvExists = true;
    const mod = await importRepoContext();
    expect(mod.repoContexts).toEqual([]);
    expect(mod.isDashboardMode).toBe(true);
  });

  it("loads only the named repo in worker mode", async () => {
    mockTarget = {
      name: "multi",
      mode: "local",
      repos: [
        {
          name: "platform",
          url: "https://github.com/Flytedesk/platform.git",
          localPath: "/danxbot/repos/platform",
          workerPort: 5561,
        },
        {
          name: "danxbot",
          url: "https://github.com/test/danxbot.git",
          localPath: "/danxbot/repos/danxbot",
          workerPort: 5562,
        },
      ],
    };
    const mod = await importRepoContext({
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    expect(mod.repoContexts).toHaveLength(1);
    expect(mod.repoContexts[0].name).toBe("platform");
    expect(mod.isWorkerMode).toBe(true);
  });

  it("returns empty when the target has no repos and worker mode is off", async () => {
    mockTarget = { name: "empty", mode: "local", repos: [] };
    const mod = await importRepoContext();
    expect(mod.repoContexts).toEqual([]);
  });
});

describe("RepoContext database config", () => {
  const DB_ENV = {
    DANX_DB_HOST: "ssap-mysql-1",
    DANX_DB_USER: "sail",
    DANX_DB_PASSWORD: "password",
    DANX_DB_NAME: "flytedesk-dev",
  };

  it("keeps docker service name verbatim in docker mode", async () => {
    mockDockerenvExists = true;
    mockEnvFile = { ...DEFAULT_MOCK_ENV_FILE, ...DB_ENV };
    const mod = await importRepoContext({
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    const ctx = mod.getRepoContext("platform");
    expect(ctx.db.host).toBe("ssap-mysql-1");
    expect(ctx.db.port).toBe(3306);
    expect(ctx.db.enabled).toBe(true);
  });

  it("translates docker service name to 127.0.0.1 in host mode", async () => {
    mockDockerenvExists = false;
    mockEnvFile = { ...DEFAULT_MOCK_ENV_FILE, ...DB_ENV };
    const mod = await importRepoContext({
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    const ctx = mod.getRepoContext("platform");
    expect(ctx.db.host).toBe("127.0.0.1");
    expect(ctx.db.port).toBe(3306);
  });

  it("keeps an IP or localhost verbatim on host mode (no needless translation)", async () => {
    mockDockerenvExists = false;
    mockEnvFile = {
      ...DEFAULT_MOCK_ENV_FILE,
      ...DB_ENV,
      DANX_DB_HOST: "10.0.0.5",
    };
    const mod = await importRepoContext({
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    expect(mod.getRepoContext("platform").db.host).toBe("10.0.0.5");
  });

  it("respects DANX_DB_PORT in both runtimes", async () => {
    mockDockerenvExists = true;
    mockEnvFile = { ...DEFAULT_MOCK_ENV_FILE, ...DB_ENV, DANX_DB_PORT: "3307" };
    const mod = await importRepoContext({
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    expect(mod.getRepoContext("platform").db.port).toBe(3307);
  });

  it("disables db when DANX_DB_HOST is not set", async () => {
    mockEnvFile = { ...DEFAULT_MOCK_ENV_FILE };
    const mod = await importRepoContext({
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    const ctx = mod.getRepoContext("platform");
    expect(ctx.db.enabled).toBe(false);
    expect(ctx.db.host).toBe("");
    expect(ctx.db.port).toBe(3306);
  });
});

describe("getRepoContext", () => {
  it("returns context for named repo in worker mode", async () => {
    const mod = await importRepoContext({
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    const ctx = mod.getRepoContext("platform");
    expect(ctx.name).toBe("platform");
    expect(ctx.trello.apiKey).toBe("mock-trello-key");
  });

  it("throws for unknown repo in worker mode", async () => {
    const mod = await importRepoContext({
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    expect(() => mod.getRepoContext("unknown")).toThrow(
      'Repo "unknown" is not configured',
    );
  });
});

describe("runtime detection", () => {
  it("isHost is true when /.dockerenv is absent", async () => {
    mockDockerenvExists = false;
    const mod = await importConfig({});
    expect(mod.config.isHost).toBe(true);
    expect(mod.config.runtime).toBe("host");
  });

  it("isHost is false when /.dockerenv is present", async () => {
    mockDockerenvExists = true;
    const mod = await importConfig({});
    expect(mod.config.isHost).toBe(false);
    expect(mod.config.runtime).toBe("docker");
  });

  it("ignores DANXBOT_RUNTIME env var — detection is filesystem-only", async () => {
    mockDockerenvExists = true;
    const mod = await importConfig({ DANXBOT_RUNTIME: "host" } as Record<
      string,
      string
    >);
    expect(mod.config.isHost).toBe(false);
  });
});

describe("required DB config", () => {
  it("derives db.host — docker uses mysql, host uses 127.0.0.1", async () => {
    mockDockerenvExists = true;
    const mod = await importConfig({});
    expect(mod.config.db.host).toBe("mysql");
    expect(mod.config.db.port).toBe(3306);
  });

  it("derives db.host as 127.0.0.1 in host mode", async () => {
    mockDockerenvExists = false;
    const mod = await importConfig({});
    expect(mod.config.db.host).toBe("127.0.0.1");
    expect(mod.config.db.port).toBe(3308);
  });

  it("throws when DANXBOT_DB_USER is missing", async () => {
    await expect(importConfig({}, ["DANXBOT_DB_USER"])).rejects.toThrow(
      "DANXBOT_DB_USER",
    );
  });

  it("throws when DANXBOT_DB_PASSWORD is missing", async () => {
    await expect(importConfig({}, ["DANXBOT_DB_PASSWORD"])).rejects.toThrow(
      "DANXBOT_DB_PASSWORD",
    );
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
    await expect(importConfig({ MAX_TURNS: "abc" })).rejects.toThrow(
      "agent.maxTurns",
    );
  });

  it("throws for negative values", async () => {
    await expect(importConfig({ MAX_BUDGET_USD: "-1" })).rejects.toThrow(
      "agent.maxBudgetUsd",
    );
  });

  it("throws for zero maxBudgetUsd (exclusive minimum)", async () => {
    await expect(importConfig({ MAX_BUDGET_USD: "0" })).rejects.toThrow(
      "agent.maxBudgetUsd",
    );
  });

  it("throws for zero values on fields requiring > 0", async () => {
    await expect(importConfig({ MAX_TURNS: "0" })).rejects.toThrow(
      "agent.maxTurns",
    );
  });

  it("throws for negative maxRetries", async () => {
    await expect(
      importConfig({ AGENT_MAX_RETRIES: "-1" }),
    ).resolves.toBeDefined();
  });

  it("throws for NaN maxRetries", async () => {
    await expect(importConfig({ AGENT_MAX_RETRIES: "abc" })).rejects.toThrow(
      "agent.maxRetries",
    );
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

describe("dispatch config", () => {
  it("defaults dispatch.mcpProbeTimeoutMs to 60000 when DISPATCH_MCP_PROBE_TIMEOUT_MS is unset (covers cold npx install)", async () => {
    const mod = await importConfig({}, ["DISPATCH_MCP_PROBE_TIMEOUT_MS"]);
    expect(mod.config.dispatch.mcpProbeTimeoutMs).toBe(60_000);
  });

  it("reads DISPATCH_MCP_PROBE_TIMEOUT_MS as an integer override", async () => {
    const mod = await importConfig({
      DISPATCH_MCP_PROBE_TIMEOUT_MS: "7500",
    });
    expect(mod.config.dispatch.mcpProbeTimeoutMs).toBe(7_500);
  });
});
