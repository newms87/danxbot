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
    blockedLabelId: "blk",
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
import { loadIssuePrefix, loadRepoContext } from "./repo-context.js";

const mockParseEnvFile = vi.mocked(parseEnvFile);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

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
    return s.endsWith(".danxbot/.env") || s.endsWith("config.yml");
  });
  // Phase 4 of DX-99 made `loadIssuePrefix` fail-loud on a missing
  // config.yml. The trelloEnabled / workerPort suites don't care about
  // the prefix specifically — they just need the loader not to throw —
  // so default `readFileSync` to a config.yml stub carrying a valid
  // `issue_prefix: ISS`. Tests that EXERCISE the prefix-loading path
  // override this with their own mockReturnValue.
  mockReadFileSync.mockReturnValue("issue_prefix: ISS\n");
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

describe("loadIssuePrefix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when config.yml is missing (Phase 4 of DX-99 — fail-loud, no fallback)", () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => loadIssuePrefix("/repo/missing")).toThrow(
      /not found; cannot resolve issue_prefix/,
    );
  });

  it("throws when config.yml has no issue_prefix field", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("name: example\nurl: https://x\n");
    expect(() => loadIssuePrefix("/repo/example")).toThrow(
      /missing required field issue_prefix/,
    );
  });

  it("returns DX when config.yml carries issue_prefix: DX", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix: DX\n");
    expect(loadIssuePrefix("/repo/danxbot")).toBe("DX");
  });

  it("returns SG for gpt-manager", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix: SG\n");
    expect(loadIssuePrefix("/repo/gpt-manager")).toBe("SG");
  });

  it("returns FD for platform", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix: FD\n");
    expect(loadIssuePrefix("/repo/platform")).toBe("FD");
  });

  it("accepts a quoted issue_prefix value (parser strips the quotes)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('issue_prefix: "DX"\n');
    expect(loadIssuePrefix("/repo/danxbot")).toBe("DX");
  });

  it("trims whitespace around the prefix value", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix:    DX   \n");
    expect(loadIssuePrefix("/repo/danxbot")).toBe("DX");
  });

  it("throws when issue_prefix is lowercase", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix: dx\n");
    expect(() => loadIssuePrefix("/repo/danxbot")).toThrow(
      /Invalid issue_prefix "dx"/,
    );
  });

  it("throws when issue_prefix contains digits", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix: DX1\n");
    expect(() => loadIssuePrefix("/repo/danxbot")).toThrow(
      /Invalid issue_prefix "DX1"/,
    );
  });

  it("throws when issue_prefix is too short (1 letter)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix: D\n");
    expect(() => loadIssuePrefix("/repo/danxbot")).toThrow(
      /Invalid issue_prefix "D"/,
    );
  });

  it("throws when issue_prefix is too long (5 letters)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix: TOOLONG\n");
    expect(() => loadIssuePrefix("/repo/danxbot")).toThrow(
      /Invalid issue_prefix "TOOLONG"/,
    );
  });

  it("throws when issue_prefix is empty string", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix:\n");
    expect(() => loadIssuePrefix("/repo/danxbot")).toThrow(
      /missing required field issue_prefix/,
    );
  });

  it("throws when readFileSync errors (unreadable config)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    expect(() => loadIssuePrefix("/repo/locked")).toThrow(
      /Failed to read.*EACCES/,
    );
  });

  it("accepts the boundary shape XX (2 letters)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix: XX\n");
    expect(loadIssuePrefix("/repo/example")).toBe("XX");
  });

  it("accepts the boundary shape ABCD (4 letters)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("issue_prefix: ABCD\n");
    expect(loadIssuePrefix("/repo/example")).toBe("ABCD");
  });
});

describe("loadRepoContext — issuePrefix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupEnvFileExists();
    delete process.env.DANXBOT_WORKER_PORT;
  });

  it("loadRepoContext throws when the repo's config.yml is missing (Phase 4 of DX-99)", () => {
    // Override the default `setupEnvFileExists` config.yml stub so this
    // test exercises the fail-loud branch.
    mockExistsSync.mockImplementation((p) =>
      String(p).endsWith(".danxbot/.env"),
    );
    mockParseEnvFile.mockReturnValue({ ...MINIMUM_ENV });
    expect(() => loadRepoContext(TEST_REPO)).toThrow(
      /not found; cannot resolve issue_prefix/,
    );
  });

  it("threads a valid issue_prefix from config.yml into RepoContext", () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith(".danxbot/.env") || s.endsWith("config.yml");
    });
    mockReadFileSync.mockReturnValue("issue_prefix: DX\n");
    mockParseEnvFile.mockReturnValue({ ...MINIMUM_ENV });
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.issuePrefix).toBe("DX");
  });

  it("propagates a bad issue_prefix shape as a fatal error", () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith(".danxbot/.env") || s.endsWith("config.yml");
    });
    mockReadFileSync.mockReturnValue("issue_prefix: dx-1\n");
    mockParseEnvFile.mockReturnValue({ ...MINIMUM_ENV });
    expect(() => loadRepoContext(TEST_REPO)).toThrow(/Invalid issue_prefix/);
  });
});

// DX-230 — canonical hostPath population. host runtime defaults to
// localPath; container runtime requires DANXBOT_REPO_HOST_PATH (fail-loud).
describe("loadRepoContext — hostPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupEnvFileExists();
    delete process.env.DANXBOT_REPO_HOST_PATH;
    delete process.env.DANXBOT_WORKER_PORT;
    mockParseEnvFile.mockReturnValue({ ...MINIMUM_ENV });
  });

  it("defaults hostPath to localPath on host runtime when env unset", async () => {
    const { config } = await import("./config.js");
    (config as { isHost: boolean }).isHost = true;
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.hostPath).toBe(TEST_REPO.localPath);
  });

  it("uses DANXBOT_REPO_HOST_PATH when set (any runtime)", async () => {
    const { config } = await import("./config.js");
    (config as { isHost: boolean }).isHost = true;
    process.env.DANXBOT_REPO_HOST_PATH = "/canonical/path";
    const ctx = loadRepoContext(TEST_REPO);
    expect(ctx.hostPath).toBe("/canonical/path");
  });

  it("throws on container runtime when DANXBOT_REPO_HOST_PATH is missing", async () => {
    const { config } = await import("./config.js");
    (config as { isHost: boolean }).isHost = false;
    expect(() => loadRepoContext(TEST_REPO)).toThrow(
      /DANXBOT_REPO_HOST_PATH/,
    );
    (config as { isHost: boolean }).isHost = true;
  });
});
