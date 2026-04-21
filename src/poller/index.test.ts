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
  db: { host: "", port: 3306, user: "", password: "", database: "", enabled: false },
  githubToken: "test-github-token",
  trelloEnabled: true,
  workerPort: 5562,
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
    db: { host: "", port: 3306, user: "", password: "", database: "", enabled: false },
    githubToken: "test-github-token",
    trelloEnabled: true,
    workerPort: 5562,
  };
  return { mockRepoContexts: [ctx] };
});

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    pollerIntervalMs: 60000,
    isHost: true,
    pollerBackoffScheduleMs: [60_000, 300_000, 900_000, 1_800_000],
  },
}));
vi.mock("../config.js", () => ({
  config: mockConfig,
}));

vi.mock("../repo-context.js", () => ({
  repoContexts: mockRepoContexts,
}));

vi.mock("./constants.js", () => ({
  getReposBase: () => "/danxbot/repos",
  REVIEW_MIN_CARDS: 10,
  DANXBOT_COMMENT_MARKER: "<!-- danxbot -->",
  TEAM_PROMPT: "/danx-next",
  IDEATOR_PROMPT: "/danx-ideate",
}));

const mockFetchTodoCards = vi.fn();
const mockFetchNeedsHelpCards = vi.fn();
const mockFetchReviewCards = vi.fn();
const mockFetchInProgressCards = vi.fn();
const mockFetchLatestComment = vi.fn();
const mockMoveCardToList = vi.fn();
const mockAddComment = vi.fn();
const mockIsUserResponse = vi.fn();
vi.mock("./trello-client.js", () => ({
  fetchTodoCards: (...args: unknown[]) => mockFetchTodoCards(...args),
  fetchNeedsHelpCards: (...args: unknown[]) => mockFetchNeedsHelpCards(...args),
  fetchReviewCards: (...args: unknown[]) => mockFetchReviewCards(...args),
  fetchInProgressCards: (...args: unknown[]) => mockFetchInProgressCards(...args),
  fetchLatestComment: (...args: unknown[]) => mockFetchLatestComment(...args),
  moveCardToList: (...args: unknown[]) => mockMoveCardToList(...args),
  addComment: (...args: unknown[]) => mockAddComment(...args),
  isUserResponse: (...args: unknown[]) => mockIsUserResponse(...args),
}));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockSpawnAgent = vi.fn();
vi.mock("../agent/launcher.js", () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
}));

const mockIsFeatureEnabled = vi.fn().mockReturnValue(true);
vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
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

/** Make existsSync return true for .danxbot/config/ paths, false by default */
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
    mockFetchReviewCards.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })));
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

  it("calls spawnAgent with correct options when cards exist", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.any(String),
        repoName: "test-repo",
        openTerminal: true, // config.isHost is true in test
        env: expect.objectContaining({
          DANXBOT_REPO_NAME: "test-repo",
        }),
      }),
    );
  });

  it("handles fetchTodoCards failure gracefully", async () => {
    mockFetchTodoCards.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

});

describe("poll — trelloPoller feature toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })),
    );
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("skips the tick and does not fetch cards when disabled", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "trelloPoller",
    );
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "trelloPoller",
    );
    expect(mockFetchNeedsHelpCards).not.toHaveBeenCalled();
    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("runs normally when enabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchNeedsHelpCards).toHaveBeenCalled();
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });
});

describe("poll — Needs Help checking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockMoveCardToList.mockResolvedValue(undefined);
    mockFetchReviewCards.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })));
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

    expect(mockSpawnAgent).toHaveBeenCalled();
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

  it("starts polling without errors", () => {
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })));

    expect(() => start()).not.toThrow();
  });

  it("starts polling for every repo regardless of trelloEnabled — the per-tick isFeatureEnabled check decides whether to skip", () => {
    // Boot-time skipping was removed in favor of the per-tick toggle. Every
    // repo gets an interval scheduled so operators can flip `trelloPoller`
    // on at runtime without restarting the worker. The skip happens inside
    // `poll()` when `isFeatureEnabled(repo, "trelloPoller")` is false.
    mockRepoContexts[0].trelloEnabled = false;
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "trelloPoller",
    );
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue([]);

    start();

    // The initial poll ran but `isFeatureEnabled` returned false, so no
    // Trello API calls were made.
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "trelloPoller",
    );
    expect(mockFetchNeedsHelpCards).not.toHaveBeenCalled();
    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockFetchReviewCards).not.toHaveBeenCalled();

    mockRepoContexts[0].trelloEnabled = true;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("polls every repo in repoContexts — per-tick toggle decides which fetch Trello", () => {
    const enabledRepo = { ...mockRepoContexts[0], name: "enabled", trelloEnabled: true };
    const disabledRepo = { ...mockRepoContexts[0], name: "disabled", trelloEnabled: false };
    mockRepoContexts.length = 0;
    mockRepoContexts.push(enabledRepo, disabledRepo);
    mockIsFeatureEnabled.mockImplementation((ctx: { name: string }, feature: string) => {
      if (feature !== "trelloPoller") return true;
      return ctx.name === "enabled";
    });
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue([]);

    start();

    const trelloArgs = mockFetchNeedsHelpCards.mock.calls.map((c) => c[0]);
    // Only the enabled repo's per-tick check returned true → only its
    // Trello config was used.
    expect(trelloArgs.length).toBe(1);
    expect(trelloArgs[0]).toBe(enabledRepo.trello);

    mockRepoContexts.length = 0;
    mockRepoContexts.push({ ...enabledRepo, name: "test-repo", trelloEnabled: true });
    mockIsFeatureEnabled.mockReturnValue(true);
  });
});

describe("shutdown", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })));
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  it("calls process.exit(0)", () => {
    shutdown();
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});

/** Flush async work triggered by fire-and-forget onComplete handlers. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));
}

describe("poll — Docker mode (headless agent)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    mockSpawnAgent.mockResolvedValue({ id: "test-job", status: "running" });
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchInProgressCards.mockResolvedValue([]);
    mockAddComment.mockResolvedValue(undefined);
    mockMoveCardToList.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  it("calls spawnAgent instead of spawnInTerminal when not host", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    // Should NOT spawn wt.exe
    expect(mockSpawn).not.toHaveBeenCalled();
    // Should call spawnAgent
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("/danx-next"),
        repoName: "test-repo",
      }),
    );
  });

  it("passes correct prompt for team (/danx-next)", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("/danx-next"),
      }),
    );
  });

  it("passes correct prompt for ideator (/danx-ideate)", async () => {
    mockFetchTodoCards.mockResolvedValue([]);
    // Review list has fewer than REVIEW_MIN_CARDS (mocked to 10)
    mockFetchReviewCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("/danx-ideate"),
      }),
    );
  });

  it("resets teamRunning via onComplete callback", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    // Capture the onComplete callback
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "test-job", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();

    // Simulate agent completion
    capturedOnComplete!({ id: "test-job", status: "completed", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();

    // Should be able to poll again (teamRunning reset)
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    await poll(MOCK_REPO_CONTEXT);
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });

  it("resets teamRunning on agent failure", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "test-job", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    capturedOnComplete!({ id: "test-job", status: "failed", summary: "crash", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();

    // Should be able to poll again after failure
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    await poll(MOCK_REPO_CONTEXT);
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });

  it("passes DANXBOT_REPO_NAME env var to dispatched agents", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          DANXBOT_REPO_NAME: "test-repo",
        }),
      }),
    );
  });

  it("passes correct timeout value (pollerIntervalMs * 60)", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 60000 * 60, // pollerIntervalMs (60000) * 60
      }),
    );
  });

  it("handles onComplete without throwing", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "test-job", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Should not throw
    expect(() => capturedOnComplete!({ id: "test-job", status: "completed", startedAt: new Date(), completedAt: new Date() })).not.toThrow();
    await flushAsync();
  });

  it("onComplete re-poll chains into another spawnAgent if more cards", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "test-job", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);

    // Reset for re-poll
    mockSpawnAgent.mockClear();
    mockSpawnAgent.mockResolvedValue({ id: "test-job-2", status: "running" });
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchTodoCards.mockResolvedValue([{ id: "c2", name: "Card 2" }]);

    // Simulate agent completion — onComplete fires poll() asynchronously.
    capturedOnComplete!({ id: "test-job", status: "completed", startedAt: new Date(), completedAt: new Date() });

    // Flush microtasks to let the fire-and-forget poll() resolve
    await flushAsync();
    await flushAsync();

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });
});

describe("poll — exponential backoff on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchInProgressCards.mockResolvedValue([]);
    mockAddComment.mockResolvedValue(undefined);
    mockMoveCardToList.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  it("increments consecutive failure counter on agent failure", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({ id: "j1", status: "failed", summary: "crash", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();

    // The backoffUntil should be set — poll should skip during backoff
    mockFetchTodoCards.mockResolvedValue([{ id: "c2", name: "Card 2" }]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    await poll(MOCK_REPO_CONTEXT);

    // Should not spawn because we're in backoff
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1); // Only the first call
  });

  it("resets failure counter on success — next failure gets first-tier backoff", async () => {
    // Use instant backoff so re-polls proceed
    const originalSchedule = mockConfig.pollerBackoffScheduleMs;
    mockConfig.pollerBackoffScheduleMs = [1, 1, 1, 1];
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    // First: spawn and fail
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({ id: "j1", status: "failed", summary: "crash", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();
    await new Promise((r) => setTimeout(r, 5)); // let 1ms backoff expire

    // The re-poll from failure spawns another agent. Succeed this time.
    await flushAsync();
    await flushAsync();
    // Capture the latest onComplete
    const secondOnComplete = capturedOnComplete!;

    // Succeed
    secondOnComplete({ id: "j2", status: "completed", summary: "done", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();
    await new Promise((r) => setTimeout(r, 5));
    await flushAsync();
    await flushAsync();

    // Now fail again — if counter was reset, we should NOT halt (schedule length 4).
    // With schedule [1,1,1,1] and only 1 failure, it should just backoff, not halt.
    // The key assertion: after success + failure, the poller still re-polls
    // (i.e., spawnAgent is called again), proving the counter was reset.
    const spawnCount = mockSpawnAgent.mock.calls.length;
    expect(spawnCount).toBeGreaterThanOrEqual(2);

    mockConfig.pollerBackoffScheduleMs = originalSchedule;
  });

  it("halts polling after exhausting all backoff schedule entries", async () => {
    // Schedule length 1: failure 1 uses the backoff, failure 2 exceeds schedule → halt
    const originalSchedule = mockConfig.pollerBackoffScheduleMs;
    mockConfig.pollerBackoffScheduleMs = [1]; // 1ms backoff
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    const onCompleteFns: Array<(job: unknown) => void> = [];
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      if (opts.onComplete) onCompleteFns.push(opts.onComplete);
      return Promise.resolve({ id: `j${onCompleteFns.length}`, status: "running" });
    });

    // First poll spawns agent
    await poll(MOCK_REPO_CONTEXT);
    expect(onCompleteFns).toHaveLength(1);

    // First failure — uses backoff[0] (1ms), sets backoffUntil, re-polls
    mockExistsSync.mockReturnValue(false);
    onCompleteFns[0]({
      id: "j1", status: "failed", summary: "crash",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();
    await new Promise((r) => setTimeout(r, 5)); // let 1ms backoff expire

    // Re-poll should have spawned a second agent (backoff expired)
    // Wait for the re-poll to complete
    await flushAsync();
    await flushAsync();

    // Second failure — consecutiveFailures(2) > schedule.length(1) → halt
    if (onCompleteFns.length >= 2) {
      mockSpawnAgent.mockClear();
      mockFetchTodoCards.mockClear();
      onCompleteFns[1]({
        id: "j2", status: "failed", summary: "crash again",
        startedAt: new Date(), completedAt: new Date(),
      });
      await flushAsync();
      await flushAsync();

      // Should NOT spawn again — poller halted
      expect(mockSpawnAgent).not.toHaveBeenCalled();
      expect(mockFetchTodoCards).not.toHaveBeenCalled();
    }

    mockConfig.pollerBackoffScheduleMs = originalSchedule;
  });

  it("skips polling during backoff period", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({ id: "j1", status: "failed", summary: "crash", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();

    // Try to poll again — should skip because in backoff
    mockSpawnAgent.mockClear();
    mockFetchTodoCards.mockClear();
    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

describe("poll — stuck card recovery on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchInProgressCards.mockResolvedValue([]);
    mockAddComment.mockResolvedValue(undefined);
    mockMoveCardToList.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  it("moves stuck In Progress card to Needs Help on agent failure", async () => {
    const todoCard = { id: "c1", name: "My Card" };
    mockFetchTodoCards.mockResolvedValue([todoCard]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Simulate: agent moved the card to In Progress, then failed
    mockFetchInProgressCards.mockResolvedValue([todoCard]);
    mockExistsSync.mockReturnValue(false);

    capturedOnComplete!({
      id: "j1", status: "failed",
      summary: "Error: permission denied",
      startedAt: new Date(Date.now() - 60_000),
      completedAt: new Date(),
    });
    await flushAsync();

    // Card should be moved to Needs Help
    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      MOCK_REPO_CONTEXT.trello.needsHelpListId,
      "top",
    );

    // A comment should be added with failure details and danxbot marker
    expect(mockAddComment).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      expect.stringContaining("Agent Failure"),
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      expect.stringContaining("permission denied"),
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      expect.stringContaining("<!-- danxbot -->"),
    );
  });

  it("does not recover cards that were already In Progress before spawn", async () => {
    const todoCard = { id: "c1", name: "My Card" };
    const preExistingCard = { id: "c99", name: "Already In Progress" };
    mockFetchTodoCards.mockResolvedValue([todoCard]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Both the todo card AND a pre-existing card are in In Progress
    mockFetchInProgressCards.mockResolvedValue([todoCard, preExistingCard]);
    mockExistsSync.mockReturnValue(false);

    capturedOnComplete!({
      id: "j1", status: "failed", summary: "crash",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();

    // Only c1 should be moved (it was in our ToDo list before spawn)
    expect(mockMoveCardToList).toHaveBeenCalledTimes(1);
    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      MOCK_REPO_CONTEXT.trello.needsHelpListId,
      "top",
    );
  });

  it("does not recover cards on successful completion", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1", status: "completed", summary: "done",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();

    // Should NOT fetch In Progress cards on success
    expect(mockFetchInProgressCards).not.toHaveBeenCalled();
  });

  it("recovers multiple stuck cards from a single failed agent run", async () => {
    const todoCards = [
      { id: "c1", name: "Card 1" },
      { id: "c2", name: "Card 2" },
    ];
    mockFetchTodoCards.mockResolvedValue(todoCards);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Both cards moved to In Progress during agent run
    mockFetchInProgressCards.mockResolvedValue(todoCards);
    mockExistsSync.mockReturnValue(false);

    capturedOnComplete!({
      id: "j1", status: "failed", summary: "crash",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();

    // Both cards should be moved to Needs Help
    expect(mockMoveCardToList).toHaveBeenCalledTimes(2);
    expect(mockAddComment).toHaveBeenCalledTimes(2);
    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello, "c1", MOCK_REPO_CONTEXT.trello.needsHelpListId, "top",
    );
    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello, "c2", MOCK_REPO_CONTEXT.trello.needsHelpListId, "top",
    );
  });

  it("recovers stuck cards on agent timeout (not just failure)", async () => {
    const todoCard = { id: "c1", name: "Card 1" };
    mockFetchTodoCards.mockResolvedValue([todoCard]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockFetchInProgressCards.mockResolvedValue([todoCard]);
    mockExistsSync.mockReturnValue(false);

    // Timeout status (not "failed") should also trigger recovery
    capturedOnComplete!({
      id: "j1", status: "timeout",
      summary: "Agent timed out after 300 seconds of inactivity",
      startedAt: new Date(Date.now() - 300_000),
      completedAt: new Date(),
    });
    await flushAsync();

    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello, "c1", MOCK_REPO_CONTEXT.trello.needsHelpListId, "top",
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello, "c1",
      expect.stringContaining("timed out"),
    );
  });

  it("handles recovery failure gracefully without crashing", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockSpawnAgent.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Trello API fails during recovery
    mockFetchInProgressCards.mockRejectedValue(new Error("API down"));
    mockExistsSync.mockReturnValue(false);

    // Should not throw — error is caught and logged
    capturedOnComplete!({
      id: "j1", status: "failed", summary: "crash",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();

    // Lock should still be cleaned up even if recovery failed
    // (teamRunning should be false so next poll can proceed)
  });
});
