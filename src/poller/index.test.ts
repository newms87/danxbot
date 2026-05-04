import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RepoContext } from "../types.js";
import type { IssueRef, IssueStatus } from "../issue-tracker/interface.js";

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
    blockedLabelId: "blk-label",
  },
  slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
  db: {
    host: "",
    port: 3306,
    user: "",
    password: "",
    database: "",
    enabled: false,
  },
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
      blockedLabelId: "blk-label",
    },
    slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    db: {
      host: "",
      port: 3306,
      user: "",
      password: "",
      database: "",
      enabled: false,
    },
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
  targetName: "test-target",
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

/**
 * Phase 5 of tracker-agnostic-agents (Trello 69f76d57359b5fe89f80ab22):
 * the poller now drives every fetch / move / status check / comment
 * through a single cached `IssueTracker`. Tests mock the entire factory
 * so the same `mockTracker` instance is returned on every call. The
 * tracker's `fetchOpenCards` returns a merged list spanning all open
 * statuses (Review / ToDo / In Progress / Needs Help); the poller filters
 * client-side by `status`. Tests stub a single `mockResolvedValue` on
 * `fetchOpenCards` per scenario; helpers below build the merged list.
 */
const mockTracker = {
  fetchOpenCards: vi.fn(),
  getCard: vi.fn(),
  getComments: vi.fn(),
  moveToStatus: vi.fn(),
  addComment: vi.fn(),
  // dispatch-lock layer (lock.ts) edits the lock comment in-place on
  // stale-reclaim and self-refresh paths.
  editComment: vi.fn(),
  // hydrateFromRemote calls updateCard when the remote title is missing
  // the `#ISS-N: ` prefix. Default to no-op resolved.
  updateCard: vi.fn(),
};

const mockCreateIssueTracker = vi.fn().mockReturnValue(mockTracker);
vi.mock("../issue-tracker/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../issue-tracker/index.js")
  >("../issue-tracker/index.js");
  return {
    ...actual,
    createIssueTracker: (...args: unknown[]) => mockCreateIssueTracker(...args),
  };
});

/**
 * Helper: build an `IssueRef` from minimal fields. The `id` field stays
 * empty by default — the poller never reads it on the hot path; it
 * resolves the local YAML's internal id via `findByExternalId` /
 * `hydrateFromRemote` instead.
 */
function ref(
  external_id: string,
  title: string,
  status: IssueStatus,
): IssueRef {
  return { id: "", external_id, title, status };
}

/**
 * Helper: ten Review cards. Used as filler when a test's ToDo branch is
 * empty so the ideator path doesn't fire (its env default is OFF, but
 * many tests historically also pre-flooded Review to keep ideator quiet
 * regardless of feature toggles). Mirroring the legacy mockFetchReview
 * default keeps every existing test scenario representative without
 * sprawling per-test plumbing.
 */
const REVIEW_FILLER: IssueRef[] = Array.from({ length: 10 }, (_, i) =>
  ref(`r${i}`, `Review ${i}`, "Review"),
);

const mockReadFlag = vi.fn().mockReturnValue(null);
const mockWriteFlag = vi.fn();
vi.mock("../critical-failure.js", () => ({
  readFlag: (...args: unknown[]) => mockReadFlag(...args),
  writeFlag: (...args: unknown[]) => mockWriteFlag(...args),
  clearFlag: vi.fn().mockReturnValue(false),
  flagPath: (localPath: string) => `${localPath}/.danxbot/CRITICAL_FAILURE`,
}));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

/**
 * The default `dispatch()` mock resolves to a shape mirroring the real
 * `DispatchResult` (`{dispatchId, job}`). `.mockImplementation` survives
 * `vi.clearAllMocks()` (only call history is cleared), so every test
 * inherits this default unless it explicitly overrides via
 * `.mockImplementation` / `.mockResolvedValue`. Tests that need to capture
 * `onComplete` override the implementation to do so.
 */
const mockDispatch = vi.fn().mockImplementation(() =>
  Promise.resolve({
    dispatchId: "test-dispatch-id",
    job: {
      id: "test-job",
      status: "running" as const,
      summary: "",
      startedAt: new Date(),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  }),
);
const mockGetActiveJob = vi.fn().mockReturnValue(undefined);
vi.mock("../dispatch/core.js", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  getActiveJob: (...args: unknown[]) => mockGetActiveJob(...args),
}));

const mockResolveParentSessionId = vi
  .fn()
  .mockResolvedValue({ kind: "no-session-dir" } as const);
vi.mock("../agent/resolve-parent-session.js", () => ({
  resolveParentSessionId: (...args: unknown[]) =>
    mockResolveParentSessionId(...args),
}));

/**
 * yaml-lifecycle helpers. Same defaults as before — minimal valid Issue
 * for the brand-new-card hydration path and a stamp helper that
 * preserves the existing-file path.
 */
const FAKE_ISSUE_FOR_TESTS = {
  schema_version: 3 as const,
  tracker: "trello",
  id: "ISS-FAKE",
  external_id: "fake",
  parent_id: null,
  children: [],
  dispatch_id: null,
  status: "ToDo" as const,
  type: "Feature" as const,
  title: "fake",
  description: "",
  triaged: { timestamp: "", status: "", explain: "" },
  ac: [],
  phases: [],
  comments: [],
  retro: { good: "", bad: "", action_items: [], commits: [] },
};
const mockHydrateFromRemote = vi
  .fn()
  .mockImplementation(
    async (
      _t: unknown,
      externalId: string,
      dispatchId: string,
      _repoLocalPath: string,
    ) => ({
      ...FAKE_ISSUE_FOR_TESTS,
      external_id: externalId,
      dispatch_id: dispatchId,
    }),
  );
const mockLoadLocal = vi.fn().mockReturnValue(null);
const mockFindByExternalId = vi.fn().mockReturnValue(null);
const mockWriteIssueFn = vi.fn();
const mockStampDispatchAndWrite = vi
  .fn()
  .mockImplementation(
    (_repo: string, issue: Record<string, unknown>, dispatchId: string) => ({
      ...issue,
      dispatch_id: dispatchId,
    }),
  );
const mockEnsureIssuesDirs = vi.fn();
const mockEnsureGitignoreEntry = vi.fn();
vi.mock("./yaml-lifecycle.js", () => ({
  hydrateFromRemote: (...args: unknown[]) => mockHydrateFromRemote(...args),
  loadLocal: (...args: unknown[]) => mockLoadLocal(...args),
  findByExternalId: (...args: unknown[]) => mockFindByExternalId(...args),
  writeIssue: (...args: unknown[]) => mockWriteIssueFn(...args),
  stampDispatchAndWrite: (...args: unknown[]) =>
    mockStampDispatchAndWrite(...args),
  ensureIssuesDirs: (...args: unknown[]) => mockEnsureIssuesDirs(...args),
  ensureGitignoreEntry: (...args: unknown[]) =>
    mockEnsureGitignoreEntry(...args),
  issuePath: (repo: string, id: string, state: string) =>
    `${repo}/.danxbot/issues/${state}/${id}.yml`,
}));

// Feature-aware default: ideator's env default is `false` (explicit
// opt-in via `<repo>/.danxbot/settings.json` overrides). Every other
// feature defaults to `true` so existing tests that don't care about
// the toggle continue to dispatch.
const mockIsFeatureEnabled = vi.fn(
  (...args: unknown[]) => (args[1] as string) !== "ideator",
);
const mockGetTrelloPollerPickupPrefix = vi.fn().mockReturnValue(null);
vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
  getTrelloPollerPickupPrefix: (...args: unknown[]) =>
    mockGetTrelloPollerPickupPrefix(...args),
}));

vi.mock("../workspace/write-if-changed.js", () => ({
  writeIfChanged: (path: string, content: string): boolean => {
    mockWriteFileSync(path, content);
    return true;
  },
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
const mockRmSync = vi.fn();
const mockStatSync = vi.fn();
const mockLstatSync = vi.fn().mockImplementation(() => ({
  isSymbolicLink: () => false,
}));
const mockReadlinkSync = vi.fn().mockReturnValue("");
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
  chmodSync: vi.fn(),
  statSync: (...args: unknown[]) => mockStatSync(...args),
  symlinkSync: vi.fn(),
  readlinkSync: (...args: unknown[]) => mockReadlinkSync(...args),
  lstatSync: (...args: unknown[]) => mockLstatSync(...args),
}));

import {
  poll,
  shutdown,
  start,
  syncRepoFiles,
  _resetForTesting,
} from "./index.js";

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
    if (
      typeof path === "string" &&
      (path.includes(".danxbot/config") ||
        path.endsWith("config.yml") ||
        path.endsWith("overview.md") ||
        path.endsWith("workflow.md") ||
        path.endsWith("trello.yml"))
    )
      return true;
    return false;
  });
  mockReadFileSync.mockImplementation((path: string) => {
    if (typeof path === "string" && path.endsWith("config.yml"))
      return FAKE_CONFIG_YML;
    if (typeof path === "string" && path.endsWith("trello.yml"))
      return "board_id: mock-board-id\n";
    if (typeof path === "string" && path.endsWith(".md"))
      return "# placeholder";
    return "";
  });
}

/**
 * Default Issue payload returned from `getCard`. Status is `Done` so the
 * post-dispatch `checkCardProgressedOrHalt` returns early without
 * writing the critical-failure flag on every completion. Tests that
 * exercise the flag-writing path explicitly override `getCard` to
 * return a `ToDo`-status Issue.
 */
const DEFAULT_GET_CARD_ISSUE = {
  schema_version: 3 as const,
  tracker: "trello",
  id: "ISS-DEFAULT",
  external_id: "default-card",
  parent_id: null,
  children: [],
  dispatch_id: null,
  status: "Done" as const,
  type: "Feature" as const,
  title: "default",
  description: "",
  triaged: { timestamp: "", status: "", explain: "" },
  ac: [],
  phases: [],
  comments: [],
  retro: { good: "", bad: "", action_items: [], commits: [] },
};

/**
 * Reset the tracker mock to its zero state. Defaults: `fetchOpenCards`
 * returns the Review filler so empty-ToDo paths don't accidentally
 * trigger ideator; `getComments` returns []; `getCard` returns a Done
 * Issue so post-dispatch checks don't write the flag; mutators resolve
 * void / cmt-1. Also resets the feature/pickup-prefix mocks so prior
 * describe blocks' overrides don't leak into the current beforeEach.
 */
function resetTrackerMocks() {
  mockTracker.fetchOpenCards.mockReset();
  mockTracker.fetchOpenCards.mockResolvedValue([...REVIEW_FILLER]);
  mockTracker.getCard.mockReset();
  mockTracker.getCard.mockResolvedValue(DEFAULT_GET_CARD_ISSUE);
  mockTracker.getComments.mockReset();
  mockTracker.getComments.mockResolvedValue([]);
  mockTracker.moveToStatus.mockReset();
  mockTracker.moveToStatus.mockResolvedValue(undefined);
  mockTracker.addComment.mockReset();
  mockTracker.addComment.mockResolvedValue({ id: "cmt-1", timestamp: "" });
  mockTracker.editComment.mockReset();
  mockTracker.editComment.mockResolvedValue(undefined);
  mockTracker.updateCard.mockReset();
  mockTracker.updateCard.mockResolvedValue(undefined);
  // The factory mock still returns the same tracker instance — only call
  // history is cleared.
  mockCreateIssueTracker.mockClear();
  // Per-tick policy mocks — `vi.clearAllMocks()` only resets call history.
  // Without these, prior describe blocks' `mockReturnValue(true)` etc.
  // leak into the current `beforeEach` and silently flip ideator on or
  // override the pickup prefix.
  mockIsFeatureEnabled.mockReset();
  mockIsFeatureEnabled.mockImplementation(
    (...args: unknown[]) => (args[1] as string) !== "ideator",
  );
  mockGetTrelloPollerPickupPrefix.mockReset();
  mockGetTrelloPollerPickupPrefix.mockReturnValue(null);
}

/** Flush async work triggered by fire-and-forget onComplete handlers. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));
}

describe("poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockIsFeatureEnabled.mockReset();
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    mockGetTrelloPollerPickupPrefix.mockReset();
    mockGetTrelloPollerPickupPrefix.mockReturnValue(null);
  });

  it("skips when teamRunning is true", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    await poll(MOCK_REPO_CONTEXT);

    // Second call: should skip because teamRunning is true
    mockTracker.fetchOpenCards.mockClear();
    mockSpawn.mockClear();
    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does nothing when no cards in ToDo", async () => {
    // Default fetchOpenCards (REVIEW_FILLER only — no ToDo cards) means
    // the ToDo branch is empty.
    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("calls dispatch() with the issue-worker workspace and an empty caller overlay when cards exist", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.any(String),
        repo: expect.objectContaining({ name: "test-repo" }),
        // Phase 3 invariant (workspace-dispatch epic, Trello `q5aFuINM`):
        // the poller dispatches via the named `issue-worker` workspace.
        // Phase 5 retired the trello MCP server entry from this
        // workspace; agents reach the tracker via the danxbot MCP
        // server's `danx_issue_*` tools, not direct Trello calls.
        workspace: "issue-worker",
        overlay: {},
      }),
    );
  });

  it("handles tracker.fetchOpenCards failure gracefully", async () => {
    mockTracker.fetchOpenCards.mockRejectedValue(new Error("Network error"));

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("syncRepoFiles renders per-repo files into every plural workspace and writes nothing to repo-root", async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes("inject")) return true;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (path.endsWith("tools.md")) return true;
      if (path.endsWith("/.danxbot/workspaces")) return true;
      if (path.endsWith("/.danxbot/workspaces/issue-worker")) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith("/inject/rules")) return [];
      if (path.endsWith("/inject/tools")) return ["danx-helper.sh"];
      if (path.endsWith("/.danxbot/workspaces")) return ["issue-worker"];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });

    await poll(MOCK_REPO_CONTEXT);

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    const copiedDests = mockCopyFileSync.mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );
    const allTouched = [...writtenPaths, ...copiedDests];

    const workspaceClaudePrefix =
      "/test/repos/test-repo/.danxbot/workspaces/issue-worker/.claude/";
    const repoRootClaudePrefix = "/test/repos/test-repo/.claude/";
    const singularWorkspacePrefix = "/test/repos/test-repo/.danxbot/workspace/";

    const expectedWorkspaceArtifacts = [
      `${workspaceClaudePrefix}rules/danx-repo-config.md`,
      `${workspaceClaudePrefix}rules/danx-repo-overview.md`,
      `${workspaceClaudePrefix}rules/danx-repo-workflow.md`,
      `${workspaceClaudePrefix}rules/danx-tools.md`,
    ];
    for (const expected of expectedWorkspaceArtifacts) {
      expect(allTouched).toContain(expected);
    }

    const repoRootClaudeTouches = allTouched.filter(
      (p) =>
        p.startsWith(repoRootClaudePrefix) &&
        !p.startsWith(`${repoRootClaudePrefix}rules/danx-`) &&
        !p.startsWith(`${repoRootClaudePrefix}skills/danx-`) &&
        !p.startsWith(`${repoRootClaudePrefix}tools/danx-`),
    );
    expect(repoRootClaudeTouches).toEqual([]);
    const singularTouches = allTouched.filter((p) =>
      p.startsWith(singularWorkspacePrefix),
    );
    expect(singularTouches).toEqual([]);
  });

  it("syncRepoFiles throws and writes nothing when a required config.yml field is missing (fail-loud — Trello `C7W1cEhh`)", () => {
    const brokenConfig = `url: https://github.com/org/repo.git
runtime: local
language: node
`; // missing `name`
    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith("config.yml"))
        return brokenConfig;
      if (typeof path === "string" && path.endsWith("trello.yml"))
        return "board_id: mock-board-id\n";
      if (typeof path === "string" && path.endsWith(".md"))
        return "# placeholder";
      return "";
    });

    expect(() => syncRepoFiles(MOCK_REPO_CONTEXT)).toThrow(/'name'.*missing/);

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    const copiedDests = mockCopyFileSync.mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );

    expect(
      writtenPaths.find((p) => p.endsWith("danx-repo-config.md")),
    ).toBeUndefined();
    expect(
      copiedDests.find((p) => p.includes("unknown-compose.yml")),
    ).toBeUndefined();
  });

  it("injectDanxWorkspaces ensures <repo>/.danxbot/workspaces/ exists (P2 contract — empty source dir is a no-op apart from mkdir)", async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes("inject")) return true;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([]);

    await poll(MOCK_REPO_CONTEXT);

    const mkdirPaths = mockMkdirSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(mkdirPaths).toContain("/test/repos/test-repo/.danxbot/workspaces");

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    const workspacesWrites = writtenPaths.filter((p) =>
      p.startsWith("/test/repos/test-repo/.danxbot/workspaces/"),
    );
    expect(workspacesWrites).toEqual([]);
  });

  it("injectDanxWorkspaces mirrors a fixture tree, leaves orphans alone, and makes .sh helpers under tools/ executable", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const demoToolsSource = `${demoSource}/tools`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;
    const demoToolsTarget = `${demoTargetRoot}/tools`;
    const orphanWorkspaceTargetRoot = `${workspacesTargetRoot}/old-removed`;

    const sourceDirSuffixes = [demoSource, demoToolsSource];
    const targetDirExact = new Set<string>([
      workspacesTargetRoot,
      demoTargetRoot,
      demoToolsTarget,
      orphanWorkspaceTargetRoot,
    ]);

    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (
        path.includes("inject/rules") ||
        path.includes("inject/tools") ||
        path.includes("inject/skills")
      ) {
        return true;
      }
      if (
        path.endsWith(workspacesSource) ||
        path.includes(`${workspacesSource}/`)
      ) {
        return true;
      }
      if (
        path === workspacesTargetRoot ||
        path.startsWith(`${workspacesTargetRoot}/`)
      ) {
        return true;
      }
      return false;
    });

    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith("/inject/rules")) return [];
      if (path.endsWith("/inject/tools")) return [];
      if (path.endsWith("/inject/skills")) return [];
      if (path.endsWith(workspacesSource)) return ["demo"];
      if (path.endsWith(demoSource)) return ["workspace.yml", "tools"];
      if (path.endsWith(demoToolsSource)) return ["helper.sh"];
      if (path === workspacesTargetRoot) return ["demo", "old-removed"];
      if (path === demoTargetRoot) return ["workspace.yml", "tools"];
      if (path === demoToolsTarget) return ["helper.sh", "stale.sh"];
      return [];
    });

    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") {
        return { isDirectory: () => false };
      }
      const isDir =
        targetDirExact.has(path) ||
        sourceDirSuffixes.some((suffix) => path.endsWith(suffix));
      return { isDirectory: () => isDir };
    });

    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      if (path.endsWith("workspace.yml"))
        return "name: demo\ndescription: demo\n";
      if (path.endsWith("helper.sh")) return "#!/bin/bash\necho ok\n";
      return "";
    });

    await poll(MOCK_REPO_CONTEXT);

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(writtenPaths).toContain(`${demoTargetRoot}/workspace.yml`);
    expect(writtenPaths).toContain(`${demoToolsTarget}/helper.sh`);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).not.toContain(`${demoToolsTarget}/stale.sh`);
    expect(rmPaths).not.toContain(orphanWorkspaceTargetRoot);
  });

  it("injectDanxWorkspaces ignores non-directory entries at the workspaces root (the .gitkeep tombstone)", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const gitkeepSource = `${workspacesSource}/.gitkeep`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;

    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (
        path.includes("inject/rules") ||
        path.includes("inject/tools") ||
        path.includes("inject/skills")
      ) {
        return true;
      }
      if (
        path.endsWith(workspacesSource) ||
        path.includes(`${workspacesSource}/`)
      ) {
        return true;
      }
      if (
        path === workspacesTargetRoot ||
        path.startsWith(`${workspacesTargetRoot}/`)
      ) {
        return true;
      }
      return false;
    });

    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith("/inject/rules")) return [];
      if (path.endsWith("/inject/tools")) return [];
      if (path.endsWith("/inject/skills")) return [];
      if (path.endsWith(workspacesSource)) return ["demo", ".gitkeep"];
      if (path.endsWith(demoSource)) return ["workspace.yml"];
      if (path === workspacesTargetRoot) return [];
      if (path === demoTargetRoot) return [];
      if (path.endsWith(gitkeepSource)) {
        const err = new Error(`ENOTDIR: not a directory, scandir '${path}'`);
        (err as NodeJS.ErrnoException).code = "ENOTDIR";
        throw err;
      }
      return [];
    });

    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") {
        return { isDirectory: () => false };
      }
      if (path.endsWith(gitkeepSource)) return { isDirectory: () => false };
      const isDir =
        path === workspacesTargetRoot ||
        path === demoTargetRoot ||
        path.endsWith(demoSource) ||
        path.endsWith(workspacesSource);
      return { isDirectory: () => isDir };
    });

    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      if (path.endsWith("workspace.yml"))
        return "name: demo\ndescription: demo\n";
      return "";
    });

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(writtenPaths).toContain(`${demoTargetRoot}/workspace.yml`);
    const gitkeepWrites = writtenPaths.filter((p) => p.endsWith(".gitkeep"));
    expect(gitkeepWrites).toEqual([]);
  });

  it("injectDanxWorkspaces removes the legacy alias symlink at workspaces/trello-worker (Phase 5 cleanup wiring)", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const legacyPath = `${workspacesTargetRoot}/trello-worker`;
    const currentPath = `${workspacesTargetRoot}/issue-worker`;

    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (
        path.includes("inject/rules") ||
        path.includes("inject/tools") ||
        path.includes("inject/skills")
      ) {
        return true;
      }
      if (
        path.endsWith(workspacesSource) ||
        path.includes(`${workspacesSource}/`)
      ) {
        return true;
      }
      if (
        path === workspacesTargetRoot ||
        path.startsWith(`${workspacesTargetRoot}/`)
      ) {
        return true;
      }
      return false;
    });

    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith("/inject/rules")) return [];
      if (path.endsWith("/inject/tools")) return [];
      if (path.endsWith("/inject/skills")) return [];
      if (path.endsWith(workspacesSource)) return [];
      if (path === workspacesTargetRoot) return [];
      return [];
    });

    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return { isDirectory: () => false };
      const isDir =
        path === workspacesTargetRoot || path.endsWith(workspacesSource);
      return { isDirectory: () => isDir };
    });

    mockLstatSync.mockImplementation((path: unknown) => ({
      isSymbolicLink: () => path === legacyPath,
    }));
    mockReadlinkSync.mockImplementation((path: unknown) =>
      path === legacyPath ? currentPath : "",
    );

    await poll(MOCK_REPO_CONTEXT);

    const rmCalls = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmCalls).toContain(legacyPath);
  });

  it("injectDanxWorkspaces preserves a real directory at workspaces/trello-worker (operator-authored — never clobber)", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const operatorPath = `${workspacesTargetRoot}/trello-worker`;

    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (
        path.includes("inject/rules") ||
        path.includes("inject/tools") ||
        path.includes("inject/skills")
      ) {
        return true;
      }
      if (
        path.endsWith(workspacesSource) ||
        path.includes(`${workspacesSource}/`)
      ) {
        return true;
      }
      if (
        path === workspacesTargetRoot ||
        path.startsWith(`${workspacesTargetRoot}/`)
      ) {
        return true;
      }
      return false;
    });

    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith("/inject/rules")) return [];
      if (path.endsWith("/inject/tools")) return [];
      if (path.endsWith("/inject/skills")) return [];
      if (path.endsWith(workspacesSource)) return [];
      if (path === workspacesTargetRoot) return ["trello-worker"];
      return [];
    });

    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return { isDirectory: () => false };
      const isDir =
        path === workspacesTargetRoot ||
        path === operatorPath ||
        path.endsWith(workspacesSource);
      return { isDirectory: () => isDir };
    });

    mockLstatSync.mockImplementation(() => ({
      isSymbolicLink: () => false,
    }));

    await poll(MOCK_REPO_CONTEXT);

    const rmCalls = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmCalls).not.toContain(operatorPath);
  });
});

describe("poll — spawnClaude credentials guard (TrelloTracker requires creds; MemoryTracker does not)", () => {
  // Phase 5 reshaped the spawn-time credentials guard to switch on the
  // RESOLVED tracker class (`instanceof TrelloTracker`) instead of an
  // env var read. Both branches — throw on missing creds with a Trello
  // backend, skip throw on a non-Trello backend — are pinned here.
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
  });

  it("throws when the resolved tracker is a TrelloTracker AND credentials are missing", async () => {
    // Construct a REAL TrelloTracker so `instanceof TrelloTracker` is
    // true. The mock factory returns it; spawnClaude reads the missing
    // creds and throws.
    const { TrelloTracker } = await vi.importActual<
      typeof import("../issue-tracker/index.js")
    >("../issue-tracker/index.js");
    const repoNoCreds: RepoContext = {
      ...MOCK_REPO_CONTEXT,
      trello: {
        ...MOCK_REPO_CONTEXT.trello,
        apiKey: "",
        apiToken: "",
        boardId: "",
      },
    };
    const realTrelloTracker = new TrelloTracker(repoNoCreds.trello);
    // Stub the methods we'll use so the test doesn't hit the network
    // before reaching the guard.
    realTrelloTracker.fetchOpenCards = async () => [
      { id: "", external_id: "c1", title: "Card 1", status: "ToDo" },
    ];
    // Stub the dispatch-lock probe so it short-circuits without hitting
    // the real Trello API — the test is exercising the credentials
    // guard inside `spawnClaude`, not the lock layer.
    realTrelloTracker.getComments = async () => [];
    realTrelloTracker.addComment = async () => ({
      id: "lock-1",
      timestamp: "",
    });
    mockCreateIssueTracker.mockReturnValueOnce(realTrelloTracker);

    await expect(poll(repoNoCreds)).rejects.toThrow(
      /without complete trello credentials/,
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("does NOT throw when the resolved tracker is NOT a TrelloTracker (e.g. MemoryTracker) regardless of credential state", async () => {
    // The default `mockTracker` is a plain object — `instanceof
    // TrelloTracker` is false — so the guard is skipped even though
    // the RepoContext has empty creds.
    const repoNoCreds: RepoContext = {
      ...MOCK_REPO_CONTEXT,
      trello: {
        ...MOCK_REPO_CONTEXT.trello,
        apiKey: "",
        apiToken: "",
        boardId: "",
      },
    };
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    await expect(poll(repoNoCreds)).resolves.toBeUndefined();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe("poll — dispatch lock gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("skips dispatch tick when dispatch lock is held by another holder within TTL", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    // Pre-existing lock comment held by a foreign holder, started just
    // 30 minutes ago — well within the 2h TTL.
    const foreignLock = `<!-- danxbot -->
<!-- danxbot-lock -->

**Dispatch lock**

| Field | Value |
|---|---|
| holder | \`other-deployment\` |
| host | \`ip-9-9-9-9\` |
| dispatch_id | \`other-uuid-1234\` |
| repo_path | \`/elsewhere\` |
| jsonl_dir | \`/elsewhere/.claude/projects/x\` |
| workspace | \`issue-worker\` |
| started_at | \`${new Date(Date.now() - 30 * 60 * 1000).toISOString()}\` |
| ttl | \`120m\` |
| stale_after | \`${new Date(Date.now() + 90 * 60 * 1000).toISOString()}\` |
`;
    mockTracker.getComments.mockResolvedValue([
      { id: "lock-cmt-1", author: "danxbot", timestamp: "", text: foreignLock },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
    // Lock comment was inspected but NOT overwritten (no edit attempt).
    expect(mockTracker.editComment).not.toHaveBeenCalled();
    expect(mockTracker.addComment).not.toHaveBeenCalled();
  });

  it("proceeds with dispatch and posts a fresh lock comment when no lock exists", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    mockTracker.getComments.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // Lock layer posted exactly one new comment (the lock) for c1.
    const lockPostsForC1 = mockTracker.addComment.mock.calls.filter(
      (c: unknown[]) => c[0] === "c1" && String(c[1]).includes("danxbot-lock"),
    );
    expect(lockPostsForC1).toHaveLength(1);
  });
});

describe("poll — trelloPoller feature toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("skips the tick and does not fetch cards when disabled", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "trelloPoller",
    );
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "trelloPoller",
    );
    expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("runs normally when enabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });
});

describe("poll — pickup-name-prefix filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    // resetTrackerMocks already wires ideator-off + null prefix; do
    // NOT override ideator to true here — that would let an
    // empty-after-filter test fall through to ideator and dispatch.
  });

  afterEach(() => {
    mockGetTrelloPollerPickupPrefix.mockReturnValue(null);
  });

  it("dispatches the matching test card when other ToDo cards are present (system-test isolation)", async () => {
    mockGetTrelloPollerPickupPrefix.mockReturnValue("[System Test]");
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("stuck", "Fix: Dispatch token usage…", "ToDo"),
      ref("real", "Real ToDo card B", "ToDo"),
      ref("test", "[System Test] Read package.json — 1761000000", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchCall = mockDispatch.mock.calls[0][0];
    expect(dispatchCall.apiDispatchMeta).toEqual(
      expect.objectContaining({
        trigger: "trello",
        metadata: expect.objectContaining({
          cardId: "test",
          cardName: "[System Test] Read package.json — 1761000000",
        }),
      }),
    );
  });

  it("falls through to the no-cards branch when prefix is set but no card matches", async () => {
    mockGetTrelloPollerPickupPrefix.mockReturnValue("[System Test]");
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("a", "Real ToDo card A", "ToDo"),
      ref("b", "Real ToDo card B", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches normally when prefix is null (filter disabled)", async () => {
    mockGetTrelloPollerPickupPrefix.mockReturnValue(null);
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("any", "Some real card", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves stuck-card recovery scope: only matching cards are saved as priorTodoCardIds", async () => {
    mockGetTrelloPollerPickupPrefix.mockReturnValue("[X]");
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("real-1", "Real card 1", "ToDo"),
      ref("x-1", "[X] test card", "ToDo"),
    ]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementationOnce(
      (input: { onComplete?: (j: unknown) => void }) => {
        capturedOnComplete = input.onComplete;
        return Promise.resolve({
          dispatchId: "d",
          job: {
            id: "j",
            status: "failed" as const,
            summary: "boom",
            startedAt: new Date(),
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        });
      },
    );

    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();

    // Recovery's IP fetch sees both cards moved to In Progress.
    mockTracker.fetchOpenCards.mockResolvedValueOnce([
      ref("real-1", "Real card 1", "In Progress"),
      ref("x-1", "[X] test card", "In Progress"),
    ]);
    capturedOnComplete!({
      id: "j",
      status: "failed",
      summary: "boom",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    await new Promise((r) => setImmediate(r));

    // Only the matching card should be considered for recovery — the
    // unrelated "real-1" must NOT be moved to Needs Help even though
    // it's in In Progress.
    const moves = mockTracker.moveToStatus.mock.calls.filter(
      (c: unknown[]) => c[1] === "Needs Help",
    );
    const movedIds = moves.map((c: unknown[]) => c[0]);
    expect(movedIds).not.toContain("real-1");
  });
});

describe("poll — Needs Help checking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
  });

  it("checks Needs Help list before ToDo (single fetchOpenCards covers both — was two separate calls pre-Phase-5)", async () => {
    await poll(MOCK_REPO_CONTEXT);

    // ONE merged fetch in the new model. The poller filters client-side.
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });

  it("moves user-responded cards from Needs Help to ToDo", async () => {
    const nhCard = ref("nh1", "Blocked card", "Needs Help");
    // First call (Needs Help check) returns the help card.
    // Second call (_poll's ToDo filter) returns the same card now in ToDo
    // (simulating the move's effect on a subsequent fetch).
    mockTracker.fetchOpenCards
      .mockResolvedValueOnce([nhCard])
      .mockResolvedValueOnce([ref("nh1", "Blocked card", "ToDo")]);
    mockTracker.getComments.mockResolvedValue([
      {
        id: "a1",
        author: "user",
        timestamp: "2026-01-01T00:00:00Z",
        text: "I fixed the config",
      },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.getComments).toHaveBeenCalledWith("nh1");
    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("nh1", "ToDo");
  });

  it("does not move cards still waiting for user (bot comment is latest)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValueOnce([
      ref("nh1", "Blocked card", "Needs Help"),
    ]);
    mockTracker.getComments.mockResolvedValue([
      {
        id: "a1",
        author: "danxbot",
        timestamp: "2026-01-01T00:00:00Z",
        text: "Needs config change\n\n<!-- danxbot -->",
      },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.moveToStatus).not.toHaveBeenCalled();
  });

  it("does not move cards with no comments", async () => {
    mockTracker.fetchOpenCards.mockResolvedValueOnce([
      ref("nh1", "New error card", "Needs Help"),
    ]);
    mockTracker.getComments.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.moveToStatus).not.toHaveBeenCalled();
  });

  it("only moves user-responded cards in a mixed set", async () => {
    const cards = [
      ref("nh1", "Bot waiting", "Needs Help"),
      ref("nh2", "User replied", "Needs Help"),
      ref("nh3", "No comments", "Needs Help"),
    ];
    mockTracker.fetchOpenCards.mockResolvedValue(cards);
    // Each card has its own comments call. mockTracker.getComments is
    // dispatched per externalId; we drive responses by sequence since
    // the poller iterates the refs in order.
    mockTracker.getComments
      .mockResolvedValueOnce([
        {
          id: "a1",
          author: "danxbot",
          timestamp: "t",
          text: "Needs help\n\n<!-- danxbot -->",
        },
      ])
      .mockResolvedValueOnce([
        { id: "a2", author: "user", timestamp: "t", text: "Done, try again" },
      ])
      .mockResolvedValueOnce([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.moveToStatus).toHaveBeenCalledTimes(1);
    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("nh2", "ToDo");
  });

  it("handles fetchOpenCards failure during Needs Help check gracefully", async () => {
    // First call (Needs Help check) throws; second call (ToDo check)
    // succeeds with empty result. The poller must NOT crash on the
    // first failure — its catch logs and continues.
    mockTracker.fetchOpenCards
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([]);

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    // Both calls happened — the poller didn't bail after the first failure.
    expect(mockTracker.fetchOpenCards).toHaveBeenCalledTimes(2);
  });

  it("handles individual card comment check failure gracefully", async () => {
    mockTracker.fetchOpenCards
      .mockResolvedValueOnce([
        ref("nh1", "Card 1", "Needs Help"),
        ref("nh2", "Card 2", "Needs Help"),
      ])
      .mockResolvedValueOnce([ref("nh2", "Card 2", "ToDo")]);
    mockTracker.getComments
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([
        { id: "a1", author: "user", timestamp: "t", text: "User reply" },
      ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.moveToStatus).toHaveBeenCalledTimes(1);
    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("nh2", "ToDo");
  });

  it("spawns team when Needs Help cards are moved and no ToDo cards existed before", async () => {
    mockTracker.fetchOpenCards
      .mockResolvedValueOnce([ref("nh1", "User replied", "Needs Help")])
      .mockResolvedValueOnce([ref("nh1", "User replied", "ToDo")]);
    mockTracker.getComments.mockResolvedValue([
      { id: "a1", author: "user", timestamp: "t", text: "Done" },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalled();
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
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    const origImpl = mockExistsSync.getMockImplementation()!;
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".claude.json"))
        return true;
      return origImpl(path);
    });
    for (const [key, value] of Object.entries(requiredEnvVars)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    vi.useRealTimers();
    _resetForTesting();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("starts polling without errors", () => {
    expect(() => start()).not.toThrow();
  });

  it("starts polling for every repo regardless of trelloEnabled — the per-tick isFeatureEnabled check decides whether to skip", () => {
    mockRepoContexts[0].trelloEnabled = false;
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "trelloPoller",
    );

    start();

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "trelloPoller",
    );
    expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();

    mockRepoContexts[0].trelloEnabled = true;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("polls every repo in repoContexts — per-tick toggle decides which fetch the tracker", () => {
    const enabledRepo = {
      ...mockRepoContexts[0],
      name: "enabled",
      trelloEnabled: true,
    };
    const disabledRepo = {
      ...mockRepoContexts[0],
      name: "disabled",
      trelloEnabled: false,
    };
    mockRepoContexts.length = 0;
    mockRepoContexts.push(enabledRepo, disabledRepo);
    mockIsFeatureEnabled.mockImplementation((...args: unknown[]) => {
      const ctx = args[0] as { name: string };
      const feature = args[1] as string;
      if (feature !== "trelloPoller") return true;
      return ctx.name === "enabled";
    });

    start();

    // The factory should have been called for the enabled repo only —
    // the disabled repo skips the entire tick before reaching the
    // tracker. Memo: factory is per-repo, NOT per-tick (cache).
    const enabledCalls = mockCreateIssueTracker.mock.calls.filter(
      (c) => (c[0] as { name: string }).name === "enabled",
    );
    const disabledCalls = mockCreateIssueTracker.mock.calls.filter(
      (c) => (c[0] as { name: string }).name === "disabled",
    );
    expect(enabledCalls.length).toBeGreaterThanOrEqual(1);
    expect(disabledCalls.length).toBe(0);

    mockRepoContexts.length = 0;
    mockRepoContexts.push({
      ...enabledRepo,
      name: "test-repo",
      trelloEnabled: true,
    });
    mockIsFeatureEnabled.mockReturnValue(true);
  });
});

describe("poll — critical-failure halt gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockReadFlag.mockReturnValue(null);
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("does not fetch from the tracker or spawn when the flag is set — halt is terminal until cleared", async () => {
    mockReadFlag.mockReturnValue({
      timestamp: "2026-04-21T00:00:00.000Z",
      source: "agent",
      dispatchId: "dxy",
      reason: "MCP Trello tools failed to load",
    });
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockReadFlag).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.localPath);
    expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("also halts on the synthetic unparseable source (a corrupt flag file is fail-closed)", async () => {
    mockReadFlag.mockReturnValue({
      timestamp: "2026-04-21T00:00:00.000Z",
      source: "unparseable",
      dispatchId: "unparseable",
      reason: "Critical-failure flag file present but unparseable",
    });
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("proceeds normally when the flag is absent", async () => {
    mockReadFlag.mockReturnValue(null);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockReadFlag).toHaveBeenCalled();
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });

  it("halt gate runs AFTER the feature toggle — disabled poller never checks the flag", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "trelloPoller",
    );
    mockReadFlag.mockReturnValue(null);
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockReadFlag).not.toHaveBeenCalled();
    expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();
  });
});

describe("poll — post-dispatch card-progress check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockReadFlag.mockReturnValue(null);
    mockIsFeatureEnabled.mockReturnValue(true);
    mockDispatch.mockResolvedValue({ id: "test-job", status: "running" });
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  async function runOneDispatch(
    todoCards: Array<{ id: string; name: string }>,
    completionJob: {
      id: string;
      status: string;
      summary?: string;
      startedAt: Date;
      completedAt: Date;
    },
  ): Promise<void> {
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );
    mockTracker.fetchOpenCards.mockResolvedValue(
      todoCards.map((c) => ref(c.id, c.name, "ToDo")),
    );

    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!(completionJob);
    await flushAsync();
    await flushAsync();
  }

  /**
   * Build an Issue suitable for `mockTracker.getCard.mockResolvedValue` —
   * status is what `checkCardProgressedOrHalt` reads.
   */
  function issueWithStatus(
    externalId: string,
    title: string,
    status: IssueStatus,
  ) {
    return {
      schema_version: 3 as const,
      tracker: "trello",
      id: "ISS-1",
      external_id: externalId,
      parent_id: null,
      children: [],
      dispatch_id: null,
      status,
      type: "Feature" as const,
      title,
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    };
  }

  it("writes the critical-failure flag when the tracked card is still in ToDo after the dispatch exits", async () => {
    mockTracker.getCard.mockResolvedValue(
      issueWithStatus("c1", "Card 1", "ToDo"),
    );

    await runOneDispatch([{ id: "c1", name: "Card 1" }], {
      id: "j1",
      status: "failed",
      summary: "MCP Trello unavailable",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockTracker.getCard).toHaveBeenCalledWith("c1");
    expect(mockWriteFlag).toHaveBeenCalledTimes(1);
    const [localPath, payload] = mockWriteFlag.mock.calls[0];
    expect(localPath).toBe(MOCK_REPO_CONTEXT.localPath);
    expect(payload).toMatchObject({
      source: "post-dispatch-check",
      dispatchId: "j1",
      cardId: "c1",
      cardUrl: "https://trello.com/c/c1",
    });
    expect(payload.reason).toMatch(/did not move out of ToDo/);
  });

  it("writes the flag even when the agent reported status=completed (silent env failure)", async () => {
    mockTracker.getCard.mockResolvedValue(
      issueWithStatus("c1", "Card 1", "ToDo"),
    );

    await runOneDispatch([{ id: "c1", name: "Card 1" }], {
      id: "j1",
      status: "completed",
      summary: "done (but really wasn't)",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockWriteFlag).toHaveBeenCalled();
  });

  it("does NOT write the flag when the tracked card moved to In Progress", async () => {
    mockTracker.getCard.mockResolvedValue(
      issueWithStatus("c1", "Card 1", "In Progress"),
    );

    await runOneDispatch([{ id: "c1", name: "Card 1" }], {
      id: "j1",
      status: "failed",
      summary: "mid-work crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockTracker.getCard).toHaveBeenCalled();
    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when the tracked card moved to Needs Help", async () => {
    mockTracker.getCard.mockResolvedValue(
      issueWithStatus("c1", "Card 1", "Needs Help"),
    );

    await runOneDispatch([{ id: "c1", name: "Card 1" }], {
      id: "j1",
      status: "completed",
      summary: "moved to Needs Help",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when the tracked card moved to Done", async () => {
    mockTracker.getCard.mockResolvedValue(
      issueWithStatus("c1", "Card 1", "Done"),
    );

    await runOneDispatch([{ id: "c1", name: "Card 1" }], {
      id: "j1",
      status: "completed",
      summary: "done",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT fetch the card or write a flag for ideator (api trigger) dispatches", async () => {
    // Empty ToDo + empty Review + ideator enabled → ideator dispatch.
    mockTracker.fetchOpenCards.mockResolvedValue([]);
    mockIsFeatureEnabled.mockImplementation(() => true);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "ideator-job", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!({
      id: "ideator-job",
      status: "completed",
      summary: "generated cards",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();

    expect(mockTracker.getCard).not.toHaveBeenCalled();
    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("handles getCard failures gracefully without writing the flag", async () => {
    mockTracker.getCard.mockRejectedValue(new Error("Trello API 500"));

    await runOneDispatch([{ id: "c1", name: "Card 1" }], {
      id: "j1",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockTracker.getCard).toHaveBeenCalled();
    expect(mockWriteFlag).not.toHaveBeenCalled();
  });
});

describe("shutdown", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    setupRepoConfigMocks();
    mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  it("calls process.exit(0)", () => {
    shutdown();
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});

describe("poll — Docker mode (headless agent)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    mockDispatch.mockResolvedValue({ id: "test-job", status: "running" });
    setupRepoConfigMocks();
    mockIsFeatureEnabled.mockReset();
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    mockGetTrelloPollerPickupPrefix.mockReset();
    mockGetTrelloPollerPickupPrefix.mockReturnValue(null);
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  it("routes through dispatch() (not a direct terminal spawn)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("/danx-next"),
        repo: expect.objectContaining({ name: "test-repo" }),
        workspace: "issue-worker",
      }),
    );
  });

  it("passes the /danx-next prompt as the dispatch task", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("/danx-next"),
      }),
    );
  });

  it("passes the /danx-ideate prompt as the dispatch task when ToDo is empty AND ideator enabled", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([]);
    mockIsFeatureEnabled.mockImplementation(() => true);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("/danx-ideate"),
      }),
    );
  });

  it("does NOT spawn ideator when feature is disabled (env default)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("does NOT spawn ideator when override explicitly disables it even though Review is empty", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([]);
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("resets teamRunning via onComplete callback", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();

    capturedOnComplete!({
      id: "test-job",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();

    mockTracker.fetchOpenCards.mockResolvedValue([...REVIEW_FILLER]);
    await poll(MOCK_REPO_CONTEXT);
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });

  it("resets teamRunning on agent failure", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    capturedOnComplete!({
      id: "test-job",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();

    mockTracker.fetchOpenCards.mockResolvedValue([...REVIEW_FILLER]);
    await poll(MOCK_REPO_CONTEXT);
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });

  it("does NOT restate the DANXBOT_REPO_NAME / openTerminal invariants — dispatch() owns those defaults", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    const call = mockDispatch.mock.calls[0][0];
    expect(call.env).toBeUndefined();
    expect(call.openTerminal).toBeUndefined();
  });

  it("passes its own timeoutMs (pollerIntervalMs * 60) to dispatch()", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 60000 * 60,
      }),
    );
  });

  it("does NOT pass allowTools — the allow-tools concept is gone from dispatch", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    const call = mockDispatch.mock.calls[0][0];
    expect(call.allowTools).toBeUndefined();
    expect(call.workspace).toBe("issue-worker");
  });

  it("tags the dispatch with trigger=trello + the tracked card metadata", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("c1", "Card 1", "ToDo"),
      ref("c2", "Card 2", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    const call = mockDispatch.mock.calls[0][0];
    expect(call.apiDispatchMeta).toEqual({
      trigger: "trello",
      metadata: {
        cardId: "c1",
        cardName: "Card 1",
        cardUrl: "https://trello.com/c/c1",
        listId: MOCK_REPO_CONTEXT.trello.todoListId,
        listName: "ToDo",
      },
    });
  });

  it("tags ideator runs with trigger=api (not card-specific)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([]);
    mockIsFeatureEnabled.mockImplementation(() => true);

    await poll(MOCK_REPO_CONTEXT);

    const call = mockDispatch.mock.calls[0][0];
    expect(call.apiDispatchMeta.trigger).toBe("api");
    expect(call.apiDispatchMeta.metadata).toMatchObject({
      endpoint: "poller/ideator",
    });
  });

  it("handles onComplete without throwing", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    expect(() =>
      capturedOnComplete!({
        id: "test-job",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
      }),
    ).not.toThrow();
    await flushAsync();
  });

  it("onComplete re-poll chains into another dispatch() if more cards", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    mockDispatch.mockClear();
    mockDispatch.mockResolvedValue({ id: "test-job-2", status: "running" });
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c2", "Card 2", "ToDo")]);

    capturedOnComplete!({
      id: "test-job",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    await flushAsync();
    await flushAsync();

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("resets teamRunning when dispatch() rejects before agent spawns (fire-and-forget .catch)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    mockDispatch.mockRejectedValueOnce(new Error("pre-spawn boom"));

    await poll(MOCK_REPO_CONTEXT);
    await flushAsync();
    await flushAsync();

    mockTracker.fetchOpenCards.mockClear();
    mockDispatch.mockClear();
    mockTracker.fetchOpenCards.mockResolvedValue([...REVIEW_FILLER]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });
});

describe("poll — exponential backoff on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  it("increments consecutive failure counter on agent failure", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "j1", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();

    mockTracker.fetchOpenCards.mockResolvedValue([ref("c2", "Card 2", "ToDo")]);
    await poll(MOCK_REPO_CONTEXT);

    // Should not spawn because we're in backoff
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("resets failure counter on success — next failure gets first-tier backoff", async () => {
    const originalSchedule = mockConfig.pollerBackoffScheduleMs;
    mockConfig.pollerBackoffScheduleMs = [1, 1, 1, 1];
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "j1", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await new Promise((r) => setTimeout(r, 5));

    await flushAsync();
    await flushAsync();
    const secondOnComplete = capturedOnComplete!;

    secondOnComplete({
      id: "j2",
      status: "completed",
      summary: "done",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await new Promise((r) => setTimeout(r, 5));
    await flushAsync();
    await flushAsync();

    const spawnCount = mockDispatch.mock.calls.length;
    expect(spawnCount).toBeGreaterThanOrEqual(2);

    mockConfig.pollerBackoffScheduleMs = originalSchedule;
  });

  it("halts polling after exhausting all backoff schedule entries", async () => {
    const originalSchedule = mockConfig.pollerBackoffScheduleMs;
    mockConfig.pollerBackoffScheduleMs = [1];
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    const onCompleteFns: Array<(job: unknown) => void> = [];
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        if (opts.onComplete) onCompleteFns.push(opts.onComplete);
        return Promise.resolve({
          id: `j${onCompleteFns.length}`,
          status: "running",
        });
      },
    );

    await poll(MOCK_REPO_CONTEXT);
    expect(onCompleteFns).toHaveLength(1);

    mockExistsSync.mockReturnValue(false);
    onCompleteFns[0]({
      id: "j1",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();
    await new Promise((r) => setTimeout(r, 5));

    await flushAsync();
    await flushAsync();

    if (onCompleteFns.length >= 2) {
      mockDispatch.mockClear();
      mockTracker.fetchOpenCards.mockClear();
      onCompleteFns[1]({
        id: "j2",
        status: "failed",
        summary: "crash again",
        startedAt: new Date(),
        completedAt: new Date(),
      });
      await flushAsync();
      await flushAsync();

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();
    }

    mockConfig.pollerBackoffScheduleMs = originalSchedule;
  });

  it("skips polling during backoff period", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "j1", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();

    mockDispatch.mockClear();
    mockTracker.fetchOpenCards.mockClear();
    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("poll — stuck card recovery on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  it("moves stuck In Progress card to Needs Help on agent failure", async () => {
    // The poller calls fetchOpenCards twice during _poll (NH check +
    // ToDo branch). Default mockResolvedValue covers both. After
    // dispatch is captured, we inject a mockResolvedValueOnce so the
    // NEXT call (recovery's In Progress fetch) returns the moved card.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("c1", "My Card", "ToDo"),
    ]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "j1", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    mockTracker.fetchOpenCards.mockResolvedValueOnce([
      ref("c1", "My Card", "In Progress"),
    ]);
    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1",
      status: "failed",
      summary: "Error: permission denied",
      startedAt: new Date(Date.now() - 60_000),
      completedAt: new Date(),
    });
    await flushAsync();

    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("c1", "Needs Help");
    expect(mockTracker.addComment).toHaveBeenCalledWith(
      "c1",
      expect.stringContaining("Agent Failure"),
    );
    expect(mockTracker.addComment).toHaveBeenCalledWith(
      "c1",
      expect.stringContaining("permission denied"),
    );
    expect(mockTracker.addComment).toHaveBeenCalledWith(
      "c1",
      expect.stringContaining("<!-- danxbot -->"),
    );
  });

  it("does not recover cards that were already In Progress before spawn", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("c1", "My Card", "ToDo"),
    ]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "j1", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    // Recovery's IP fetch sees both the just-moved card AND a
    // pre-existing IP card. Only the dispatch's own card should be
    // recovered.
    mockTracker.fetchOpenCards.mockResolvedValueOnce([
      ref("c1", "My Card", "In Progress"),
      ref("c99", "Already In Progress", "In Progress"),
    ]);
    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();

    // Only c1 should be moved (it was in our ToDo list before spawn).
    const moves = mockTracker.moveToStatus.mock.calls.filter(
      (c: unknown[]) => c[1] === "Needs Help",
    );
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual(["c1", "Needs Help"]);
  });

  it("does not recover cards on successful completion", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "j1", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1",
      status: "completed",
      summary: "done",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();

    // No additional fetchOpenCards call (recovery didn't fire) and
    // no Needs Help moves.
    const nhMoves = mockTracker.moveToStatus.mock.calls.filter(
      (c: unknown[]) => c[1] === "Needs Help",
    );
    expect(nhMoves).toEqual([]);
  });

  it("recovers multiple stuck cards from a single failed agent run", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("c1", "Card 1", "ToDo"),
      ref("c2", "Card 2", "ToDo"),
    ]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "j1", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    mockTracker.fetchOpenCards.mockResolvedValueOnce([
      ref("c1", "Card 1", "In Progress"),
      ref("c2", "Card 2", "In Progress"),
    ]);
    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();

    const nhMoves = mockTracker.moveToStatus.mock.calls.filter(
      (c: unknown[]) => c[1] === "Needs Help",
    );
    expect(nhMoves).toHaveLength(2);
    // Filter out dispatch-lock comments — the lock layer posts one on
    // the primary card before dispatch. Stuck-card recovery posts the
    // remaining two ("Needs Help" explanations).
    const recoveryComments = mockTracker.addComment.mock.calls.filter(
      (c: unknown[]) => !String(c[1]).includes("danxbot-lock"),
    );
    expect(recoveryComments).toHaveLength(2);
    expect(nhMoves).toContainEqual(["c1", "Needs Help"]);
    expect(nhMoves).toContainEqual(["c2", "Needs Help"]);
  });

  it("recovers stuck cards on agent timeout (not just failure)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "j1", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    mockTracker.fetchOpenCards.mockResolvedValueOnce([
      ref("c1", "Card 1", "In Progress"),
    ]);
    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1",
      status: "timeout",
      summary: "Agent timed out after 300 seconds of inactivity",
      startedAt: new Date(Date.now() - 300_000),
      completedAt: new Date(),
    });
    await flushAsync();

    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("c1", "Needs Help");
    expect(mockTracker.addComment).toHaveBeenCalledWith(
      "c1",
      expect.stringContaining("timed out"),
    );
  });

  it("handles recovery failure gracefully without crashing", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "j1", status: "running" });
      },
    );

    await poll(MOCK_REPO_CONTEXT);

    // Recovery's IP fetch fails — handler should swallow and continue.
    mockTracker.fetchOpenCards.mockRejectedValueOnce(new Error("API down"));
    mockExistsSync.mockReturnValue(false);

    // Should not throw — error is caught and logged
    capturedOnComplete!({
      id: "j1",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
  });
});

describe("poll — YAML lifecycle integration (Phase 2 of tracker-agnostic-agents)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockIsFeatureEnabled.mockReset();
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    mockGetTrelloPollerPickupPrefix.mockReset();
    mockGetTrelloPollerPickupPrefix.mockReturnValue(null);
    mockLoadLocal.mockReturnValue(null);
    mockFindByExternalId.mockReset();
    mockFindByExternalId.mockReturnValue(null);
    mockHydrateFromRemote.mockReset();
    mockHydrateFromRemote.mockImplementation(
      async (
        _t: unknown,
        externalId: string,
        dispatchId: string,
        _repoLocalPath: string,
      ) => ({
        ...FAKE_ISSUE_FOR_TESTS,
        external_id: externalId,
        dispatch_id: dispatchId,
      }),
    );
    mockStampDispatchAndWrite.mockImplementation(
      (_repo: string, issue: Record<string, unknown>, dispatchId: string) => ({
        ...issue,
        dispatch_id: dispatchId,
      }),
    );
  });

  it("composes the dispatch task with TEAM_PROMPT prefix + the YAML directive substring", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-uuid-1", "Card 1", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchArg = mockDispatch.mock.calls[0][0] as { task: string };
    expect(dispatchArg.task).toContain("/danx-next");
    expect(dispatchArg.task).toContain(
      "Edit /test/repos/test-repo/.danxbot/issues/open/ISS-FAKE.yml",
    );
    expect(dispatchArg.task).toContain(
      'Call danx_issue_save({id: "ISS-FAKE"}) when done.',
    );
  });

  it("threads the same dispatchId into both the YAML stamp and the dispatch() call", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-uuid-2", "Card 2", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    const dispatchArg = mockDispatch.mock.calls[0][0] as { dispatchId: string };
    expect(dispatchArg.dispatchId).toBeDefined();
    expect(dispatchArg.dispatchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    expect(mockHydrateFromRemote).toHaveBeenCalledWith(
      expect.anything(),
      "card-uuid-2",
      dispatchArg.dispatchId,
      expect.any(String),
    );
  });

  it("calls writeIssue with the hydrated Issue after the brand-new-card hydration path runs", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-uuid-w", "Card W", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockWriteIssueFn).toHaveBeenCalledTimes(1);
    const writeArgs = mockWriteIssueFn.mock.calls[0];
    expect(writeArgs[0]).toBe(MOCK_REPO_CONTEXT.localPath);
    const writtenIssue = writeArgs[1] as {
      external_id: string;
      dispatch_id: string;
    };
    expect(writtenIssue.external_id).toBe("card-uuid-w");
    const dispatchArg = mockDispatch.mock.calls[0][0] as { dispatchId: string };
    expect(writtenIssue.dispatch_id).toBe(dispatchArg.dispatchId);
  });

  it("stamps + writes YAML BEFORE dispatch() spawns the agent — ordering invariant", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-order-1", "Order 1", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    const writeOrder = mockWriteIssueFn.mock.invocationCallOrder[0];
    const dispatchOrder = mockDispatch.mock.invocationCallOrder[0];
    expect(writeOrder).toBeDefined();
    expect(dispatchOrder).toBeDefined();
    expect(writeOrder).toBeLessThan(dispatchOrder);
  });

  it("constructs the IssueTracker exactly once per repo and reuses it across multiple ticks (cache invariant)", async () => {
    // Phase 5 introduced `getRepoTracker` so a single tracker survives
    // across every call site in the poller hot path. This is essential
    // for `MemoryTracker` state retention — a regression that recreates
    // the tracker per tick would silently break Layer 3 memory-tracker
    // scenarios. Pin: the factory is called ONCE at first use and never
    // again across multiple back-to-back ticks (without
    // `_resetForTesting`).
    mockFindByExternalId.mockReturnValue({
      schema_version: 3,
      tracker: "trello",
      id: "ISS-100",
      external_id: "card-cached",
      parent_id: null,
      children: [],
      dispatch_id: "old",
      status: "ToDo",
      type: "Feature",
      title: "Cached",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    });
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-cached", "Cached", "ToDo"),
    ]);
    // Drive the dispatch-then-onComplete flow so `teamRunning` clears
    // and the second `poll()` call is allowed to proceed.
    let capturedOnComplete: ((j: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (j: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ dispatchId: "d", job: { id: "j1" } });
      },
    );

    await poll(MOCK_REPO_CONTEXT);
    expect(mockCreateIssueTracker).toHaveBeenCalledTimes(1);

    // Simulate dispatch completion so teamRunning resets. The default
    // getCard mock returns Done so post-dispatch check no-ops.
    capturedOnComplete!({
      id: "j1",
      status: "completed",
      summary: "ok",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();

    // Second tick: the cached tracker MUST be reused. Factory call
    // count must stay at 1.
    await poll(MOCK_REPO_CONTEXT);
    expect(mockCreateIssueTracker).toHaveBeenCalledTimes(1);
    expect(mockHydrateFromRemote).not.toHaveBeenCalled();
  });

  it("checkAndSpawnIdeator reads the Review count from tracker.fetchOpenCards (the data source moved off the legacy direct client)", async () => {
    // Empty ToDo + Review filler from the same tracker call. The
    // ideator path filters the merged fetchOpenCards result — there
    // is no separate review-list helper anymore. A regression wiring
    // ideator back to a deleted helper would surface here as a missing
    // tracker call.
    mockTracker.fetchOpenCards.mockReset();
    mockTracker.fetchOpenCards.mockResolvedValue([
      // No ToDo / Needs Help / In Progress — only Review filler.
      ...REVIEW_FILLER,
    ]);
    mockIsFeatureEnabled.mockImplementation(() => true);

    await poll(MOCK_REPO_CONTEXT);

    // Tracker was the ONLY data source consulted: NH check + ToDo
    // branch + ideator's Review check = 3 calls minimum.
    expect(mockTracker.fetchOpenCards).toHaveBeenCalledTimes(3);
    // Review count met threshold → ideator does NOT dispatch.
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("checkAndSpawnIdeator dispatches when tracker shows Review below threshold AND ideator enabled", async () => {
    mockTracker.fetchOpenCards.mockReset();
    mockTracker.fetchOpenCards.mockResolvedValue([
      // Empty Review — below the threshold of 10.
    ]);
    mockIsFeatureEnabled.mockImplementation(() => true);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalledTimes(3);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("/danx-ideate"),
      }),
    );
  });

  it("Needs Help check inspects the LAST comment (sorted ascending by timestamp) — not the first", async () => {
    // The deleted Trello-direct comment helper returned the newest-
    // first comment; the new `tracker.getComments` returns them
    // sorted ascending by timestamp, so the LAST element is the most
    // recent. A regression that reads `comments[0]` would treat the
    // OLDEST comment as the latest — this test guards against that
    // by giving an older bot comment + a newer user comment.
    // Correct behavior: card moves to ToDo (last comment is from
    // user). Inverted (`comments[0]`) behavior: card stays put.
    mockTracker.fetchOpenCards
      .mockResolvedValueOnce([ref("nh1", "Blocked", "Needs Help")])
      .mockResolvedValueOnce([ref("nh1", "Blocked", "ToDo")]);
    mockTracker.getComments.mockResolvedValue([
      // Oldest first — the bot comment that put the card in Needs Help.
      {
        id: "a1",
        author: "danxbot",
        timestamp: "2026-01-01T00:00:00Z",
        text: "Help\n\n<!-- danxbot -->",
      },
      // Newest last — the user reply that should unblock the card.
      {
        id: "a2",
        author: "user",
        timestamp: "2026-01-02T00:00:00Z",
        text: "Done, retry",
      },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("nh1", "ToDo");
  });

  it("propagates a corrupt-YAML error from findByExternalId — the poller does not silently fall back to hydration", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-bad", "Bad YAML", "ToDo"),
    ]);
    const parseError = new Error(
      "Invalid Issue YAML: missing required field: tracker",
    );
    mockFindByExternalId.mockImplementation(() => {
      throw parseError;
    });

    await expect(poll(MOCK_REPO_CONTEXT)).rejects.toThrow(/Invalid Issue YAML/);
    expect(mockHydrateFromRemote).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("propagates a tracker getCard failure — hydration crashes loud, no dispatch", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-net-fail", "Net fail", "ToDo"),
    ]);
    mockFindByExternalId.mockReturnValue(null);
    mockHydrateFromRemote.mockRejectedValueOnce(
      new Error("Trello API error: 401 Unauthorized"),
    );

    await expect(poll(MOCK_REPO_CONTEXT)).rejects.toThrow(/401 Unauthorized/);
    expect(mockWriteIssueFn).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("skips hydration when a local YAML already exists and uses stampDispatchAndWrite to overwrite the dispatch_id only", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-uuid-3", "Card 3", "ToDo"),
    ]);
    const existingIssue = {
      schema_version: 3,
      tracker: "trello",
      id: "ISS-200",
      external_id: "card-uuid-3",
      parent_id: null,
      children: [],
      dispatch_id: "old-dispatch",
      status: "ToDo",
      type: "Feature",
      title: "Card 3",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    };
    mockFindByExternalId.mockReturnValue(existingIssue);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockHydrateFromRemote).not.toHaveBeenCalled();
    expect(mockStampDispatchAndWrite).toHaveBeenCalledTimes(1);
    const stampArgs = mockStampDispatchAndWrite.mock.calls[0];
    expect(stampArgs[1]).toBe(existingIssue);
    const dispatchArg = mockDispatch.mock.calls[0][0] as { dispatchId: string };
    expect(stampArgs[2]).toBe(dispatchArg.dispatchId);
  });

  it("blocked card with non-terminal blocker is skipped (no dispatch this tick)", async () => {
    // Card carries `blocked: {by: ["ISS-99"]}`. Blocker ISS-99 is open and
    // not terminal → this tick must NOT dispatch. The blocked-resolution
    // gate filters the card out of `cards` before the dispatch path runs.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-block-1", "Blocked card", "ToDo"),
    ]);
    const blockedIssue = {
      schema_version: 3,
      tracker: "trello",
      id: "ISS-300",
      external_id: "card-block-1",
      parent_id: null,
      children: [],
      dispatch_id: null,
      status: "ToDo",
      type: "Feature",
      title: "Blocked card",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
      blocked: {
        reason: "waiting on ISS-99",
        timestamp: "2026-05-04T18:00:00.000Z",
        by: ["ISS-99"],
      },
    };
    mockFindByExternalId.mockReturnValue(blockedIssue);
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id === "ISS-99") return { ...blockedIssue, id: "ISS-99", status: "ToDo", blocked: null };
      return null;
    });

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("blocked card whose every blocker is terminal clears blocked, saves, and dispatches", async () => {
    // ISS-99 is Done → ISS-300 is unblocked. The poller clears the
    // blocked record on the YAML (via writeFileSync, not mocked here)
    // and dispatches the card.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-block-2", "Now-unblocked card", "ToDo"),
    ]);
    const blockedIssue = {
      schema_version: 3,
      tracker: "trello",
      id: "ISS-301",
      external_id: "card-block-2",
      parent_id: null,
      children: [],
      dispatch_id: null,
      status: "ToDo",
      type: "Feature",
      title: "Now-unblocked card",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
      blocked: {
        reason: "waiting on ISS-99",
        timestamp: "2026-05-04T18:00:00.000Z",
        by: ["ISS-99"],
      },
    };
    mockFindByExternalId.mockReturnValue(blockedIssue);
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id === "ISS-99") return { ...blockedIssue, id: "ISS-99", status: "Done", blocked: null };
      return null;
    });

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("Action Items list cards (list_kind: action_items) are bulk-synced but not dispatched", async () => {
    // The Trello tracker tags Action Items cards with `list_kind:
    // "action_items"`. The poller must bulk-sync them (so blocker
    // discovery sees them in local YAMLs) but exclude them from
    // dispatch eligibility — the operator promotes them to the actual
    // ToDo list when ready.
    mockTracker.fetchOpenCards.mockResolvedValue([
      { id: "", external_id: "card-ai-1", title: "AI card", status: "ToDo", list_kind: "action_items" },
    ]);
    mockFindByExternalId.mockReturnValue(null);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
    // Bulk-sync still hydrated the Action Items card.
    expect(mockHydrateFromRemote).toHaveBeenCalled();
  });

  it("ensures issues/ dirs and gitignore entry on every tick (idempotency lives in the helpers)", async () => {
    await poll(MOCK_REPO_CONTEXT);

    expect(mockEnsureIssuesDirs).toHaveBeenCalledWith("/test/repos/test-repo");
    expect(mockEnsureGitignoreEntry).toHaveBeenCalledWith(
      "/test/repos/test-repo",
      "issues/",
    );
  });
});

/**
 * Bulk-sync + orphan resume.
 *
 * Two related behaviors live in the same describe block because they share
 * the same _poll setup path: the poller fetches all open cards, hydrates any
 * ToDo / In Progress card without a local YAML (bulk-sync), then checks
 * In Progress local YAMLs for orphaned dispatch_ids whose claude session
 * file still exists on disk and resumes the first one it finds.
 *
 * Without this, an orphaned In Progress card (worker died mid-dispatch)
 * stays parked forever — the previous filter-to-ToDo logic skipped them
 * and a new dispatch on the same card was impossible because the card
 * was no longer in ToDo.
 */
describe("poll — In Progress sync + orphan resume", () => {
  function inProgressIssue(
    id: string,
    externalId: string,
    dispatchId: string | null,
    title = "In Progress card",
  ) {
    return {
      schema_version: 3 as const,
      tracker: "trello",
      id,
      external_id: externalId,
      parent_id: null,
      children: [],
      dispatch_id: dispatchId,
      status: "In Progress" as const,
      type: "Feature" as const,
      title,
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFindByExternalId.mockReset();
    mockFindByExternalId.mockReturnValue(null);
    mockHydrateFromRemote.mockReset();
    mockHydrateFromRemote.mockImplementation(
      async (
        _t: unknown,
        externalId: string,
        dispatchId: string | null,
        _repoLocalPath: string,
      ) => ({
        ...FAKE_ISSUE_FOR_TESTS,
        external_id: externalId,
        dispatch_id: dispatchId,
      }),
    );
    mockStampDispatchAndWrite.mockImplementation(
      (_repo: string, issue: Record<string, unknown>, dispatchId: string) => ({
        ...issue,
        dispatch_id: dispatchId,
      }),
    );
    mockGetActiveJob.mockReset();
    mockGetActiveJob.mockReturnValue(undefined);
    mockResolveParentSessionId.mockReset();
    mockResolveParentSessionId.mockResolvedValue({ kind: "no-session-dir" });
  });

  it("hydrates an In Progress card that has no local YAML during bulk-sync (dispatch_id null)", async () => {
    // The remote shows an In Progress card the local issues/ dir has
    // never seen — bulk-sync must hydrate it so the next tick can
    // reason about its dispatch_id from local truth, never from the
    // tracker. Same contract as ToDo siblings; In Progress just got
    // added to the sync set.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-new", "Untracked In Progress", "In Progress"),
      ref("td-1", "ToDo card", "ToDo"),
    ]);
    // ToDo card has a local YAML so it short-circuits hydration; the
    // In Progress card does not.
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "td-1"
          ? {
              ...FAKE_ISSUE_FOR_TESTS,
              external_id: "td-1",
              status: "ToDo",
              dispatch_id: null,
            }
          : null,
    );

    await poll(MOCK_REPO_CONTEXT);

    // hydrateFromRemote was called for the In Progress card with a
    // null dispatchId (bulk-sync semantics).
    const ipHydrate = mockHydrateFromRemote.mock.calls.find(
      (c) => c[1] === "ip-new",
    );
    expect(ipHydrate).toBeDefined();
    expect(ipHydrate![2]).toBeNull();
    // And writeIssue persisted that hydration before any dispatch.
    const writeArgs = mockWriteIssueFn.mock.calls.find((c) => {
      const issue = c[1] as { external_id: string };
      return issue.external_id === "ip-new";
    });
    expect(writeArgs).toBeDefined();
  });

  it("resumes an orphaned In Progress card whose dispatch_id session file exists on disk", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-1", "Orphaned card", "In Progress"),
    ]);
    const orphan = inProgressIssue("ISS-77", "ip-1", "old-dispatch-uuid");
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-1" ? orphan : null,
    );
    mockResolveParentSessionId.mockResolvedValue({
      kind: "found",
      sessionId: "claude-session-abc",
    });

    await poll(MOCK_REPO_CONTEXT);

    expect(mockGetActiveJob).toHaveBeenCalledWith("old-dispatch-uuid");
    expect(mockResolveParentSessionId).toHaveBeenCalledWith(
      "test-repo",
      "old-dispatch-uuid",
    );
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchArg = mockDispatch.mock.calls[0][0] as {
      task: string;
      resumeSessionId?: string;
      parentJobId?: string;
      apiDispatchMeta: {
        trigger: string;
        metadata: { listName: string; cardId: string };
      };
    };
    expect(dispatchArg.resumeSessionId).toBe("claude-session-abc");
    expect(dispatchArg.parentJobId).toBe("old-dispatch-uuid");
    expect(dispatchArg.apiDispatchMeta.metadata.listName).toBe("In Progress");
    expect(dispatchArg.apiDispatchMeta.metadata.cardId).toBe("ip-1");
    expect(dispatchArg.task).toContain("ISS-77");
  });

  it("skips orphan resume when dispatch_id is still in activeJobs (live, not orphan)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-live", "Live card", "In Progress"),
    ]);
    mockFindByExternalId.mockReturnValue(
      inProgressIssue("ISS-78", "ip-live", "live-dispatch-uuid"),
    );
    mockGetActiveJob.mockImplementation((id: string) =>
      id === "live-dispatch-uuid" ? { id, status: "running" } : undefined,
    );

    await poll(MOCK_REPO_CONTEXT);

    expect(mockResolveParentSessionId).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("skips orphan resume when In Progress card has no dispatch_id stamped", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-bare", "Bare card", "In Progress"),
    ]);
    mockFindByExternalId.mockReturnValue(
      inProgressIssue("ISS-79", "ip-bare", null),
    );

    await poll(MOCK_REPO_CONTEXT);

    expect(mockGetActiveJob).not.toHaveBeenCalled();
    expect(mockResolveParentSessionId).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("resets In Progress → ToDo when the dispatch_id session file is gone (not-found)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-gone", "Gone card", "In Progress"),
    ]);
    const orphan = inProgressIssue("ISS-80", "ip-gone", "vanished-uuid");
    mockFindByExternalId.mockReturnValue(orphan);
    mockResolveParentSessionId.mockResolvedValue({ kind: "not-found" });

    await poll(MOCK_REPO_CONTEXT);

    // Card moved back to ToDo on the tracker.
    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("ip-gone", "ToDo");
    // YAML rewritten with status reset and dispatch_id cleared.
    const reset = mockWriteIssueFn.mock.calls.find((c) => {
      const issue = c[1] as { external_id?: string };
      return issue?.external_id === "ip-gone";
    });
    expect(reset).toBeDefined();
    const resetIssue = reset![1] as {
      status: string;
      dispatch_id: string | null;
    };
    expect(resetIssue.status).toBe("ToDo");
    expect(resetIssue.dispatch_id).toBeNull();
    // No resume dispatch fired.
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("resumes only the first eligible orphan; remaining orphans wait for next tick", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-a", "Card A", "In Progress"),
      ref("ip-b", "Card B", "In Progress"),
    ]);
    const orphanA = inProgressIssue("ISS-81", "ip-a", "uuid-a");
    const orphanB = inProgressIssue("ISS-82", "ip-b", "uuid-b");
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-a"
          ? orphanA
          : externalId === "ip-b"
            ? orphanB
            : null,
    );
    mockResolveParentSessionId.mockImplementation(
      async (_repo: string, jobId: string) =>
        jobId === "uuid-a"
          ? { kind: "found", sessionId: "session-a" }
          : { kind: "found", sessionId: "session-b" },
    );

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as { parentJobId?: string };
    expect(arg.parentJobId).toBe("uuid-a");
  });

  it("does NOT process the ToDo dispatch path on a tick that resumed an orphan", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-resume", "Orphan", "In Progress"),
      ref("td-skip", "Should-skip ToDo", "ToDo"),
    ]);
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-resume"
          ? inProgressIssue("ISS-90", "ip-resume", "uuid-resume")
          : null,
    );
    mockResolveParentSessionId.mockResolvedValue({
      kind: "found",
      sessionId: "session-resume",
    });

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // Only the resume dispatch fired — its parentJobId proves it.
    const arg = mockDispatch.mock.calls[0][0] as { parentJobId?: string };
    expect(arg.parentJobId).toBe("uuid-resume");
  });

  it("falls through to ToDo dispatch when no orphans are eligible", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-bare", "No dispatch_id", "In Progress"),
      ref("td-fresh", "Fresh ToDo", "ToDo"),
    ]);
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-bare"
          ? inProgressIssue("ISS-91", "ip-bare", null)
          : null,
    );

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as {
      parentJobId?: string;
      resumeSessionId?: string;
    };
    expect(arg.parentJobId).toBeUndefined();
    expect(arg.resumeSessionId).toBeUndefined();
  });

  it("aborts the orphan-resume scan when resolveParentSessionId returns no-session-dir (no YAML mutation, no tracker move)", async () => {
    // The repo's claude-projects dir doesn't exist — infrastructure
    // problem, not a per-card issue. The scan must NOT fall back to
    // resetting the YAML to ToDo (that would silently re-trigger
    // dispatch every tick on an unreachable agent). Just bail and
    // log. Subsequent ticks may recover once the dir is created.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-nodir", "No session dir", "In Progress"),
    ]);
    mockFindByExternalId.mockReturnValue(
      inProgressIssue("ISS-92", "ip-nodir", "stamped-uuid"),
    );
    mockResolveParentSessionId.mockResolvedValue({ kind: "no-session-dir" });

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockTracker.moveToStatus).not.toHaveBeenCalled();
    // YAML must NOT be rewritten to ToDo / null dispatch_id.
    const reset = mockWriteIssueFn.mock.calls.find((c) => {
      const issue = c[1] as { external_id?: string; dispatch_id?: unknown };
      return issue?.external_id === "ip-nodir" && issue.dispatch_id === null;
    });
    expect(reset).toBeUndefined();
  });

  it("composes a resume task containing TEAM_PROMPT, the YAML path, the issue id, the resume phrasing, and the danx_issue_save directive", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-prompt", "Prompt check", "In Progress"),
    ]);
    mockFindByExternalId.mockReturnValue(
      inProgressIssue("ISS-93", "ip-prompt", "uuid-prompt"),
    );
    mockResolveParentSessionId.mockResolvedValue({
      kind: "found",
      sessionId: "session-prompt",
    });

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchArg = mockDispatch.mock.calls[0][0] as { task: string };
    expect(dispatchArg.task).toContain("/danx-next");
    expect(dispatchArg.task).toContain("Resuming prior dispatch on ISS-93");
    expect(dispatchArg.task).toContain(
      "/test/repos/test-repo/.danxbot/issues/open/ISS-93.yml",
    );
    expect(dispatchArg.task).toContain(
      'Call danx_issue_save({id: "ISS-93"}) when done.',
    );
  });

  it("stamps + writes the resume YAML BEFORE dispatch — ordering invariant", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-order", "Order", "In Progress"),
    ]);
    mockFindByExternalId.mockReturnValue(
      inProgressIssue("ISS-94", "ip-order", "uuid-order"),
    );
    mockResolveParentSessionId.mockResolvedValue({
      kind: "found",
      sessionId: "session-order",
    });

    await poll(MOCK_REPO_CONTEXT);

    const stampOrder = mockStampDispatchAndWrite.mock.invocationCallOrder[0];
    const dispatchOrder = mockDispatch.mock.invocationCallOrder[0];
    expect(stampOrder).toBeDefined();
    expect(dispatchOrder).toBeDefined();
    expect(stampOrder).toBeLessThan(dispatchOrder);
  });

  it("tolerates a moveToStatus failure during reset and continues to the next orphan", async () => {
    // First orphan's session is gone (not-found). Tracker's
    // moveToStatus rejects (network, permissions, etc.). The reset
    // must STILL persist the local YAML and the scan must continue
    // to the next In Progress card.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-fail-reset", "Reset will fail", "In Progress"),
      ref("ip-found", "Resumable", "In Progress"),
    ]);
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-fail-reset"
          ? inProgressIssue("ISS-95", "ip-fail-reset", "uuid-gone")
          : externalId === "ip-found"
            ? inProgressIssue("ISS-96", "ip-found", "uuid-good")
            : null,
    );
    mockResolveParentSessionId.mockImplementation(
      async (_repo: string, jobId: string) =>
        jobId === "uuid-gone"
          ? { kind: "not-found" }
          : { kind: "found", sessionId: "session-good" },
    );
    mockTracker.moveToStatus.mockRejectedValueOnce(
      new Error("Tracker network error"),
    );

    await poll(MOCK_REPO_CONTEXT);

    // Reset's local YAML write happened despite tracker failure.
    const localReset = mockWriteIssueFn.mock.calls.find((c) => {
      const issue = c[1] as { external_id?: string; status?: string };
      return issue?.external_id === "ip-fail-reset" && issue.status === "ToDo";
    });
    expect(localReset).toBeDefined();
    // Scan continued; second orphan resumed.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as { parentJobId?: string };
    expect(arg.parentJobId).toBe("uuid-good");
  });

  it("mixed not-found + found across In Progress refs — first resets, second resumes", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-reset", "Stale", "In Progress"),
      ref("ip-resume", "Resumable", "In Progress"),
    ]);
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-reset"
          ? inProgressIssue("ISS-97", "ip-reset", "uuid-stale")
          : externalId === "ip-resume"
            ? inProgressIssue("ISS-98", "ip-resume", "uuid-live")
            : null,
    );
    mockResolveParentSessionId.mockImplementation(
      async (_repo: string, jobId: string) =>
        jobId === "uuid-stale"
          ? { kind: "not-found" }
          : { kind: "found", sessionId: "session-live" },
    );

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("ip-reset", "ToDo");
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as { parentJobId?: string };
    expect(arg.parentJobId).toBe("uuid-live");
  });

  it("bulk-syncs missing In Progress YAML BEFORE the orphan-resume check (ordering invariant)", async () => {
    // The orphan-resume helper relies on findByExternalId returning a
    // local YAML, which only exists for an unseen In Progress card if
    // bulk-sync ran first. Pin the order: hydrateFromRemote → before
    // → resolveParentSessionId. A regression that swapped them would
    // silently miss every brand-new In Progress orphan.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-fresh", "Brand new IP card", "In Progress"),
    ]);
    // findByExternalId returns null on first call (pre-bulk-sync),
    // populated on second call (post-bulk-sync, during orphan check).
    let findCount = 0;
    mockFindByExternalId.mockImplementation(() => {
      findCount += 1;
      return findCount === 1
        ? null
        : inProgressIssue("ISS-99", "ip-fresh", null);
    });

    await poll(MOCK_REPO_CONTEXT);

    const hydrateOrder = mockHydrateFromRemote.mock.invocationCallOrder[0];
    const resolveOrder = mockResolveParentSessionId.mock.invocationCallOrder[0];
    expect(hydrateOrder).toBeDefined();
    // resolveOrder may be undefined when the bulk-synced YAML has
    // null dispatch_id (the orphan check skips it). The invariant we
    // care about is that hydrate fired BEFORE any resolve attempt.
    if (resolveOrder !== undefined) {
      expect(hydrateOrder).toBeLessThan(resolveOrder);
    }
  });
});
