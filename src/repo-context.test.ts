import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoConfig } from "./types.js";

vi.mock("./env-file.js", () => ({
  parseEnvFile: vi.fn(),
}));

vi.mock("./poller/constants.js", () => ({
  getReposBase: () => "/test/repos",
  loadTrelloIds: () => ({
    boardId: "b",
    reviewListId: "r",
    todoListId: "t",
    inProgressListId: "ip",
    needsHelpListId: "nh",
    doneListId: "d",
    cancelledListId: "c",
    actionItemsListId: "a",
    bugLabelId: "bug",
    featureLabelId: "feat",
    epicLabelId: "epic",
    needsHelpLabelId: "nhl",
  }),
}));

vi.mock("./config.js", () => ({
  repos: [],
  isWorkerMode: false,
  workerRepoName: "",
  config: { isHost: true },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { parseEnvFile } from "./env-file.js";
import { existsSync, readFileSync } from "node:fs";
import { loadRepoContext } from "./repo-context.js";

const mockParseEnvFile = vi.mocked(parseEnvFile);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

const TEST_REPO: RepoConfig = {
  name: "test-repo",
  url: "https://example.com/test.git",
  localPath: "/test/repos/test-repo",
};

const MINIMUM_ENV = {
  DANX_TRELLO_API_KEY: "trello-key",
  DANX_TRELLO_API_TOKEN: "trello-token",
};

function setupFilesExist(): void {
  mockExistsSync.mockImplementation((path) => {
    const s = String(path);
    return s.endsWith(".danxbot/.env") || s.endsWith(".claude/settings.local.json");
  });
}

function setupSettingsLocalJson(workerPort: string | null): void {
  const json = workerPort === null
    ? JSON.stringify({ env: {} })
    : JSON.stringify({ env: { DANXBOT_WORKER_PORT: workerPort } });
  mockReadFileSync.mockImplementation((path) => {
    const s = String(path);
    if (s.endsWith(".claude/settings.local.json")) return json;
    throw new Error(`Unexpected readFileSync: ${s}`);
  });
}

describe("loadRepoContext — trelloEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFilesExist();
    setupSettingsLocalJson("5562");
  });

  it("defaults trelloEnabled to false when DANX_TRELLO_ENABLED is unset", () => {
    mockParseEnvFile.mockReturnValue({ ...MINIMUM_ENV });
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.trelloEnabled).toBe(false);
  });

  it("sets trelloEnabled=true when DANX_TRELLO_ENABLED=true", () => {
    mockParseEnvFile.mockReturnValue({
      ...MINIMUM_ENV,
      DANX_TRELLO_ENABLED: "true",
    });
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.trelloEnabled).toBe(true);
  });

  it("sets trelloEnabled=false when DANX_TRELLO_ENABLED=false", () => {
    mockParseEnvFile.mockReturnValue({
      ...MINIMUM_ENV,
      DANX_TRELLO_ENABLED: "false",
    });
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.trelloEnabled).toBe(false);
  });

  it("treats any non-'true' value as false (no silent truthiness)", () => {
    mockParseEnvFile.mockReturnValue({
      ...MINIMUM_ENV,
      DANX_TRELLO_ENABLED: "1",
    });
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.trelloEnabled).toBe(false);
  });
});

describe("loadRepoContext — workerPort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFilesExist();
    mockParseEnvFile.mockReturnValue({ ...MINIMUM_ENV });
  });

  it("reads env.DANXBOT_WORKER_PORT from .claude/settings.local.json", () => {
    setupSettingsLocalJson("5562");
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.workerPort).toBe(5562);
  });

  it("throws when .claude/settings.local.json is missing", () => {
    mockExistsSync.mockImplementation((path) => {
      const s = String(path);
      return s.endsWith(".danxbot/.env");
    });
    expect(() => loadRepoContext(TEST_REPO)).toThrow(
      /settings\.local\.json/,
    );
  });

  it("throws when env.DANXBOT_WORKER_PORT is missing from settings.local.json", () => {
    setupSettingsLocalJson(null);
    expect(() => loadRepoContext(TEST_REPO)).toThrow(
      /DANXBOT_WORKER_PORT/,
    );
  });

  it("throws when env.DANXBOT_WORKER_PORT is not a valid port number", () => {
    setupSettingsLocalJson("not-a-number");
    expect(() => loadRepoContext(TEST_REPO)).toThrow(
      /DANXBOT_WORKER_PORT/,
    );
  });
});
