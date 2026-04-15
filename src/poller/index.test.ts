import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RepoContext } from "../types.js";

// Set REPOS before index.ts loads so getDanxbotConfigDir() resolves a path
vi.hoisted(() => {
  process.env.REPOS = "test-repo:https://github.com/org/repo.git";
});

const MOCK_REPO_CONTEXT: RepoContext = {
  name: "test-repo",
  url: "https://example.com/test.git",
  localPath: "/test/repos/test-repo",
  trello: {
    apiKey: "test-key",
    apiToken: "test-token",
    boardId: "test-board",
    reviewListId: "review-list",
    todoListId: "todo-list",
    inProgressListId: "ip-list",
    needsHelpListId: "nh-list",
    doneListId: "done-list",
    cancelledListId: "cancelled-list",
    actionItemsListId: "ai-list",
    bugLabelId: "bug-label",
    featureLabelId: "feature-label",
    epicLabelId: "epic-label",
    needsHelpLabelId: "nh-label",
  },
  slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
  db: { host: "", user: "", password: "", database: "", enabled: false },
  githubToken: "test-github-token",
};

// Mock dependencies before importing module under test
// NOTE: vi.mock factories are hoisted and can't reference MOCK_REPO_CONTEXT directly.
// Use vi.hoisted to make it available at hoist time.
const { mockRepoContexts } = vi.hoisted(() => {
  const ctx = {
    name: "test-repo",
    url: "https://example.com/test.git",
    localPath: "/test/repos/test-repo",
    trello: {
      apiKey: "test-key", apiToken: "test-token", boardId: "test-board",
      reviewListId: "review-list", todoListId: "todo-list", inProgressListId: "ip-list",
      needsHelpListId: "nh-list", doneListId: "done-list", cancelledListId: "cancelled-list",
      actionItemsListId: "ai-list", bugLabelId: "bug-label", featureLabelId: "feature-label",
      epicLabelId: "epic-label", needsHelpLabelId: "nh-label",
    },
    slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    db: { host: "", user: "", password: "", database: "", enabled: false },
    githubToken: "test-github-token",
  };
  return { mockRepoContexts: [ctx] };
});

vi.mock("../config.js", () => ({
  config: { pollerIntervalMs: 60000 },
  repoContexts: mockRepoContexts,
}));

vi.mock("./constants.js", () => ({
  getReposBase: () => "/danxbot/repos",
  REVIEW_MIN_CARDS: 10,
  DANXBOT_COMMENT_MARKER: "<!-- danxbot -->",
}));

const mockFetchTodoCards = vi.fn();
const mockFetchNeedsHelpCards = vi.fn();
const mockFetchLatestComment = vi.fn();
const mockMoveCardToList = vi.fn();
const mockIsUserResponse = vi.fn();
vi.mock("./trello-client.js", () => ({
  fetchTodoCards: (...args: unknown[]) => mockFetchTodoCards(...args),
  fetchNeedsHelpCards: (...args: unknown[]) => mockFetchNeedsHelpCards(...args),
  fetchLatestComment: (...args: unknown[]) => mockFetchLatestComment(...args),
  moveCardToList: (...args: unknown[]) => mockMoveCardToList(...args),
  isUserResponse: (...args: unknown[]) => mockIsUserResponse(...args),
}));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn().mockReturnValue([]);
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}));

import { poll, shutdown, start, _resetForTesting } from "./index.js";

function createFakeSpawnResult() {
  return { unref: vi.fn(), on: vi.fn() };
}

const FAKE_CONFIG_YML = `name: test-repo
url: https://github.com/org/repo.git
runtime: local
language: node
framework: express

commands:
  test: "npm test"
  lint: ""
  type_check: ""
  dev: ""

paths:
  source: "src/"
  tests: "tests/"
`;

/** Make existsSync return true for .danxbot/config/ paths, false for lock file by default */
function setupRepoConfigMocks() {
  mockExistsSync.mockImplementation((path: string) => {
    if (typeof path === "string" && (
      path.includes(".danxbot/config") ||
      path.endsWith("config.yml") ||
      path.endsWith("overview.md") ||
      path.endsWith("workflow.md") ||
      path.endsWith("trello.yml")
    )) return true;
    return false;
  });
  mockReadFileSync.mockImplementation((path: string) => {
    if (typeof path === "string" && path.endsWith("config.yml")) return FAKE_CONFIG_YML;
    if (typeof path === "string" && path.endsWith("trello.yml")) return "board_id: mock-board-id\n";
    if (typeof path === "string" && path.endsWith(".md")) return "# placeholder";
    return "";
  });
}

describe("poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockMoveCardToList.mockResolvedValue(undefined);
  });

  it("skips when teamRunning is true", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    await poll(MOCK_REPO_CONTEXT);

    // Second call: should skip because teamRunning is true
    mockFetchTodoCards.mockClear();
    mockSpawn.mockClear();
    mockFetchNeedsHelpCards.mockClear();
    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockFetchNeedsHelpCards).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does nothing when no cards in ToDo", async () => {
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchTodoCards).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns wt.exe to open new terminal tab", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockSpawn).toHaveBeenCalledWith(
      "wt.exe",
      expect.arrayContaining(["new-tab", "--title", "Danxbot Team [test-repo]", "bash", expect.stringContaining("run-team.sh")]),
      expect.objectContaining({
        detached: true,
      }),
    );
  });

  it("creates lock file when spawning", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".poller-running"),
      expect.any(String),
    );
  });

  it("handles fetchTodoCards failure gracefully", async () => {
    mockFetchTodoCards.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("strips CLAUDECODE env vars from spawned process", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    process.env.CLAUDECODE_TEST = "should-be-removed";

    await poll(MOCK_REPO_CONTEXT);

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv).not.toHaveProperty("CLAUDECODE_TEST");

    delete process.env.CLAUDECODE_TEST;
  });

  it("refuses to spawn if lock file already exists (pre-spawn safety check)", async () => {
    mockExistsSync.mockReturnValue(true);
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    // Should not spawn because lock file already exists
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("poll — Needs Help checking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockMoveCardToList.mockResolvedValue(undefined);
  });

  it("checks Needs Help list before ToDo", async () => {
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    // Needs Help should be called first
    expect(mockFetchNeedsHelpCards).toHaveBeenCalled();
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });

  it("moves user-responded cards from Needs Help to ToDo", async () => {
    const needsHelpCard = { id: "nh1", name: "Blocked card" };
    const userComment = { id: "a1", data: { text: "I fixed the config" } };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue(userComment);
    mockIsUserResponse.mockReturnValue(true);
    mockFetchTodoCards.mockResolvedValue([needsHelpCard]); // Card now in ToDo

    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchLatestComment).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.trello, "nh1");
    expect(mockIsUserResponse).toHaveBeenCalledWith(userComment);
    expect(mockMoveCardToList).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.trello, "nh1", MOCK_REPO_CONTEXT.trello.todoListId, "top");
  });

  it("does not move cards still waiting for user (bot comment is latest)", async () => {
    const needsHelpCard = { id: "nh1", name: "Blocked card" };
    const botComment = { id: "a1", data: { text: "Needs config change\n\n<!-- danxbot -->" } };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue(botComment);
    mockIsUserResponse.mockReturnValue(false);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockMoveCardToList).not.toHaveBeenCalled();
  });

  it("does not move cards with no comments", async () => {
    const needsHelpCard = { id: "nh1", name: "New error card" };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue(null);
    mockIsUserResponse.mockReturnValue(false);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockMoveCardToList).not.toHaveBeenCalled();
  });

  it("only moves user-responded cards in a mixed set", async () => {
    const cards = [
      { id: "nh1", name: "Bot waiting" },
      { id: "nh2", name: "User replied" },
      { id: "nh3", name: "No comments" },
    ];
    const botComment = { id: "a1", data: { text: "Needs help\n\n<!-- danxbot -->" } };
    const userComment = { id: "a2", data: { text: "Done, try again" } };

    mockFetchNeedsHelpCards.mockResolvedValue(cards);
    mockFetchLatestComment
      .mockResolvedValueOnce(botComment)   // nh1: bot comment
      .mockResolvedValueOnce(userComment)  // nh2: user reply
      .mockResolvedValueOnce(null);        // nh3: no comments
    mockIsUserResponse
      .mockReturnValueOnce(false)  // nh1
      .mockReturnValueOnce(true)   // nh2
      .mockReturnValueOnce(false); // nh3
    mockFetchTodoCards.mockResolvedValue([{ id: "nh2", name: "User replied" }]);

    await poll(MOCK_REPO_CONTEXT);

    // Only nh2 should be moved
    expect(mockMoveCardToList).toHaveBeenCalledTimes(1);
    expect(mockMoveCardToList).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.trello, "nh2", MOCK_REPO_CONTEXT.trello.todoListId, "top");
  });

  it("handles fetchNeedsHelpCards failure gracefully", async () => {
    mockFetchNeedsHelpCards.mockRejectedValue(new Error("API error"));
    mockFetchTodoCards.mockResolvedValue([]);

    // Should not throw — continues to check ToDo
    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });

  it("handles individual card comment check failure gracefully", async () => {
    mockFetchNeedsHelpCards.mockResolvedValue([
      { id: "nh1", name: "Card 1" },
      { id: "nh2", name: "Card 2" },
    ]);
    // First card throws, second succeeds
    mockFetchLatestComment
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce({ id: "a1", data: { text: "User reply" } });
    mockIsUserResponse.mockReturnValue(true);
    mockFetchTodoCards.mockResolvedValue([{ id: "nh2", name: "Card 2" }]);

    await poll(MOCK_REPO_CONTEXT);

    // Only second card should be moved
    expect(mockMoveCardToList).toHaveBeenCalledTimes(1);
    expect(mockMoveCardToList).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.trello, "nh2", MOCK_REPO_CONTEXT.trello.todoListId, "top");
  });

  it("spawns team when Needs Help cards are moved and no ToDo cards existed before", async () => {
    const needsHelpCard = { id: "nh1", name: "User replied" };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue({ id: "a1", data: { text: "Done" } });
    mockIsUserResponse.mockReturnValue(true);
    // After moving, the card appears in ToDo
    mockFetchTodoCards.mockResolvedValue([needsHelpCard]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockSpawn).toHaveBeenCalled();
  });
});

describe("start", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  const savedEnv: Record<string, string | undefined> = {};

  const requiredEnvVars: Record<string, string> = {
    ANTHROPIC_API_KEY: "sk-ant-test",
    GITHUB_TOKEN: "ghp_test",
    REPOS: "test:https://github.com/org/repo.git",
    TRELLO_API_KEY: "trello-key",
    TRELLO_API_TOKEN: "trello-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    setupRepoConfigMocks();
    // Also return true for claude-auth/.claude.json
    const origImpl = mockExistsSync.getMockImplementation()!;
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".claude.json")) return true;
      return origImpl(path);
    });
    // Set required env vars for validation
    for (const [key, value] of Object.entries(requiredEnvVars)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    vi.useRealTimers();
    _resetForTesting();
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("removes stale lock file at startup and proceeds normally", async () => {
    // Lock file exists at startup — should be removed
    // Track whether unlinkSync has been called (simulates lock file removal)
    let lockRemoved = false;
    mockUnlinkSync.mockImplementation(() => { lockRemoved = true; });

    const origImpl = mockExistsSync.getMockImplementation()!;
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes(".poller-running")) return !lockRemoved;
      return origImpl(path);
    });

    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    // poll() is called from start(), no need to pass argument
    start();
    await vi.advanceTimersByTimeAsync(0);

    // Lock file should be removed at startup
    expect(lockRemoved).toBe(true);

    // Should proceed to spawn since lock was cleared
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("does not call unlinkSync when no lock file exists at startup", async () => {
    mockFetchTodoCards.mockResolvedValue([]);

    start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("crashes if unlinkSync fails on stale lock file", () => {
    const origImpl = mockExistsSync.getMockImplementation()!;
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.includes(".poller-running")) return true;
      return origImpl(path);
    });
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });

    expect(() => start()).toThrow("EPERM");
  });
});

describe("startLockWatch — immediate re-poll on completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchTodoCards.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetForTesting();
  });

  it("calls poll immediately when lock file disappears", async () => {
    // First poll: cards available, lock file doesn't exist → spawns team
    mockFetchTodoCards.mockResolvedValueOnce([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Reset mocks to track the re-poll triggered by lock watch
    mockFetchNeedsHelpCards.mockClear();
    mockFetchTodoCards.mockClear();
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);

    // Lock watch checks every 5s — simulate lock file disappearing
    mockExistsSync.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5000);

    // poll() should have been called immediately — verify by checking fetchTodoCards
    expect(mockFetchTodoCards).toHaveBeenCalledTimes(1);
  });

  it("re-poll can spawn a new team if more cards exist", async () => {
    mockFetchTodoCards.mockResolvedValueOnce([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // On re-poll, return another card so a second team spawns
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchTodoCards.mockResolvedValueOnce([{ id: "c2", name: "Card 2" }]);

    mockExistsSync.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("clears interval after detecting lock removal (no repeated polls)", async () => {
    mockFetchTodoCards.mockResolvedValueOnce([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    mockFetchTodoCards.mockClear();
    mockFetchNeedsHelpCards.mockClear();
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);

    // Lock disappears on first check
    mockExistsSync.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockFetchTodoCards).toHaveBeenCalledTimes(1);

    // Advance another 5s — should NOT poll again (interval was cleared)
    mockFetchTodoCards.mockClear();
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockFetchTodoCards).not.toHaveBeenCalled();
  });

  it("does not poll when lock file is still present", async () => {
    mockFetchTodoCards.mockResolvedValueOnce([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    mockFetchTodoCards.mockClear();
    mockFetchNeedsHelpCards.mockClear();

    // Lock file still exists after 5s
    mockExistsSync.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockFetchTodoCards).not.toHaveBeenCalled();
  });
});

describe("shutdown", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  it("removes lock file when no team is running", async () => {
    // Initialize repo state by polling once (no cards, returns immediately)
    mockFetchTodoCards.mockResolvedValue([]);
    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(true);

    shutdown();

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining(".poller-running"),
    );
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("preserves lock file when a team is actively running", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    // Spawn a team so teamRunning becomes true
    await poll(MOCK_REPO_CONTEXT);

    // Now shut down — lock file should NOT be removed
    shutdown();

    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});
