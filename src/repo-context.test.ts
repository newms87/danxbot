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
}));

import { parseEnvFile } from "./env-file.js";
import { existsSync } from "node:fs";
import { loadRepoContext } from "./repo-context.js";

const mockParseEnvFile = vi.mocked(parseEnvFile);
const mockExistsSync = vi.mocked(existsSync);

// Identity-only stub — `loadRepoContext` reads workerPort from the
// repo's `.danxbot/.env` (via `readWorkerPort`), not from the input
// RepoConfig. Typed as `Pick<...>` to match the function's narrowed
// signature.
const TEST_REPO: Pick<RepoConfig, "name" | "url" | "localPath"> = {
  name: "test-repo",
  url: "https://example.com/test.git",
  localPath: "/test/repos/test-repo",
};

const MINIMUM_ENV = {
  DANX_TRELLO_API_KEY: "trello-key",
  DANX_TRELLO_API_TOKEN: "trello-token",
  DANXBOT_WORKER_PORT: "5562",
};

function setupEnvFileExists(): void {
  mockExistsSync.mockImplementation((path) => {
    const s = String(path);
    return s.endsWith(".danxbot/.env");
  });
}

describe("loadRepoContext — trelloEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupEnvFileExists();
    delete process.env.DANXBOT_WORKER_PORT;
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
    setupEnvFileExists();
    delete process.env.DANXBOT_WORKER_PORT;
  });

  it("prefers process.env.DANXBOT_WORKER_PORT over .danxbot/.env (prod deploy path)", () => {
    process.env.DANXBOT_WORKER_PORT = "5571";
    mockParseEnvFile.mockReturnValue({ ...MINIMUM_ENV });
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.workerPort).toBe(5571);
    delete process.env.DANXBOT_WORKER_PORT;
  });

  it("throws on invalid process.env.DANXBOT_WORKER_PORT", () => {
    process.env.DANXBOT_WORKER_PORT = "not-a-number";
    mockParseEnvFile.mockReturnValue({ ...MINIMUM_ENV });
    expect(() => loadRepoContext(TEST_REPO)).toThrow(
      /DANXBOT_WORKER_PORT/,
    );
    delete process.env.DANXBOT_WORKER_PORT;
  });

  it("reads DANXBOT_WORKER_PORT from <repo>/.danxbot/.env (local dev path)", () => {
    mockParseEnvFile.mockReturnValue({ ...MINIMUM_ENV });
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.workerPort).toBe(5562);
  });

  it("throws when DANXBOT_WORKER_PORT is missing from .danxbot/.env", () => {
    mockParseEnvFile.mockReturnValue({
      DANX_TRELLO_API_KEY: "k",
      DANX_TRELLO_API_TOKEN: "t",
    });
    expect(() => loadRepoContext(TEST_REPO)).toThrow(
      /DANXBOT_WORKER_PORT/,
    );
  });

  it("throws when DANXBOT_WORKER_PORT is not a valid port number", () => {
    mockParseEnvFile.mockReturnValue({
      ...MINIMUM_ENV,
      DANXBOT_WORKER_PORT: "not-a-number",
    });
    expect(() => loadRepoContext(TEST_REPO)).toThrow(
      /DANXBOT_WORKER_PORT/,
    );
  });

  it("throws for port 0 (below valid range)", () => {
    mockParseEnvFile.mockReturnValue({
      ...MINIMUM_ENV,
      DANXBOT_WORKER_PORT: "0",
    });
    expect(() => loadRepoContext(TEST_REPO)).toThrow(/DANXBOT_WORKER_PORT/);
  });

  it("throws for port 65536 (above valid range)", () => {
    mockParseEnvFile.mockReturnValue({
      ...MINIMUM_ENV,
      DANXBOT_WORKER_PORT: "65536",
    });
    expect(() => loadRepoContext(TEST_REPO)).toThrow(/DANXBOT_WORKER_PORT/);
  });

  it("accepts port 65535 (max valid port)", () => {
    mockParseEnvFile.mockReturnValue({
      ...MINIMUM_ENV,
      DANXBOT_WORKER_PORT: "65535",
    });
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.workerPort).toBe(65535);
  });

  it("throws for float port value (not an integer)", () => {
    mockParseEnvFile.mockReturnValue({
      ...MINIMUM_ENV,
      DANXBOT_WORKER_PORT: "5561.5",
    });
    expect(() => loadRepoContext(TEST_REPO)).toThrow(/DANXBOT_WORKER_PORT/);
  });
});
