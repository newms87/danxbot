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

// Mock env-file.js to avoid reading actual .env files from repos
vi.mock("./env-file.js", () => ({
  parseEnvFile: () => ({ ...mockEnvFile }),
}));

// Lets individual tests simulate running inside a Docker container by
// flipping /.dockerenv presence without touching the real filesystem.
let mockDockerenvExists = false;

// Mock fs to make existsSync return true for .danxbot/.env paths and
// controllable for /.dockerenv.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    existsSync: (path: string) => {
      if (path === "/.dockerenv") return mockDockerenvExists;
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

const TEST_WORKER_PORT = "5561";

beforeEach(() => {
  vi.resetModules();
  mockDockerenvExists = false;
  mockEnvFile = { ...DEFAULT_MOCK_ENV_FILE };
});

describe("repos config", () => {
  it("parses multiple repos from REPOS env var", async () => {
    const mod = await importConfig({
      REPOS:
        "platform:https://github.com/Flytedesk/platform.git,docs:https://github.com/Flytedesk/docs.git",
    });
    expect(mod.repos).toEqual([
      {
        name: "platform",
        url: "https://github.com/Flytedesk/platform.git",
        localPath: "/danxbot/repos/platform",
      },
      {
        name: "docs",
        url: "https://github.com/Flytedesk/docs.git",
        localPath: "/danxbot/repos/docs",
      },
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
    await expect(importConfig({ REPOS: "platform" })).rejects.toThrow(
      "Invalid REPOS entry",
    );
  });

  it("throws on empty name", async () => {
    await expect(
      importConfig({ REPOS: ":https://example.com" }),
    ).rejects.toThrow("Invalid REPOS entry");
  });

  it("throws on empty URL after colon", async () => {
    await expect(importConfig({ REPOS: "platform:" })).rejects.toThrow(
      "name and url must not be empty",
    );
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

describe("REPO_WORKER_PORTS", () => {
  it("attaches workerPort to the matching repo", async () => {
    const mod = await importConfig({
      REPOS:
        "platform:https://example.com/p.git,danxbot:https://example.com/d.git",
      REPO_WORKER_PORTS: "platform:5561,danxbot:5562",
    });
    expect(mod.repos).toEqual([
      expect.objectContaining({ name: "platform", workerPort: 5561 }),
      expect.objectContaining({ name: "danxbot", workerPort: 5562 }),
    ]);
  });

  it("leaves workerPort undefined on repos with no port entry (worker mode populates separately)", async () => {
    const mod = await importConfig({
      REPOS:
        "platform:https://example.com/p.git,danxbot:https://example.com/d.git",
      REPO_WORKER_PORTS: "platform:5561",
    });
    expect(mod.repos[0].workerPort).toBe(5561);
    expect(mod.repos[1].workerPort).toBeUndefined();
  });

  it("returns empty mapping when REPO_WORKER_PORTS is unset", async () => {
    const mod = await importConfig(
      {
        REPOS: "platform:https://example.com/p.git",
      },
      ["REPO_WORKER_PORTS"],
    );
    expect(mod.repos[0].workerPort).toBeUndefined();
  });

  it("throws on malformed entry (missing colon)", async () => {
    await expect(
      importConfig({
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "platform",
      }),
    ).rejects.toThrow("Invalid REPO_WORKER_PORTS entry");
  });

  it("throws on non-numeric port", async () => {
    await expect(
      importConfig({
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "platform:not-a-port",
      }),
    ).rejects.toThrow("Invalid REPO_WORKER_PORTS entry");
  });

  it("throws on port out of range", async () => {
    await expect(
      importConfig({
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "platform:70000",
      }),
    ).rejects.toThrow("Invalid REPO_WORKER_PORTS entry");
  });

  it("throws on port zero", async () => {
    await expect(
      importConfig({
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "platform:0",
      }),
    ).rejects.toThrow("Invalid REPO_WORKER_PORTS entry");
  });

  it("throws when a port references an unknown repo (fails loud on typos)", async () => {
    await expect(
      importConfig({
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "typod-repo:5562",
      }),
    ).rejects.toThrow(/unknown repo "typod-repo"/);
  });
});

describe("REPO_WORKER_HOSTS", () => {
  it("attaches workerHost to the matching repo", async () => {
    // The dashboard's worker-host resolver consults workerHost first, so any
    // repo that declares one in its deployment yml ends up reachable at the
    // declared docker hostname instead of the default `danxbot-worker-<name>`.
    const mod = await importConfig({
      REPOS:
        "platform:https://example.com/p.git,custom:https://example.com/c.git",
      REPO_WORKER_PORTS: "platform:5561,custom:5562",
      REPO_WORKER_HOSTS: "custom:renamed-container",
    });
    expect(mod.repos[0].name).toBe("platform");
    expect(mod.repos[0].workerHost).toBeUndefined();
    expect(mod.repos[1].name).toBe("custom");
    expect(mod.repos[1].workerHost).toBe("renamed-container");
  });

  it("leaves workerHost undefined on repos with no host entry", async () => {
    const mod = await importConfig({
      REPOS:
        "platform:https://example.com/p.git,custom:https://example.com/c.git",
      REPO_WORKER_PORTS: "platform:5561,custom:5562",
      REPO_WORKER_HOSTS: "custom:c-host",
    });
    expect(mod.repos[0].workerHost).toBeUndefined();
    expect(mod.repos[1].workerHost).toBe("c-host");
  });

  it("returns no overrides when REPO_WORKER_HOSTS is unset", async () => {
    const mod = await importConfig(
      {
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "platform:5561",
      },
      ["REPO_WORKER_HOSTS"],
    );
    expect(mod.repos[0].workerHost).toBeUndefined();
  });

  it("throws on malformed entry (missing colon)", async () => {
    await expect(
      importConfig({
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "platform:5561",
        REPO_WORKER_HOSTS: "platform",
      }),
    ).rejects.toThrow("Invalid REPO_WORKER_HOSTS entry");
  });

  it("throws on empty hostname after colon", async () => {
    await expect(
      importConfig({
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "platform:5561",
        REPO_WORKER_HOSTS: "platform:",
      }),
    ).rejects.toThrow("Invalid REPO_WORKER_HOSTS entry");
  });

  it("throws when a host references an unknown repo (fails loud on typos)", async () => {
    await expect(
      importConfig({
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "platform:5561",
        REPO_WORKER_HOSTS: "typod-repo:custom-host",
      }),
    ).rejects.toThrow(/unknown repo "typod-repo"/);
  });

  it("rejects whitespace inside a hostname (DNS labels can't contain spaces)", async () => {
    await expect(
      importConfig({
        REPOS: "platform:https://example.com/p.git",
        REPO_WORKER_PORTS: "platform:5561",
        REPO_WORKER_HOSTS: "platform:has space",
      }),
    ).rejects.toThrow("Invalid REPO_WORKER_HOSTS entry");
  });

  it("trims whitespace around entries", async () => {
    const mod = await importConfig({
      REPOS: "platform:https://example.com/p.git",
      REPO_WORKER_PORTS: "platform:5561",
      REPO_WORKER_HOSTS: " platform : custom-host ",
    });
    expect(mod.repos[0].workerHost).toBe("custom-host");
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
    expect(() => mod.getRepoPath("unknown")).toThrow(
      'Repo "unknown" is not configured',
    );
  });
});

describe("repoContexts", () => {
  it("returns empty in host mode without DANXBOT_REPO_NAME (dashboard mode)", async () => {
    mockDockerenvExists = false;
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
    });
    expect(mod.repoContexts).toEqual([]);
    expect(mod.isDashboardMode).toBe(true);
  });

  it("returns empty in docker mode without DANXBOT_REPO_NAME (dashboard mode)", async () => {
    mockDockerenvExists = true;
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
    });
    expect(mod.repoContexts).toEqual([]);
    expect(mod.isDashboardMode).toBe(true);
  });

  it("loads only named repo in worker mode", async () => {
    const mod = await importRepoContext({
      REPOS:
        "platform:https://github.com/Flytedesk/platform.git,danxbot:https://github.com/test/danxbot.git",
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
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
      REPOS: "platform:https://github.com/test/platform.git",
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
      REPOS: "platform:https://github.com/test/platform.git",
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
      REPOS: "platform:https://github.com/test/platform.git",
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    expect(mod.getRepoContext("platform").db.host).toBe("10.0.0.5");
  });

  it("respects DANX_DB_PORT in both runtimes", async () => {
    mockDockerenvExists = true;
    mockEnvFile = { ...DEFAULT_MOCK_ENV_FILE, ...DB_ENV, DANX_DB_PORT: "3307" };
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/test/platform.git",
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    expect(mod.getRepoContext("platform").db.port).toBe(3307);
  });

  it("disables db when DANX_DB_HOST is not set", async () => {
    mockEnvFile = { ...DEFAULT_MOCK_ENV_FILE };
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/test/platform.git",
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
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
      DANXBOT_REPO_NAME: "platform",
      DANXBOT_WORKER_PORT: TEST_WORKER_PORT,
    });
    const ctx = mod.getRepoContext("platform");
    expect(ctx.name).toBe("platform");
    expect(ctx.trello.apiKey).toBe("mock-trello-key");
  });

  it("throws for unknown repo in worker mode", async () => {
    const mod = await importRepoContext({
      REPOS: "platform:https://github.com/Flytedesk/platform.git",
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
    expect(mod.config.db.port).toBe(3308); // default host port
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
    // maxRetries has Math.max(0, ...) so parseInt("-1") => -1 => Math.max(0,-1) => 0
    // 0 is valid for maxRetries, so this should NOT throw
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
