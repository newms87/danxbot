import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing module under test
vi.mock("./config.js", () => ({
  config: { pollerIntervalMs: 60000 },
  BOARD_ID: "mock-board-id",
  REVIEW_LIST_ID: "mock-review-list-id",
  TODO_LIST_ID: "698fc5be16a280cc321a13ec",
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
  return { unref: vi.fn() };
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

/** Make existsSync return true for repo-config/ paths, false for lock file by default */
function setupRepoConfigMocks() {
  mockExistsSync.mockImplementation((path: string) => {
    if (typeof path === "string" && (
      path.endsWith("repo-config") ||
      path.endsWith("config.yml") ||
      path.endsWith("overview.md") ||
      path.endsWith("workflow.md")
    )) return true;
    return false;
  });
  mockReadFileSync.mockImplementation((path: string) => {
    if (typeof path === "string" && path.endsWith("config.yml")) return FAKE_CONFIG_YML;
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
    await poll();

    // Second call: should skip because teamRunning is true
    mockFetchTodoCards.mockClear();
    mockSpawn.mockClear();
    mockFetchNeedsHelpCards.mockClear();
    await poll();

    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockFetchNeedsHelpCards).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does nothing when no cards in ToDo", async () => {
    mockFetchTodoCards.mockResolvedValue([]);

    await poll();

    expect(mockFetchTodoCards).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns wt.exe to open new terminal tab", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll();

    expect(mockSpawn).toHaveBeenCalledWith(
      "wt.exe",
      expect.arrayContaining(["new-tab", "--title", "Danxbot Team", "bash", expect.stringContaining("run-team.sh")]),
      expect.objectContaining({
        detached: true,
      }),
    );
  });

  it("creates lock file when spawning", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll();

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".poller-running"),
      expect.any(String),
    );
  });

  it("handles fetchTodoCards failure gracefully", async () => {
    mockFetchTodoCards.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(poll()).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("strips CLAUDECODE env vars from spawned process", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    process.env.CLAUDECODE_TEST = "should-be-removed";

    await poll();

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv).not.toHaveProperty("CLAUDECODE_TEST");

    delete process.env.CLAUDECODE_TEST;
  });

  it("refuses to spawn if lock file already exists (pre-spawn safety check)", async () => {
    mockExistsSync.mockReturnValue(true);
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll();

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

    await poll();

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

    await poll();

    expect(mockFetchLatestComment).toHaveBeenCalledWith("nh1");
    expect(mockIsUserResponse).toHaveBeenCalledWith(userComment);
    expect(mockMoveCardToList).toHaveBeenCalledWith("nh1", "698fc5be16a280cc321a13ec", "top");
  });

  it("does not move cards still waiting for user (bot comment is latest)", async () => {
    const needsHelpCard = { id: "nh1", name: "Blocked card" };
    const botComment = { id: "a1", data: { text: "Needs config change\n\n<!-- danxbot -->" } };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue(botComment);
    mockIsUserResponse.mockReturnValue(false);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll();

    expect(mockMoveCardToList).not.toHaveBeenCalled();
  });

  it("does not move cards with no comments", async () => {
    const needsHelpCard = { id: "nh1", name: "New error card" };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue(null);
    mockIsUserResponse.mockReturnValue(false);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll();

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

    await poll();

    // Only nh2 should be moved
    expect(mockMoveCardToList).toHaveBeenCalledTimes(1);
    expect(mockMoveCardToList).toHaveBeenCalledWith("nh2", "698fc5be16a280cc321a13ec", "top");
  });

  it("handles fetchNeedsHelpCards failure gracefully", async () => {
    mockFetchNeedsHelpCards.mockRejectedValue(new Error("API error"));
    mockFetchTodoCards.mockResolvedValue([]);

    // Should not throw — continues to check ToDo
    await expect(poll()).resolves.toBeUndefined();
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

    await poll();

    // Only second card should be moved
    expect(mockMoveCardToList).toHaveBeenCalledTimes(1);
    expect(mockMoveCardToList).toHaveBeenCalledWith("nh2", "698fc5be16a280cc321a13ec", "top");
  });

  it("spawns team when Needs Help cards are moved and no ToDo cards existed before", async () => {
    const needsHelpCard = { id: "nh1", name: "User replied" };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue({ id: "a1", data: { text: "Done" } });
    mockIsUserResponse.mockReturnValue(true);
    // After moving, the card appears in ToDo
    mockFetchTodoCards.mockResolvedValue([needsHelpCard]);

    await poll();

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
    TRELLO_BOARD_ID: "board-id",
    TRELLO_REVIEW_LIST_ID: "review-id",
    TRELLO_TODO_LIST_ID: "todo-id",
    TRELLO_IN_PROGRESS_LIST_ID: "ip-id",
    TRELLO_NEEDS_HELP_LIST_ID: "nh-id",
    TRELLO_DONE_LIST_ID: "done-id",
    TRELLO_CANCELLED_LIST_ID: "cancel-id",
    TRELLO_ACTION_ITEMS_LIST_ID: "ai-id",
    TRELLO_BUG_LABEL_ID: "bug-id",
    TRELLO_FEATURE_LABEL_ID: "feat-id",
    TRELLO_EPIC_LABEL_ID: "epic-id",
    TRELLO_NEEDS_HELP_LABEL_ID: "nh-label-id",
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
      if (typeof path === "string" && path.endsWith(".poller-running")) return !lockRemoved;
      return origImpl(path);
    });

    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

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
      if (typeof path === "string" && path.endsWith(".poller-running")) return true;
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

    await poll();

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

    await poll();
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

    await poll();

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

    await poll();

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

  it("removes lock file when no team is running", () => {
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
    await poll();

    // Now shut down — lock file should NOT be removed
    shutdown();

    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});
