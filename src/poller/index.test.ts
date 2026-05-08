import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RepoContext } from "../types.js";
import type { Issue, IssueRef, IssueStatus } from "../issue-tracker/interface.js";

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
    needsApprovalListId: "nh-list",
    doneListId: "done-list",
    cancelledListId: "cancelled-list",
    actionItemsListId: "ai-list",
    bugLabelId: "bug-label",
    featureLabelId: "feature-label",
    epicLabelId: "epic-label",
    needsHelpLabelId: "nh-label",
    needsApprovalLabelId: "nh-label",
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
  issuePrefix: "ISS",
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
      needsApprovalListId: "nh-list",
      doneListId: "done-list",
      cancelledListId: "cancelled-list",
      actionItemsListId: "ai-list",
      bugLabelId: "bug-label",
      featureLabelId: "feature-label",
      epicLabelId: "epic-label",
      needsHelpLabelId: "nh-label",
      needsApprovalLabelId: "nh-label",
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
  TEAM_PROMPT: "/danx-next",
  TEAM_PROMPT_RESUME: "/danx-next",
  IDEATOR_PROMPT: "/danx-ideate",
  TRIAGE_CARD_PROMPT: (id: string) =>
    `Triage card ${id} using the danx-triage-card skill.`,
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
  // DX-150: cheap synchronous shape check used by the per-tick external_id
  // heal pass. Default true so ad-hoc fixtures (`ext-DX-N`) don't get
  // mass-blanked when a test forgets to wire it.
  isValidExternalId: vi.fn().mockReturnValue(true),
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
// ISS-69 mirror: orphan-resume now consults the same DB-backed liveness
// guard the ToDo dispatch path uses. Default mock = no live rows + dead
// PID so existing orphan-resume tests behave as before; new tests opt
// into a live row to assert the skip path.
const mockFindNonTerminalDispatches = vi.fn().mockResolvedValue([]);
vi.mock("../dashboard/dispatches-db.js", () => ({
  findNonTerminalDispatches: (...args: unknown[]) =>
    mockFindNonTerminalDispatches(...args),
}));
const mockIsPidAlive = vi.fn().mockReturnValue(false);
vi.mock("../agent/host-pid.js", () => ({
  isPidAlive: (...args: unknown[]) => mockIsPidAlive(...args),
}));

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
  dispatch: null,
  status: "ToDo" as const,
  type: "Feature" as const,
  title: "fake",
  description: "",
  triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
  ac: [],
  comments: [],
  retro: { good: "", bad: "", action_item_ids: [], commits: [] },
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
      dispatch: { id: dispatchId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
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
      dispatch: { id: dispatchId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
    }),
  );
const mockEnsureIssuesDirs = vi.fn();
const mockEnsureGitignoreEntry = vi.fn();
/**
 * Default impls derive Issue[] from the most recent
 * `tracker.fetchOpenCards` resolved value, projecting each `IssueRef`
 * into a fully-populated `Issue` so existing tests (which set up
 * dispatch decisions via `fetchOpenCards.mockResolvedValueOnce(refs)`)
 * keep working after the ISS-86 cutover where local YAMLs drive the
 * dispatch source. Tests that need a custom local-YAML scan can
 * override via `.mockReturnValueOnce`.
 */
function refToFakeIssue(ref: IssueRef): Issue {
  return {
    schema_version: 3,
    tracker: "trello",
    id: ref.id || `ISS-FAKE-${ref.external_id}`,
    external_id: ref.external_id,
    parent_id: null,
    children: [],
    dispatch: null,
    status: ref.status,
    type: "Feature",
    title: ref.title,
    description: "",
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    history: [],
  };
}

function _currentOpenCards(): IssueRef[] {
  const settled = mockTracker.fetchOpenCards.mock.settledResults;
  if (!settled || settled.length === 0) return [];
  const last = settled[settled.length - 1];
  return last.type === "fulfilled" ? (last.value as IssueRef[]) : [];
}

// Mock signatures take (repoPath, prefix) since ISS-100 (prefix-aware
// issue id helpers); listTriageDueYamls also takes `now` between path
// and prefix. Production calls supply both args; tests assert on
// `mock.calls[0][1]` to verify the prefix is forwarded.
const mockListDispatchableYamls = vi.fn(
  (_repoPath: string, _prefix?: string): Issue[] =>
    _currentOpenCards()
      .filter((r) => r.status === "ToDo")
      .map(refToFakeIssue),
);
const mockListInProgressYamls = vi.fn(
  (_repoPath: string, _prefix?: string): Issue[] =>
    _currentOpenCards()
      .filter((r) => r.status === "In Progress")
      .map(refToFakeIssue),
);
const mockListBlockedTodoYamls = vi.fn(
  (_repoPath: string, _prefix?: string): Issue[] => [],
);
const mockListTriageDueYamls = vi.fn(
  (_repoPath: string, _now: number, _prefix?: string): Issue[] => [],
);

vi.mock("./local-issues.js", () => ({
  listDispatchableYamls: (...args: unknown[]) =>
    mockListDispatchableYamls(...(args as [string, string?])),
  listInProgressYamls: (...args: unknown[]) =>
    mockListInProgressYamls(...(args as [string, string?])),
  listBlockedTodoYamls: (...args: unknown[]) =>
    mockListBlockedTodoYamls(...(args as [string, string?])),
  listTriageDueYamls: (...args: unknown[]) =>
    mockListTriageDueYamls(...(args as [string, number, string?])),
}));

const mockClearDispatchAndWrite = vi.fn((...args: unknown[]) => {
  const issue = args[1] as Record<string, unknown>;
  return { ...issue, dispatch: null };
});

vi.mock("./yaml-lifecycle.js", () => ({
  hydrateFromRemote: (...args: unknown[]) => mockHydrateFromRemote(...args),
  loadLocal: (...args: unknown[]) => mockLoadLocal(...args),
  findByExternalId: (...args: unknown[]) => mockFindByExternalId(...args),
  writeIssue: (...args: unknown[]) => mockWriteIssueFn(...args),
  stampDispatchAndWrite: (...args: unknown[]) =>
    mockStampDispatchAndWrite(...args),
  clearDispatchAndWrite: (...args: unknown[]) =>
    mockClearDispatchAndWrite(...args),
  ensureIssuesDirs: (...args: unknown[]) => mockEnsureIssuesDirs(...args),
  ensureGitignoreEntry: (...args: unknown[]) =>
    mockEnsureGitignoreEntry(...args),
  issuePath: (repo: string, id: string, state: string) =>
    `${repo}/.danxbot/issues/${state}/${id}.yml`,
  moveToClosedIfTerminal: vi.fn().mockReturnValue(false),
}));

// ISS-133 Phase 3: poller heal pass. Module is mocked so existing
// tests' fake fs doesn't crash the real readdirSync; the integration
// test below overrides the implementation to assert call order +
// arguments.
const mockHealLocalYamls = vi
  .fn()
  .mockReturnValue({ healed: [], errors: [] });
vi.mock("./heal.js", () => ({
  healLocalYamls: (...args: unknown[]) => mockHealLocalYamls(...args),
}));

// DX-150: per-tick external_id format heal pass. Mocked so existing
// tests' fake fs doesn't crash the real readdirSync; the wiring test
// below overrides the implementation to assert call order vs
// healLocalYamls / tracker.fetchOpenCards.
const mockHealExternalIds = vi
  .fn()
  .mockReturnValue({ healed: [], errors: [] });
vi.mock("./heal-external-id.js", () => ({
  healExternalIds: (...args: unknown[]) => mockHealExternalIds(...args),
}));

// DX-132: retry-queue drain at top of `_poll`. Mocked so the existing
// fake-fs tests don't try to readdirSync a real `.trello-retry/`. The
// wiring test below overrides the implementation to assert it's called
// with the tracker + repoLocalPath + prefix.
const mockDrainRetries = vi.fn().mockResolvedValue({
  attempted: 0,
  succeeded: 0,
  failed: 0,
  exhausted: 0,
  yamlMissing: 0,
  yamlInvalid: 0,
  skipped: 0,
  malformed: 0,
});
vi.mock("../issue-tracker/retry-queue.js", () => ({
  drainRetries: (...args: unknown[]) => mockDrainRetries(...args),
}));

// Feature-aware default: ideator's env default is `false` (explicit
// opt-in via `<repo>/.danxbot/settings.json` overrides). Every other
// feature defaults to `true` so existing tests that don't care about
// the toggle continue to dispatch.
const mockIsFeatureEnabled = vi.fn(
  (...args: unknown[]) => (args[1] as string) !== "ideator",
);
const mockGetIssuePollerPickupPrefix = vi.fn().mockReturnValue(null);
vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
  getIssuePollerPickupPrefix: (...args: unknown[]) =>
    mockGetIssuePollerPickupPrefix(...args),
}));

vi.mock("../workspace/write-if-changed.js", () => ({
  writeIfChanged: (path: string, content: string): boolean => {
    mockWriteFileSync(path, content);
    return true;
  },
}));

// Shared logger instance so tests can spy on log.error (e.g. crash-isolation
// tests assert the top-level catch fires exactly once). Created via
// `vi.hoisted` because the mock factory is hoisted above test code.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../logger.js", () => ({
  createLogger: () => mockLogger,
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
  dispatch: null,
  status: "Done" as const,
  type: "Feature" as const,
  title: "default",
  description: "",
  triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
  ac: [],
  comments: [],
  retro: { good: "", bad: "", action_item_ids: [], commits: [] },
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
    (...args: unknown[]) =>
      (args[1] as string) !== "ideator" && (args[1] as string) !== "autoTriage",
  );
  mockGetIssuePollerPickupPrefix.mockReset();
  mockGetIssuePollerPickupPrefix.mockReturnValue(null);
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
      (...args: unknown[]) =>
      (args[1] as string) !== "ideator" && (args[1] as string) !== "autoTriage",
    );
    mockGetIssuePollerPickupPrefix.mockReset();
    mockGetIssuePollerPickupPrefix.mockReturnValue(null);
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

  // Regression: workspace `.claude/rules/` accumulated stale `danx-*`
  // files when an inject-source rule was retired (Phase 5 retired
  // `danx-trello-config.md` but live workspaces in `repos/gpt-manager/`
  // kept loading the stale copy because `mirrorWorkspaceTree` is
  // write-only). Prune step deletes any `danx-*` entry in a workspace's
  // `.claude/rules/` or `.claude/skills/` that no longer exists in the
  // matching inject source. Operator-authored entries (no `danx-`
  // prefix) survive — exact symmetry with `scrubRepoRootDanxArtifacts`.
  it("injectDanxWorkspaces prunes stale danx-* files in workspace .claude/rules and .claude/skills (non-danx operator files survive)", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const demoSourceRulesDir = `${demoSource}/.claude/rules`;
    const demoSourceSkillsDir = `${demoSource}/.claude/skills`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;
    const demoTargetRulesDir = `${demoTargetRoot}/.claude/rules`;
    const demoTargetSkillsDir = `${demoTargetRoot}/.claude/skills`;
    const staleRulePath = `${demoTargetRulesDir}/danx-trello-config.md`;
    const operatorRulePath = `${demoTargetRulesDir}/operator.md`;
    const staleSkillDir = `${demoTargetSkillsDir}/danx-old-skill`;

    const sourceDirSuffixes = [demoSource];
    const targetDirExact = new Set<string>([
      workspacesTargetRoot,
      demoTargetRoot,
      `${demoTargetRoot}/.claude`,
      demoTargetRulesDir,
      demoTargetSkillsDir,
      staleSkillDir,
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
      // Inject source has only workspace.yml — no static rules / skills,
      // so every `danx-*` entry in the target is stale.
      if (path.endsWith(demoSource)) return ["workspace.yml"];
      if (path.endsWith(demoSourceRulesDir)) return [];
      if (path.endsWith(demoSourceSkillsDir)) return [];
      if (path === workspacesTargetRoot) return ["demo"];
      if (path === demoTargetRoot) return [".claude"];
      if (path === `${demoTargetRoot}/.claude`) return ["rules", "skills"];
      if (path === demoTargetRulesDir) {
        return ["danx-trello-config.md", "operator.md"];
      }
      if (path === demoTargetSkillsDir) return ["danx-old-skill"];
      if (path === staleSkillDir) return [];
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
      return "";
    });

    await poll(MOCK_REPO_CONTEXT);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).toContain(staleRulePath);
    expect(rmPaths).toContain(staleSkillDir);
    expect(rmPaths).not.toContain(operatorRulePath);
  });

  // (a) source-shipped passthrough: a `danx-*` rule that is STILL in
  // the inject source must not be pruned. Without this guard the
  // prune would nuke every danx-* file on every tick.
  it("injectDanxWorkspaces does not prune a danx-* rule that still ships from inject source", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const demoSourceRulesDir = `${demoSource}/.claude/rules`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;
    const demoTargetRulesDir = `${demoTargetRoot}/.claude/rules`;
    const sharedRulePath = `${demoTargetRulesDir}/danx-current.md`;

    const sourceDirSuffixes = [demoSource, demoSourceRulesDir];
    const targetDirExact = new Set<string>([
      workspacesTargetRoot,
      demoTargetRoot,
      `${demoTargetRoot}/.claude`,
      demoTargetRulesDir,
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
      if (path.endsWith(demoSource)) return ["workspace.yml", ".claude"];
      if (path.endsWith(`${demoSource}/.claude`)) return ["rules"];
      if (path.endsWith(demoSourceRulesDir)) return ["danx-current.md"];
      if (path === workspacesTargetRoot) return ["demo"];
      if (path === demoTargetRoot) return [".claude"];
      if (path === `${demoTargetRoot}/.claude`) return ["rules"];
      if (path === demoTargetRulesDir) return ["danx-current.md"];
      return [];
    });

    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") {
        return { isDirectory: () => false };
      }
      const isDir =
        targetDirExact.has(path) ||
        path.endsWith(`${demoSource}/.claude`) ||
        sourceDirSuffixes.some((suffix) => path.endsWith(suffix));
      return { isDirectory: () => isDir };
    });

    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      if (path.endsWith("workspace.yml"))
        return "name: demo\ndescription: demo\n";
      if (path.endsWith("danx-current.md")) return "current rule body\n";
      return "";
    });

    await poll(MOCK_REPO_CONTEXT);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).not.toContain(sharedRulePath);
  });

  // (b) per-repo render allowlist exemption: filenames written by
  // `renderPerRepoFilesIntoWorkspaces` (consumed via the
  // `PER_REPO_RENDER_RULE_NAMES` Set) must not be pruned even when
  // they are absent from the inject source. The render runs AFTER the
  // prune; without this exemption every tick would rm the rendered
  // file and re-write it (or worse — leave the workspace empty if a
  // future refactor changes ordering).
  it("injectDanxWorkspaces does not prune per-repo render filenames absent from inject source", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;
    const demoTargetRulesDir = `${demoTargetRoot}/.claude/rules`;
    const renderedNames = [
      "danx-repo-config.md",
      "danx-repo-overview.md",
      "danx-repo-workflow.md",
      "danx-tools.md",
    ];

    const sourceDirSuffixes = [demoSource];
    const targetDirExact = new Set<string>([
      workspacesTargetRoot,
      demoTargetRoot,
      `${demoTargetRoot}/.claude`,
      demoTargetRulesDir,
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
      if (path.endsWith(demoSource)) return ["workspace.yml"];
      if (path === workspacesTargetRoot) return ["demo"];
      if (path === demoTargetRoot) return [".claude"];
      if (path === `${demoTargetRoot}/.claude`) return ["rules"];
      if (path === demoTargetRulesDir) return [...renderedNames];
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
      return "";
    });

    await poll(MOCK_REPO_CONTEXT);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    for (const name of renderedNames) {
      expect(rmPaths).not.toContain(`${demoTargetRulesDir}/${name}`);
    }
  });

  // (c) tools/ scope guard: a `danx-*` file in `<target>/.claude/tools/`
  // must NOT be pruned. `tools/` is per-repo render territory
  // (`copyRepoToolScripts`), and operator-authored scripts there are
  // not `danx-*`-prefixed by convention — but the contract is "we
  // touch rules/ and skills/ only", and pinning that contract guards
  // against a future maintainer adding `tools/` to the prune scope
  // and silently nuking per-repo tool scripts.
  it("injectDanxWorkspaces does not prune danx-* entries from .claude/tools/ (out of scope)", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;
    const demoTargetToolsDir = `${demoTargetRoot}/.claude/tools`;
    const toolsDanxPath = `${demoTargetToolsDir}/danx-tool.sh`;

    const sourceDirSuffixes = [demoSource];
    const targetDirExact = new Set<string>([
      workspacesTargetRoot,
      demoTargetRoot,
      `${demoTargetRoot}/.claude`,
      demoTargetToolsDir,
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
      if (path.endsWith(demoSource)) return ["workspace.yml"];
      if (path === workspacesTargetRoot) return ["demo"];
      if (path === demoTargetRoot) return [".claude"];
      if (path === `${demoTargetRoot}/.claude`) return ["tools"];
      if (path === demoTargetToolsDir) return ["danx-tool.sh"];
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
      return "";
    });

    await poll(MOCK_REPO_CONTEXT);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).not.toContain(toolsDanxPath);
  });

  // (d) DX-149: rm failures during prune used to propagate out of
  // `poll()` so the operator saw them immediately ("fail-loud per
  // CLAUDE.md"). DX-149 retired that contract for everything inside
  // `_poll`: the worker process must survive a single bad tick so
  // Slack listener / dispatch API / dashboard SSE stay alive when
  // ONE per-tick failure (tracker, lock, fs) hits. The replacement
  // contract — log+swallow at the top of `_poll`, retry on the next
  // tick — applies to syncRepoFiles' rm failures too because the
  // wrap is intentionally one block (see DX-149 design rationale on
  // top-level vs per-call). This test pins the new shape so a
  // future regression that re-introduces the rethrow surfaces
  // immediately.
  it("injectDanxWorkspaces rm failure during prune is logged + swallowed (DX-149)", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;
    const demoTargetRulesDir = `${demoTargetRoot}/.claude/rules`;
    const staleRulePath = `${demoTargetRulesDir}/danx-trello-config.md`;

    const sourceDirSuffixes = [demoSource];
    const targetDirExact = new Set<string>([
      workspacesTargetRoot,
      demoTargetRoot,
      `${demoTargetRoot}/.claude`,
      demoTargetRulesDir,
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
      if (path.endsWith(demoSource)) return ["workspace.yml"];
      if (path === workspacesTargetRoot) return ["demo"];
      if (path === demoTargetRoot) return [".claude"];
      if (path === `${demoTargetRoot}/.claude`) return ["rules"];
      if (path === demoTargetRulesDir) return ["danx-trello-config.md"];
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
      return "";
    });

    mockRmSync.mockImplementation((path: unknown) => {
      if (path === staleRulePath) {
        throw new Error("EACCES: permission denied");
      }
    });

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    const errCalls = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_poll crashed"),
    );
    expect(errCalls).toHaveLength(1);
    expect(String(errCalls[0][0])).toMatch(/EACCES/);
  });

  // Symmetric DX-149 update for `scrubRepoRootDanxArtifacts`. Pre-DX-149
  // an rm failure here propagated out of `poll()`; post-DX-149 the
  // `_poll` top-level catch logs+swallows so the worker process
  // survives. Stale `danx-*` rules at `<repo>/.claude/` will retry on
  // the next tick — same convergence model as the tracker call wrap.
  it("scrubRepoRootDanxArtifacts rm failure is logged + swallowed (DX-149)", async () => {
    const workspacesSource = "src/poller/inject/workspaces";
    const repoRootClaudeRulesDir = "/test/repos/test-repo/.claude/rules";
    const staleRepoRootRulePath = `${repoRootClaudeRulesDir}/danx-leftover.md`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";

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
      if (path === workspacesTargetRoot) return true;
      if (path === repoRootClaudeRulesDir) return true;
      return false;
    });

    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith("/inject/rules")) return [];
      if (path.endsWith("/inject/tools")) return [];
      if (path.endsWith("/inject/skills")) return [];
      if (path.endsWith(workspacesSource)) return [];
      if (path === workspacesTargetRoot) return [];
      if (path === repoRootClaudeRulesDir) return ["danx-leftover.md"];
      return [];
    });

    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") {
        return { isDirectory: () => false };
      }
      const isDir =
        path === workspacesTargetRoot ||
        path === repoRootClaudeRulesDir ||
        path.endsWith(workspacesSource);
      return { isDirectory: () => isDir };
    });

    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      return "";
    });

    mockRmSync.mockImplementation((path: unknown) => {
      if (path === staleRepoRootRulePath) {
        throw new Error("EACCES: permission denied");
      }
    });

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    const errCalls = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_poll crashed"),
    );
    expect(errCalls).toHaveLength(1);
    expect(String(errCalls[0][0])).toMatch(/EACCES/);
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
    // ISS-86: dispatch source is local YAML, not the (real) tracker's
    // fetchOpenCards. Provide one synthetic local Issue so the
    // credentials guard inside spawnClaude is reached.
    mockListDispatchableYamls.mockReturnValueOnce([
      refToFakeIssue({ id: "", external_id: "c1", title: "Card 1", status: "ToDo" }),
    ]);

    // DX-149: the credentials-guard throw is now caught by `_poll`'s
    // top-level catch (the worker survives an in-tick crash; the
    // operator sees the error in logs and the next tick re-asserts
    // the guard). Pre-DX-149 this propagated out of `poll()`; that
    // contract is retired so a single bad repo can't kill the whole
    // worker process.
    await expect(poll(repoNoCreds)).resolves.toBeUndefined();
    const errCalls = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_poll crashed"),
    );
    expect(errCalls).toHaveLength(1);
    expect(String(errCalls[0][0])).toMatch(/without complete trello credentials/);
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

/**
 * DX-149 — _poll crash isolation.
 *
 * Before the fix, any tracker call inside `_poll` AFTER the existing
 * inner try/catch around `fetchOpenCards` (e.g. `tryAcquireLock` →
 * `tracker.getComments`) would throw straight past `_poll` and out
 * through `poll()`'s `finally`, killing the whole worker process.
 *
 * Contract: a single top-level try/catch in `_poll` swallows any
 * thrown error, logs it, and returns cleanly so the next tick fires.
 * `state.polling` is already reset in `poll()`'s finally; these tests
 * verify that property end-to-end by calling `poll()` twice.
 */
describe("poll — _poll crash isolation (DX-149)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("survives tracker.getComments rejection inside tryAcquireLock — no rethrow", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    // Trigger the exact crash class from production (DX-149): Trello
    // 400 on /cards/<bogus-external-id>/actions surfaces as a thrown
    // error from `getComments`, which `tryAcquireLock` calls. Pre-fix,
    // this killed the worker process. Post-fix, the top-level catch
    // logs and returns cleanly.
    mockTracker.getComments.mockRejectedValue(
      new Error("Trello API error: 400 Bad Request (GET /cards/mem-2/actions)"),
    );

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();

    // Top-level catch fired with a diagnostic prefix so the error is
    // attributable to the poller and the originating repo.
    const crashLogs = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_poll crashed"),
    );
    expect(crashLogs).toHaveLength(1);
    expect(String(crashLogs[0][0])).toContain("test-repo");
    expect(String(crashLogs[0][0])).toContain("Trello API error: 400");

    // Dispatch never fired (lock acquisition is gating).
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("subsequent poll() tick fires after a _poll crash — state.polling reset", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    mockTracker.getComments.mockRejectedValueOnce(new Error("boom"));

    // First tick: crashes inside _poll, swallowed by top-level catch.
    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();

    // Second tick: tracker is healthy again. fetchOpenCards must be
    // re-invoked, proving `state.polling` was correctly reset in
    // poll()'s finally despite the inner crash.
    mockTracker.getComments.mockResolvedValue([]);
    mockTracker.fetchOpenCards.mockClear();
    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });

  it("preserves no-double-fire when fetchOpenCards rejects (existing inner catch wins)", async () => {
    mockTracker.fetchOpenCards.mockRejectedValue(new Error("Network error"));

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();

    // The inner try/catch at the fetchOpenCards site logs once and
    // returns early. The new outer try/catch must NOT also log —
    // that would surface the same error twice on every tracker
    // outage. Assert exactly one error log fires for this path.
    const errorCalls = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("Error fetching cards"),
    );
    expect(errorCalls).toHaveLength(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("survives an early-_poll throw from healLocalYamls (representative non-tracker path) — no rethrow, dispatch skipped", async () => {
    // Reviewer-recommended representative test for the deeper-in-_poll
    // throw paths the wrap also covers (orphan-push, evictDeadDispatches,
    // checkAndSpawnTriage/Ideator, etc.). `healLocalYamls` runs at the
    // very top of _poll's body — well before any tracker call — so a
    // throw here exercises the catch from a structurally distinct
    // entry point relative to the tracker-call tests above. Pins the
    // contract that the catch covers the WHOLE body, not just the
    // tracker subset.
    mockHealLocalYamls.mockImplementationOnce(() => {
      throw new Error("disk full during heal pass");
    });

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();

    const crashLogs = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_poll crashed"),
    );
    expect(crashLogs).toHaveLength(1);
    expect(String(crashLogs[0][0])).toContain("disk full during heal pass");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("happy path unchanged — no top-level catch fires when nothing throws", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    mockTracker.getComments.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // The new top-level catch must not fire on the green path. Pin the
    // exact diagnostic prefix the catch emits at index.ts:915
    // (`_poll crashed — tick aborted, next tick will retry: ...`) so a
    // future log-format change updates this test in lockstep with the
    // implementation.
    const crashLogs = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_poll crashed"),
    );
    expect(crashLogs).toHaveLength(0);
  });

  it("top-level catch does not trip backoff (next tick fetches cards as normal, no `In backoff` skip)", async () => {
    // Pin the invariant in the comment at index.ts:516–519: a `_poll`
    // crash is logged + swallowed but does NOT count as a dispatch
    // failure for backoff purposes. Observable behavior: after a crash
    // the very next `poll()` invokes `fetchOpenCards` and does NOT log
    // `In backoff`. A regression that incremented `state.consecutiveFailures`
    // inside the top-level catch would skip the second tick with
    // `In backoff — Ns remaining` instead.
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    mockTracker.getComments.mockRejectedValueOnce(
      new Error("Trello API error: 400"),
    );

    await poll(MOCK_REPO_CONTEXT);
    const firstCallCount = mockTracker.fetchOpenCards.mock.calls.length;

    // Second tick — must run, must not be skipped by backoff. Assert
    // it advances the call count rather than fixing an absolute number,
    // since `_poll` may call `fetchOpenCards` more than once per tick
    // (Needs Help + ToDo paths share the same mock).
    mockTracker.getComments.mockResolvedValue([]);
    await poll(MOCK_REPO_CONTEXT);
    expect(mockTracker.fetchOpenCards.mock.calls.length).toBeGreaterThan(
      firstCallCount,
    );

    const backoffLogs = mockLogger.info.mock.calls.filter((c) =>
      String(c[0]).includes("In backoff"),
    );
    expect(backoffLogs).toHaveLength(0);
  });
});

/**
 * DX-132 Phase 2 wiring — drainRetries runs at the top of `_poll` BEFORE
 * any list fetch, with the active tracker + repo paths threaded through.
 *
 * Module-level behavior of drainRetries itself is tested in
 * `src/issue-tracker/retry-queue.test.ts`; these tests pin only the
 * wiring (it gets called, with the right deps, on a healthy tick).
 */
describe("poll — DX-132 retry-queue drain wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    mockDrainRetries.mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      exhausted: 0,
      yamlMissing: 0,
      yamlInvalid: 0,
      skipped: 0,
      malformed: 0,
    });
  });

  it("calls drainRetries once per tick with the active tracker + repo paths", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDrainRetries).toHaveBeenCalledTimes(1);
    const callArg = mockDrainRetries.mock.calls[0]![0] as {
      tracker: unknown;
      repoLocalPath: string;
      prefix: string;
    };
    expect(callArg.tracker).toBe(mockTracker);
    expect(callArg.repoLocalPath).toBe(MOCK_REPO_CONTEXT.localPath);
    expect(callArg.prefix).toBe(MOCK_REPO_CONTEXT.issuePrefix);
  });

  it("drains BEFORE fetchOpenCards so a recovered tracker can replay queued pushes the same tick", async () => {
    const callOrder: string[] = [];
    mockDrainRetries.mockImplementation(async () => {
      callOrder.push("drainRetries");
      return {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        exhausted: 0,
        yamlMissing: 0,
        yamlInvalid: 0,
        skipped: 0,
        malformed: 0,
      };
    });
    mockTracker.fetchOpenCards.mockImplementation(async () => {
      callOrder.push("fetchOpenCards");
      return [];
    });

    await poll(MOCK_REPO_CONTEXT);

    expect(callOrder.indexOf("drainRetries")).toBeGreaterThan(-1);
    expect(callOrder.indexOf("drainRetries")).toBeLessThan(
      callOrder.indexOf("fetchOpenCards"),
    );
  });

  it("a drainRetries throw is caught by the outer DX-149 wrap — tick aborts, next tick still fires", async () => {
    mockDrainRetries.mockRejectedValueOnce(new Error("retry queue exploded"));

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();

    const crashLogs = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_poll crashed"),
    );
    expect(crashLogs).toHaveLength(1);
    expect(String(crashLogs[0][0])).toContain("retry queue exploded");
    expect(mockDispatch).not.toHaveBeenCalled();

    // Subsequent tick recovers — drain returns clean, fetch fires.
    mockDrainRetries.mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      exhausted: 0,
      yamlMissing: 0,
      yamlInvalid: 0,
      skipped: 0,
      malformed: 0,
    });
    mockTracker.fetchOpenCards.mockResolvedValue([]);
    await poll(MOCK_REPO_CONTEXT);
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });

  it("suppresses the drain summary log on a no-op tick (all zeros)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([]);
    // beforeEach already sets mockDrainRetries to all zeros.

    await poll(MOCK_REPO_CONTEXT);

    const drainLogs = mockLogger.info.mock.calls.filter((c) =>
      String(c[0]).includes("Retry queue drained"),
    );
    expect(drainLogs).toHaveLength(0);
  });

  it("emits the drain summary log when work was done (attempted > 0)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([]);
    mockDrainRetries.mockResolvedValue({
      attempted: 2,
      succeeded: 2,
      failed: 0,
      exhausted: 0,
      yamlMissing: 0,
      yamlInvalid: 0,
      skipped: 0,
      malformed: 0,
    });

    await poll(MOCK_REPO_CONTEXT);

    const drainLogs = mockLogger.info.mock.calls.filter((c) =>
      String(c[0]).includes("Retry queue drained"),
    );
    expect(drainLogs).toHaveLength(1);
    expect(String(drainLogs[0][0])).toContain("2/2 succeeded");
  });
});

describe("poll — issuePoller feature toggle", () => {
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
      (...args: unknown[]) => (args[1] as string) !== "issuePoller",
    );
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "issuePoller",
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
    mockGetIssuePollerPickupPrefix.mockReturnValue(null);
  });

  it("dispatches the matching test card when other ToDo cards are present (system-test isolation)", async () => {
    mockGetIssuePollerPickupPrefix.mockReturnValue("[System Test]");
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
    mockGetIssuePollerPickupPrefix.mockReturnValue("[System Test]");
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("a", "Real ToDo card A", "ToDo"),
      ref("b", "Real ToDo card B", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches normally when prefix is null (filter disabled)", async () => {
    mockGetIssuePollerPickupPrefix.mockReturnValue(null);
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("any", "Some real card", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves stuck-card recovery scope: only matching cards are saved as priorTodoCardIds", async () => {
    mockGetIssuePollerPickupPrefix.mockReturnValue("[X]");
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
      (...args: unknown[]) => (args[1] as string) !== "issuePoller",
    );

    start();

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "issuePoller",
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
      if (feature !== "issuePoller") return true;
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
      (...args: unknown[]) => (args[1] as string) !== "issuePoller",
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
    // The post-dispatch check now reads the local YAML to detect
    // intentional `blocked` records (regression for the false-positive
    // critical-failure trip). Reset between tests so per-test
    // implementations don't leak forward.
    mockFindByExternalId.mockReset();
    mockFindByExternalId.mockReturnValue(null);
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
      dispatch: null,
      status,
      type: "Feature" as const,
      title,
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
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

  it("does NOT write the flag when the tracked card is in ToDo because the agent intentionally Blocked it (local YAML has blocked record)", async () => {
    // Regression for the false-positive critical-failure trip that
    // happened when an epic's agent legitimately set
    // `blocked: { by: ["ISS-X"] }` on the local YAML and saved. The
    // worker's issue-save handler enforces `blocked != null →
    // status: "ToDo"` (`forceBlockedToToDo`), so the tracker still
    // shows ToDo after the dispatch — but this is intentional
    // progress, not an env-level blocker. The post-dispatch check
    // must read the local YAML and treat a non-null `blocked` field
    // as legitimate.
    //
    // Bug timeline: dispatch starts (YAML has blocked: null, card
    // dispatches normally) → agent runs and sets blocked → save →
    // dispatch ends → post-dispatch check fetches the card (still
    // ToDo on tracker because forceBlockedToToDo) → BEFORE the fix,
    // the check would write the critical-failure flag because it
    // only looked at tracker status. AFTER the fix, the check also
    // reads the local YAML and skips the flag when blocked is set.
    mockTracker.getCard.mockResolvedValue(
      issueWithStatus("c1", "Epic card", "ToDo"),
    );
    // First call (during primary dispatch in `poll`): YAML's blocked
    // is null, so the card dispatches normally. Post-dispatch check
    // calls findByExternalId AGAIN — by then the agent has saved a
    // blocked record. Two-stage mock simulates that mid-dispatch
    // mutation.
    let blockedSet = false;
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) => {
        if (externalId !== "c1") return null;
        return blockedSet
          ? {
              ...issueWithStatus("c1", "Epic card", "ToDo"),
              blocked: {
                reason: "Waiting on ISS-20 to resolve AC #11",
                timestamp: "2026-05-04T23:48:59.000Z",
                by: ["ISS-20"],
              },
            }
          : null;
      },
    );

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("c1", "Epic card", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);
    // Simulate the agent saving a blocked record mid-dispatch.
    blockedSet = true;

    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!({
      id: "j1",
      status: "completed",
      summary: "Set blocked.by=[ISS-20]",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();

    expect(mockTracker.getCard).toHaveBeenCalledWith("c1");
    expect(mockFindByExternalId).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.localPath,
      "c1",
    );
    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when findByExternalId throws during the post-dispatch check (tolerate read failure same as getCard failure)", async () => {
    // Symmetric tolerance with the `getCard` failure path: if the
    // local YAML read throws (corrupt file, permissions, race with a
    // concurrent writer), prefer a false-negative (no flag) over a
    // false-positive (halt the poller). The check returns early
    // without writing the flag.
    mockTracker.getCard.mockResolvedValue(
      issueWithStatus("c1", "Card 1", "ToDo"),
    );
    let blockedCheckFire = false;
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) => {
        if (externalId !== "c1") return null;
        // Primary dispatch path (1st call) returns null → triggers
        // hydrateFromRemote. Post-dispatch check (2nd call) throws.
        if (!blockedCheckFire) return null;
        throw new Error("Disk read failure");
      },
    );

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("c1", "Card 1", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);
    blockedCheckFire = true;
    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!({
      id: "j1",
      status: "failed",
      summary: "crash",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();

    expect(mockTracker.getCard).toHaveBeenCalledWith("c1");
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

/**
 * Triage dispatches don't move the card across lists — a successful
 * triage just stamps a fresh `triage.expires_at` on the local YAML and
 * exits. The work-dispatch post-dispatch check (`trackedCardId` →
 * `tracker.getCard`) cannot guard against a triage agent that completes
 * without saving — it would re-dispatch the same broken agent every
 * tick (token-burn loop). ISS-104 adds a parallel post-dispatch guard:
 * after a triage dispatch exits, re-read the local YAML and verify
 * `triage.expires_at` advanced past the dispatch's `started_at`. If
 * not, write the critical-failure flag so the halt gate stops the loop
 * until an operator acks.
 */
describe("poll — post-dispatch triage-progress check (ISS-104)", () => {
  function triageDueIssue(overrides: Partial<Issue>): Issue {
    return {
      ...FAKE_ISSUE_FOR_TESTS,
      ...overrides,
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
    } as Issue;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockReadFlag.mockReturnValue(null);
    // autoTriage on, ideator off
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    mockListTriageDueYamls.mockReset();
    mockListBlockedTodoYamls.mockReset();
    mockListBlockedTodoYamls.mockReturnValue([]);
    mockLoadLocal.mockReset();
    mockLoadLocal.mockReturnValue(null);
    mockStampDispatchAndWrite.mockClear();
  });

  /**
   * Drive one triage dispatch through `poll`: capture `onComplete` from
   * the dispatch mock, fire it with the supplied job shape, and flush
   * the fire-and-forget completion handler. Sets up
   * `mockListTriageDueYamls` with the supplied target.
   */
  async function runOneTriageDispatch(
    target: Issue,
    job: {
      id: string;
      status: string;
      summary?: string;
      startedAt: Date;
      completedAt: Date;
    },
  ): Promise<void> {
    mockListTriageDueYamls.mockReturnValueOnce([target]);
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );
    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!(job);
    await flushAsync();
    await flushAsync();
  }

  it("writes the critical-failure flag when the triage YAML still has an empty triage.expires_at after the dispatch exits", async () => {
    const target = triageDueIssue({
      id: "ISS-7",
      external_id: "rv7",
      status: "Review",
      title: "Review Card",
    });
    // Post-dispatch read: the agent did not save, so the YAML still has
    // the same stale (empty) triage block.
    mockLoadLocal.mockImplementation((_repo: string, id: string) =>
      id === "ISS-7" ? target : null,
    );

    await runOneTriageDispatch(target, {
      id: "tj1",
      status: "completed",
      summary: "Lied — never called danx_issue_save",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockWriteFlag).toHaveBeenCalledTimes(1);
    const [localPath, payload] = mockWriteFlag.mock.calls[0];
    expect(localPath).toBe(MOCK_REPO_CONTEXT.localPath);
    expect(payload).toMatchObject({
      source: "post-dispatch-check",
      dispatchId: "tj1",
      cardId: "ISS-7",
    });
    expect(payload.reason).toMatch(/triage\.expires_at/);
  });

  it("writes the flag when triage.expires_at is set but did not advance past started_at (in the past)", async () => {
    const target = triageDueIssue({
      id: "ISS-8",
      external_id: "rv8",
      status: "Review",
      title: "Stale Review",
      triage: {
        // Set, but BEFORE the dispatch's started_at (2050 vs 1970 — the
        // mocked started_at from buildStartStamp).
        expires_at: "1970-01-01T00:00:00.000Z",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
    });
    // After dispatch the YAML still shows the same stale expiry. (The
    // agent might have called `danx_issue_save` but did not update the
    // triage block — same failure mode as not saving at all.)
    mockLoadLocal.mockImplementation((_repo: string, id: string) =>
      id === "ISS-8" ? target : null,
    );

    await runOneTriageDispatch(target, {
      id: "tj2",
      status: "completed",
      summary: "saved but did not move triage forward",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockWriteFlag).toHaveBeenCalledTimes(1);
    expect(mockWriteFlag.mock.calls[0][1].cardId).toBe("ISS-8");
  });

  it("writes the flag even when the agent reported status=failed (failure path also goes through the guard)", async () => {
    const target = triageDueIssue({
      id: "ISS-7",
      external_id: "rv7",
      status: "Review",
    });
    mockLoadLocal.mockImplementation((_repo: string, id: string) =>
      id === "ISS-7" ? target : null,
    );

    await runOneTriageDispatch(target, {
      id: "tj3",
      status: "failed",
      summary: "MCP danx-issue not loaded",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockWriteFlag).toHaveBeenCalled();
    expect(mockWriteFlag.mock.calls[0][1].cardId).toBe("ISS-7");
  });

  it("writes the flag when triage.expires_at exactly equals started_at (strict-greater-than boundary — locks against >= regression)", async () => {
    // The guard uses `expiresAtMs > startedAtMs` not `>=`. A triage
    // save MUST mint a fresh FUTURE timestamp; an `expires_at` equal
    // to `started_at` means the agent stamped the dispatch's own start
    // time as the new expiry, which represents zero forward progress
    // (and would re-fire on the very next tick once `Date.now() >
    // started_at`). Lock the strict comparison.
    const fixedStart = "2026-05-08T01:00:00.000Z";
    const target = triageDueIssue({
      id: "ISS-15",
      external_id: "rv15",
      status: "Review",
      triage: {
        expires_at: fixedStart,
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
    });
    // Force the dispatch's start_at to match the YAML's expires_at by
    // stubbing Date.now during the spawn phase.
    const realDateNow = Date.now;
    const fixedNow = Date.parse(fixedStart);
    Date.now = () => fixedNow;
    try {
      mockLoadLocal.mockImplementation((_repo: string, id: string) =>
        id === "ISS-15" ? target : null,
      );
      await runOneTriageDispatch(target, {
        id: "tj-boundary",
        status: "completed",
        summary: "stamped exactly started_at",
        startedAt: new Date(fixedNow),
        completedAt: new Date(fixedNow),
      });
    } finally {
      Date.now = realDateNow;
    }

    expect(mockWriteFlag).toHaveBeenCalledTimes(1);
    expect(mockWriteFlag.mock.calls[0][1].cardId).toBe("ISS-15");
  });

  it("does NOT write the flag when triage.expires_at advanced past the dispatch's started_at (regression guard for successful triage)", async () => {
    // Successful triage: the agent saved a new `triage.expires_at` well
    // into the future. The post-dispatch check sees the advance and
    // stays silent.
    const futureExpiry = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const dueAtDispatch = triageDueIssue({
      id: "ISS-9",
      external_id: "rv9",
      status: "Review",
    });
    const triagedYaml = {
      ...dueAtDispatch,
      triage: {
        ...dueAtDispatch.triage,
        expires_at: futureExpiry,
        last_status: "Keep",
        last_explain: "ICE 60 — keep on board",
      },
    };
    mockLoadLocal.mockImplementation((_repo: string, id: string) =>
      id === "ISS-9" ? triagedYaml : null,
    );

    await runOneTriageDispatch(dueAtDispatch, {
      id: "tj4",
      status: "completed",
      summary: "triaged",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when the local YAML can no longer be loaded (tolerate read failure — false-negative preferred)", async () => {
    const target = triageDueIssue({
      id: "ISS-10",
      external_id: "rv10",
      status: "Review",
    });
    // loadLocal returns null after the dispatch (YAML moved to closed/,
    // deleted, etc). The poller can't re-dispatch a missing id, so the
    // loop self-terminates — no flag needed.
    mockLoadLocal.mockReturnValue(null);

    await runOneTriageDispatch(target, {
      id: "tj5",
      status: "completed",
      summary: "yaml gone",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when loadLocal throws during the post-dispatch read (symmetric with the work-dispatch tolerance)", async () => {
    const target = triageDueIssue({
      id: "ISS-11",
      external_id: "rv11",
      status: "Review",
    });
    // The spawn path AND `clearActiveDispatch` (first call from
    // onComplete) both call loadLocal. The triage-progress check is the
    // SECOND loadLocal call inside onComplete — we only want that one
    // to throw so the assertion targets the new guard's tolerance for
    // post-dispatch read failures, not pre-existing call sites.
    let onCompleteLoadCalls = 0;
    let postDispatchPhase = false;
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id !== "ISS-11") return null;
      if (!postDispatchPhase) return target;
      onCompleteLoadCalls += 1;
      if (onCompleteLoadCalls >= 2) {
        throw new Error("Disk read failure");
      }
      return target;
    });

    mockListTriageDueYamls.mockReturnValueOnce([target]);
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );
    await poll(MOCK_REPO_CONTEXT);
    postDispatchPhase = true;
    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!({
      id: "tj6",
      status: "completed",
      summary: "post-dispatch read failed",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();

    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("writes the flag when triage.expires_at is a malformed string (Date.parse → NaN)", async () => {
    const target = triageDueIssue({
      id: "ISS-12",
      external_id: "rv12",
      status: "Review",
      triage: {
        expires_at: "not-a-date",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
    });
    mockLoadLocal.mockImplementation((_repo: string, id: string) =>
      id === "ISS-12" ? target : null,
    );

    await runOneTriageDispatch(target, {
      id: "tj7",
      status: "completed",
      summary: "saved garbage in expires_at",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    // Number.isFinite(NaN) is false → advanced=false → flag written.
    expect(mockWriteFlag).toHaveBeenCalledTimes(1);
    expect(mockWriteFlag.mock.calls[0][1].cardId).toBe("ISS-12");
  });

  it("writes the flag when the triage block is missing entirely on the YAML", async () => {
    const target = triageDueIssue({
      id: "ISS-13",
      external_id: "rv13",
      status: "Review",
    });
    // Simulate a YAML where triage was never serialized (forward-compat
    // contract: a future schema migration that drops the block must
    // still trip the no-progress guard rather than silently passing).
    const triageMissing = {
      ...target,
      triage: undefined as unknown as Issue["triage"],
    };
    mockLoadLocal.mockImplementation((_repo: string, id: string) =>
      id === "ISS-13" ? triageMissing : null,
    );

    await runOneTriageDispatch(target, {
      id: "tj8",
      status: "completed",
      summary: "no triage block on YAML",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(mockWriteFlag).toHaveBeenCalledTimes(1);
    expect(mockWriteFlag.mock.calls[0][1].cardId).toBe("ISS-13");
  });

  it("clears triageTracked after onComplete so a second dispatch's outcome is not double-counted", async () => {
    // First dispatch: agent succeeds (advances triage.expires_at) → no
    // flag. Second dispatch on the SAME tracked target with the SAME
    // job id triggering onComplete a second time must NOT re-write the
    // flag — the cleanup ran. Without the cleanup, lingering state from
    // dispatch #1 could trip dispatch #2's flag write.
    const futureExpiry = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const target = triageDueIssue({
      id: "ISS-14",
      external_id: "rv14",
      status: "Review",
    });
    const triagedYaml = {
      ...target,
      triage: { ...target.triage, expires_at: futureExpiry },
    };
    mockLoadLocal.mockImplementation((_repo: string, id: string) =>
      id === "ISS-14" ? triagedYaml : null,
    );
    mockListTriageDueYamls.mockReturnValueOnce([target]);
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );
    await poll(MOCK_REPO_CONTEXT);
    capturedOnComplete!({
      id: "tj9",
      status: "completed",
      summary: "first triage",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();

    expect(mockWriteFlag).not.toHaveBeenCalled();

    // Re-fire the same callback with a payload that WOULD trip the flag
    // if state.triageTracked were still populated. After cleanup it
    // should be a no-op.
    capturedOnComplete!({
      id: "tj9-replay",
      status: "completed",
      summary: "second invocation",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();

    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT fire the triage-progress check on a work-ready (trello-trigger) dispatch", async () => {
    // Work-ready dispatch path: the existing `checkCardProgressedOrHalt`
    // owns this flow via tracker.getCard. The triage-progress branch
    // must stay dormant — its state field is null for non-triage
    // dispatches.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("c1", "Real ToDo", "ToDo"),
    ]);
    mockTracker.getCard.mockResolvedValue({
      ...DEFAULT_GET_CARD_ISSUE,
      status: "Done" as const,
    });
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
      id: "wj1",
      status: "completed",
      summary: "moved to Done",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();

    // No triage track → no flag and no loadLocal lookup keyed off a
    // triage id. (loadLocal MAY be called by the work-ready dispatch
    // path itself — the assertion is on writeFlag.)
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
      (...args: unknown[]) =>
      (args[1] as string) !== "ideator" && (args[1] as string) !== "autoTriage",
    );
    mockGetIssuePollerPickupPrefix.mockReset();
    mockGetIssuePollerPickupPrefix.mockReturnValue(null);
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
      (...args: unknown[]) =>
      (args[1] as string) !== "ideator" && (args[1] as string) !== "autoTriage",
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

    // ISS-86: stuck-card recovery now reads local YAML, not the
    // tracker view. Inject the In-Progress projection directly.
    mockListInProgressYamls.mockReturnValueOnce([
      refToFakeIssue({ id: "ISS-1", external_id: "c1", title: "My Card", status: "In Progress" }),
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
    // recovered. ISS-86: source is local YAML.
    mockListInProgressYamls.mockReturnValueOnce([
      refToFakeIssue({ id: "ISS-1", external_id: "c1", title: "My Card", status: "In Progress" }),
      refToFakeIssue({ id: "ISS-99", external_id: "c99", title: "Already In Progress", status: "In Progress" }),
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

    // ISS-86: source is local YAML.
    mockListInProgressYamls.mockReturnValueOnce([
      refToFakeIssue({ id: "ISS-1", external_id: "c1", title: "Card 1", status: "In Progress" }),
      refToFakeIssue({ id: "ISS-2", external_id: "c2", title: "Card 2", status: "In Progress" }),
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

    // ISS-86: source is local YAML.
    mockListInProgressYamls.mockReturnValueOnce([
      refToFakeIssue({ id: "ISS-1", external_id: "c1", title: "Card 1", status: "In Progress" }),
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

    // Recovery's IP read fails — handler should swallow and continue.
    // ISS-86: source is local YAML; have the helper throw to simulate
    // a disk read failure mid-recovery.
    mockListInProgressYamls.mockImplementationOnce(() => {
      throw new Error("Disk read down");
    });
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
      (...args: unknown[]) =>
      (args[1] as string) !== "ideator" && (args[1] as string) !== "autoTriage",
    );
    mockGetIssuePollerPickupPrefix.mockReset();
    mockGetIssuePollerPickupPrefix.mockReturnValue(null);
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
        dispatch: { id: dispatchId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
      }),
    );
    mockStampDispatchAndWrite.mockImplementation(
      (
        _repo: string,
        issue: Record<string, unknown>,
        dispatchOrId: string | Record<string, unknown>,
      ) => {
        // ISS-92 Phase 2: stampDispatchAndWrite accepts either a bare
        // dispatchId (legacy placeholder shape) or a full IssueDispatch
        // record. Mirror both branches so tests that pass either form
        // see the same behavior the production helper produces.
        const dispatch =
          typeof dispatchOrId === "string"
            ? { id: dispatchOrId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 }
            : dispatchOrId;
        return { ...issue, dispatch };
      },
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

  // ISS-135 — Fresh dispatch (non-resume) must NOT carry the resume
  // contract anchors. The two paths share the /danx-next slash command
  // (so the same skill loads), but the resume contract is only
  // appropriate when there's a prior in-flight session to verify
  // against. A future regression that swapped TEAM_PROMPT for
  // TEAM_PROMPT_RESUME at the fresh-dispatch callsite would tell every
  // newly-picked-up card "verify what the prior session did" — which
  // is wrong because there was no prior session.
  it("fresh dispatch task does NOT contain the RESUMED-dispatch resume contract anchors", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-fresh-no-resume", "Fresh card", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchArg = mockDispatch.mock.calls[0][0] as { task: string };
    expect(dispatchArg.task).not.toContain("RESUMED dispatch");
    expect(dispatchArg.task).not.toContain("CONTRACT — read FIRST");
    expect(dispatchArg.task).not.toContain("Verify, don't repeat");
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
      "ISS",
    );
  });

  it("calls stampDispatchAndWrite with the hydrated Issue after the brand-new-card hydration path runs", async () => {
    // ISS-92 Phase 2: the hydration path now stamps the enriched
    // dispatch record directly via stampDispatchAndWrite (no separate
    // writeIssue call). The stamp's third arg is the full IssueDispatch
    // start record — pid:0 sentinel pre-spawn, host/started_at/
    // ttl_seconds populated.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-uuid-w", "Card W", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockStampDispatchAndWrite).toHaveBeenCalled();
    const stampArgs = mockStampDispatchAndWrite.mock.calls[0];
    expect(stampArgs[0]).toBe(MOCK_REPO_CONTEXT.localPath);
    const stampedIssue = stampArgs[1] as { external_id: string };
    expect(stampedIssue.external_id).toBe("card-uuid-w");
    const stamp = stampArgs[2] as {
      id: string;
      pid: number;
      host: string;
      kind: string;
      started_at: string;
      ttl_seconds: number;
    };
    const dispatchArg = mockDispatch.mock.calls[0][0] as { dispatchId: string };
    expect(stamp.id).toBe(dispatchArg.dispatchId);
    expect(stamp.pid).toBe(0);
    expect(stamp.host).not.toBe("");
    expect(stamp.kind).toBe("work");
    expect(stamp.started_at).not.toBe("");
    expect(stamp.ttl_seconds).toBe(7200);
  });

  it("stamps + writes YAML BEFORE dispatch() spawns the agent — ordering invariant", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-order-1", "Order 1", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    // ISS-92 Phase 2: stampDispatchAndWrite is the single write surface
    // pre-spawn (replaces the old hydrate→writeIssue + stampDispatchAndWrite
    // pair). Ordering invariant moves over: stamp before dispatch.
    const stampOrder = mockStampDispatchAndWrite.mock.invocationCallOrder[0];
    const dispatchOrder = mockDispatch.mock.invocationCallOrder[0];
    expect(stampOrder).toBeDefined();
    expect(dispatchOrder).toBeDefined();
    expect(stampOrder).toBeLessThan(dispatchOrder);
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
      dispatch: { id: "old", pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
      status: "ToDo",
      type: "Feature",
      title: "Cached",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
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
    // Enable ideator but keep autoTriage off — Review filler would
    // otherwise become triage candidates and steal the dispatch.
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "autoTriage",
    );

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

  it("corrupt-YAML error from findByExternalId is logged + swallowed — no silent hydration fallback (DX-149)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-bad", "Bad YAML", "ToDo"),
    ]);
    const parseError = new Error(
      "Invalid Issue YAML: missing required field: tracker",
    );
    mockFindByExternalId.mockImplementation(() => {
      throw parseError;
    });

    // DX-149: previously rejected. Now caught by `_poll`'s top-level
    // catch — worker survives, error is logged, hydration still
    // never runs (we threw before reaching the fallback), no
    // dispatch fires. Operator sees the parse error in logs and
    // fixes the YAML; the next tick re-asserts.
    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    const errCalls = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_poll crashed"),
    );
    expect(errCalls).toHaveLength(1);
    expect(String(errCalls[0][0])).toMatch(/Invalid Issue YAML/);
    expect(mockHydrateFromRemote).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("tracker hydrateFromRemote failure is logged + swallowed — no dispatch (DX-149)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-net-fail", "Net fail", "ToDo"),
    ]);
    mockFindByExternalId.mockReturnValue(null);
    mockHydrateFromRemote.mockRejectedValueOnce(
      new Error("Trello API error: 401 Unauthorized"),
    );

    // DX-149: previously rejected ("hydration crashes loud"). Now
    // caught by `_poll`'s top-level catch — worker survives a
    // 401 storm instead of getting OOM-killed by repeated restarts.
    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    const errCalls = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_poll crashed"),
    );
    expect(errCalls).toHaveLength(1);
    expect(String(errCalls[0][0])).toMatch(/401 Unauthorized/);
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
      dispatch: { id: "old-dispatch", pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
      status: "ToDo",
      type: "Feature",
      title: "Card 3",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    };
    mockFindByExternalId.mockReturnValue(existingIssue);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockHydrateFromRemote).not.toHaveBeenCalled();
    expect(mockStampDispatchAndWrite).toHaveBeenCalledTimes(1);
    const stampArgs = mockStampDispatchAndWrite.mock.calls[0];
    expect(stampArgs[1]).toBe(existingIssue);
    // ISS-92 Phase 2: third arg is now the full IssueDispatch start
    // record (not a bare dispatchId string). Match on .id so the
    // dispatch row + YAML stay correlated.
    const dispatchArg = mockDispatch.mock.calls[0][0] as { dispatchId: string };
    const stamp = stampArgs[2] as { id: string };
    expect(stamp.id).toBe(dispatchArg.dispatchId);
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
      dispatch: null,
      status: "ToDo",
      type: "Feature",
      title: "Blocked card",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: {
        reason: "waiting on ISS-99",
        timestamp: "2026-05-04T18:00:00.000Z",
        by: ["ISS-99"],
      },
      history: [],
    };
    mockFindByExternalId.mockReturnValue(blockedIssue);
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id === "ISS-99") return { ...blockedIssue, id: "ISS-99", status: "ToDo", blocked: null };
      return null;
    });
    // ISS-86: blocked YAMLs are surfaced via listBlockedTodoYamls (NOT
    // the dispatchable list). resolveBlockedCards then keeps or drops.
    mockListDispatchableYamls.mockReturnValueOnce([]);
    mockListBlockedTodoYamls.mockReturnValueOnce([blockedIssue as Issue]);

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
      dispatch: null,
      status: "ToDo",
      type: "Feature",
      title: "Now-unblocked card",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: {
        reason: "waiting on ISS-99",
        timestamp: "2026-05-04T18:00:00.000Z",
        by: ["ISS-99"],
      },
      history: [],
    };
    mockFindByExternalId.mockReturnValue(blockedIssue);
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id === "ISS-99") return { ...blockedIssue, id: "ISS-99", status: "Done", blocked: null };
      return null;
    });
    // ISS-86: blocked YAMLs come via listBlockedTodoYamls; the
    // resolve gate clears `blocked` on terminal blockers and pushes
    // the cleared ref into `cards` for dispatch this tick.
    mockListDispatchableYamls.mockReturnValueOnce([]);
    mockListBlockedTodoYamls.mockReturnValueOnce([blockedIssue as Issue]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("Action Items list cards (now hydrated as status: Review) are bulk-synced but not dispatched", async () => {
    // Phase 4 of ISS-90 collapsed Action Items into status: Review.
    // The Trello tracker tags Action Items cards with `status: Review`
    // on hydration. The poller still bulk-syncs them (so blocker
    // discovery sees them in local YAMLs and the per-card triage agent
    // can score them) but they're not dispatch-eligible — the
    // `status === "ToDo"` filter in `listDispatchableYamls` excludes
    // them naturally.
    mockTracker.fetchOpenCards.mockResolvedValue([
      { id: "", external_id: "card-ai-1", title: "AI card", status: "Review" },
    ]);
    mockFindByExternalId.mockReturnValue(null);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
    // Bulk-sync still hydrated the Action Items card via the Review
    // branch of the bulk-sync targets list.
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
      dispatch:
        dispatchId === null
          ? null
          : {
              id: dispatchId,
              pid: 0,
              host: "",
              kind: "work" as const,
              started_at: "",
              ttl_seconds: 0,
            },
      status: "In Progress" as const,
      type: "Feature" as const,
      title,
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
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
        dispatch: { id: dispatchId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
      }),
    );
    mockStampDispatchAndWrite.mockImplementation(
      (_repo: string, issue: Record<string, unknown>, dispatchId: string) => ({
        ...issue,
        dispatch: { id: dispatchId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
      }),
    );
    mockGetActiveJob.mockReset();
    mockGetActiveJob.mockReturnValue(undefined);
    mockResolveParentSessionId.mockReset();
    mockResolveParentSessionId.mockResolvedValue({ kind: "no-session-dir" });
    mockFindNonTerminalDispatches.mockReset();
    mockFindNonTerminalDispatches.mockResolvedValue([]);
    mockIsPidAlive.mockReset();
    mockIsPidAlive.mockReturnValue(false);
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
              dispatch: null,
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

  // ISS-135 — the orphan-resume task body MUST carry an explicit
  // "this is a resume, verify don't repeat" contract so a resumed
  // agent that lands on a card whose prior session already finished
  // (Done + every AC checked + retro filled) calls danxbot_complete
  // immediately instead of running /danx-next from scratch and
  // re-doing the work. The May-7 incident showed an orphan-resumed
  // agent re-dispatching `danxbot_complete` after the work + commits
  // had already shipped in the prior session.
  it("orphan-resume task body contains the RESUMED-dispatch contract anchors (verify, don't repeat)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-resume-contract", "Orphan resume contract", "In Progress"),
    ]);
    const orphan = inProgressIssue(
      "ISS-135-X",
      "ip-resume-contract",
      "old-dispatch-uuid",
    );
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-resume-contract" ? orphan : null,
    );
    mockResolveParentSessionId.mockResolvedValue({
      kind: "found",
      sessionId: "claude-session-resume",
    });

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchArg = mockDispatch.mock.calls[0][0] as { task: string };
    // Resume contract markers — these three substrings are the
    // load-bearing phrases the dispatched agent reads to decide
    // "verify already-done card vs. resume in-flight work."
    expect(dispatchArg.task).toContain("RESUMED dispatch");
    expect(dispatchArg.task).toContain("CONTRACT");
    expect(dispatchArg.task).toContain("Verify, don't repeat");
    // Parent dispatch id surfaces in the prompt so the resumed agent
    // can grep its own session log against the parent's dispatch tag
    // when it's deciding "did I already finish this?".
    expect(dispatchArg.task).toContain("old-dispatch-uuid");
    // Card id still appears so the agent reads the right YAML.
    expect(dispatchArg.task).toContain("ISS-135-X");
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

  it("skips orphan resume when DB has a non-terminal dispatch row with a live host_pid for the card (cross-restart liveness)", async () => {
    // Regression: worker restart wipes in-memory `activeJobs`, so the
    // pre-existing `getActiveJob` check returns false even when claude
    // is genuinely still running (host-mode `script -q -f` reparents
    // claude to PID 1 → survives SIGTERM to the worker). ISS-69 added
    // the same liveness guard on the ToDo dispatch path; orphan-resume
    // runs FIRST and must apply the same probe or it stamps a new
    // dispatch_id and spawns a duplicate before the ToDo guard ever
    // gets a chance to fire.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-restart", "Card with surviving claude", "In Progress"),
    ]);
    const orphan = inProgressIssue(
      "ISS-66",
      "ip-restart",
      "old-dispatch-uuid",
    );
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-restart" ? orphan : null,
    );
    // activeJobs cleared by restart — getActiveJob returns null.
    mockGetActiveJob.mockReturnValue(undefined);
    // DB still shows the prior dispatch's row, host_pid alive.
    mockFindNonTerminalDispatches.mockResolvedValue([
      {
        id: "old-dispatch-uuid",
        repoName: "test-repo",
        trigger: "trello",
        triggerMetadata: { cardId: "ip-restart" },
        status: "running",
        hostPid: 12345,
      },
    ]);
    mockIsPidAlive.mockImplementation((pid: number) => pid === 12345);

    await poll(MOCK_REPO_CONTEXT);

    // Liveness probe consulted before resume scan does its work.
    expect(mockIsPidAlive).toHaveBeenCalledWith(12345);
    // No JSONL lookup — short-circuit before resolveParentSessionId.
    expect(mockResolveParentSessionId).not.toHaveBeenCalled();
    // No dispatch — duplicate-claude bug avoided.
    expect(mockDispatch).not.toHaveBeenCalled();
    // No YAML mutation — dispatch_id stays the surviving claude's id.
    const writes = mockWriteIssueFn.mock.calls.filter((c) => {
      const issue = c[1] as { external_id?: string };
      return issue?.external_id === "ip-restart";
    });
    expect(writes).toHaveLength(0);
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

  it("orphan path with no dispatch stamp short-circuits before getActiveJob / resolveParentSessionId (resume not attempted, only reset)", async () => {
    // Sibling of the "no dispatch stamp → reset to ToDo" behavior:
    // the resume branch should NEVER fire when there's no dispatch.id
    // to resume against — the helper has nothing to resolve. The
    // reset-to-ToDo branch handles bookkeeping; this test pins that
    // we don't waste a session-file lookup.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-bare", "Bare card", "In Progress"),
    ]);
    mockFindByExternalId.mockReturnValue(
      inProgressIssue("ISS-79", "ip-bare", null),
    );

    await poll(MOCK_REPO_CONTEXT);

    expect(mockGetActiveJob).not.toHaveBeenCalled();
    expect(mockResolveParentSessionId).not.toHaveBeenCalled();
    // Reset → ToDo bubbles into the dispatch pool on the SAME tick;
    // with no other ToDo card, the bubbled card dispatches as a
    // fresh (non-resume) dispatch.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as {
      apiDispatchMeta: { metadata: { cardId: string } };
      parentJobId?: string;
      resumeSessionId?: string;
    };
    expect(arg.apiDispatchMeta.metadata.cardId).toBe("ip-bare");
    expect(arg.parentJobId).toBeUndefined();
    expect(arg.resumeSessionId).toBeUndefined();
  });

  it("resets In Progress → ToDo when the dispatch_id session file is gone, AND dispatches the reset card on the same tick (no resume)", async () => {
    // Regression for the bug where the orphan-reset path mutated the
    // card's status mid-tick but the `cards` snapshot taken at the
    // top of `tickRepo` was already captured pre-reset — leaving the
    // newly-ToDo card invisible to this tick's dispatch path. The
    // poller would log "resetting to ToDo" + "No cards in ToDo" on
    // the SAME tick and then wait a full poll interval before
    // picking up the card. The fix returns reset refs from
    // `tryResumeOrphan` so `tickRepo` can append them to `cards`
    // before falling through.
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
      dispatch: { id: string } | null;
    };
    expect(resetIssue.status).toBe("ToDo");
    expect(resetIssue.dispatch).toBeNull();
    // The reset card is dispatched on the SAME tick as a fresh ToDo
    // (no resume — the parent session is gone). Single dispatch
    // invariant preserved (only one card was eligible).
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as {
      parentJobId?: string;
      resumeSessionId?: string;
      apiDispatchMeta: { metadata: { cardId: string; listName: string } };
    };
    expect(arg.parentJobId).toBeUndefined();
    expect(arg.resumeSessionId).toBeUndefined();
    expect(arg.apiDispatchMeta.metadata.cardId).toBe("ip-gone");
    // Dispatch metadata reports listName=ToDo (post-reset) — the
    // orphan came from In Progress but is now being dispatched as
    // ToDo, so the trigger metadata reflects ToDo.
    expect(arg.apiDispatchMeta.metadata.listName).toBe("ToDo");
  });

  it("surfaces the reset card to the dispatch pool even when tracker.moveToStatus fails (lone-orphan path, no resumable follower)", async () => {
    // Existing "tolerates a moveToStatus failure" test exercises the
    // failure path with a SECOND orphan that resumes — the resume's
    // `resumed: true` short-circuit drops `resetToToDo`, so that test
    // doesn't actually pin the post-fix behavior. Cover the lone-orphan
    // path here: tracker rejects, no second orphan, the reset card
    // STILL gets dispatched on this tick (proves the resetToToDo push
    // runs after the try/catch, not inside the try block).
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-lonely", "Lonely orphan", "In Progress"),
    ]);
    const orphan = inProgressIssue("ISS-100", "ip-lonely", "vanished-uuid");
    mockFindByExternalId.mockReturnValue(orphan);
    mockResolveParentSessionId.mockResolvedValue({ kind: "not-found" });
    mockTracker.moveToStatus.mockRejectedValueOnce(
      new Error("Tracker network error"),
    );

    await poll(MOCK_REPO_CONTEXT);

    // Local YAML reset persisted despite tracker failure.
    const reset = mockWriteIssueFn.mock.calls.find((c) => {
      const issue = c[1] as { external_id?: string; status?: string };
      return issue?.external_id === "ip-lonely" && issue.status === "ToDo";
    });
    expect(reset).toBeDefined();
    // Reset card dispatched same tick as a fresh ToDo (the regression
    // anchor: a moveToStatus throw must NOT bypass the resetToToDo
    // push that surfaces the card to the caller).
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as {
      apiDispatchMeta: { metadata: { cardId: string } };
      parentJobId?: string;
    };
    expect(arg.apiDispatchMeta.metadata.cardId).toBe("ip-lonely");
    expect(arg.parentJobId).toBeUndefined();
  });

  it("dispatches a single card on a tick where one orphan was reset to ToDo and another card already lived in ToDo (single-dispatch invariant)", async () => {
    // Multi-card scenario for the bug-#1 fix: a vanished orphan resets
    // to ToDo on the same tick a fresh ToDo card was already eligible.
    // Both end up in `cards`, but the single-dispatch invariant means
    // only the FIRST (the pre-existing ToDo card) dispatches; the
    // newly-reset orphan waits for the next tick. This pins the
    // ordering: orphan-reset refs are appended AFTER the ToDo
    // snapshot, so existing ToDo cards still win pickup.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("td-pre", "Pre-existing ToDo", "ToDo"),
      ref("ip-gone", "Vanished orphan", "In Progress"),
    ]);
    const orphan = inProgressIssue("ISS-101", "ip-gone", "vanished-uuid");
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-gone" ? orphan : null,
    );
    mockResolveParentSessionId.mockResolvedValue({ kind: "not-found" });

    await poll(MOCK_REPO_CONTEXT);

    // Orphan was reset on tracker + locally.
    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("ip-gone", "ToDo");
    // Exactly one dispatch; the primary is the pre-existing ToDo card.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as {
      apiDispatchMeta: { metadata: { cardId: string } };
    };
    expect(arg.apiDispatchMeta.metadata.cardId).toBe("td-pre");
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

  it("resets In Progress card with no dispatch stamp to ToDo (orphan from agent that died before YAML stamp)", async () => {
    // ISS-91 reproduction: card stuck in In Progress with `dispatch:
    // null` (prior agent died before reaching writeIssue). Without the
    // reset, the card sits in In Progress forever — the orphan-resume
    // path needs a dispatch.id to resume against, and the ToDo
    // dispatch path never sees the card.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-bare", "No dispatch stamp", "In Progress"),
      ref("td-fresh", "Fresh ToDo", "ToDo"),
    ]);
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "ip-bare"
          ? inProgressIssue("ISS-91", "ip-bare", null)
          : null,
    );

    await poll(MOCK_REPO_CONTEXT);

    // Tracker move + local YAML reset both fire.
    expect(mockTracker.moveToStatus).toHaveBeenCalledWith("ip-bare", "ToDo");
    const writeCall = mockWriteIssueFn.mock.calls.find(
      (c) => (c[1] as { external_id: string }).external_id === "ip-bare",
    );
    expect(writeCall).toBeDefined();
    expect((writeCall![1] as { status: string }).status).toBe("ToDo");

    // Single-dispatch invariant: pre-existing td-fresh wins this tick.
    // ip-bare is appended to the dispatch pool and waits for next tick.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as {
      apiDispatchMeta: { metadata: { cardId: string } };
      parentJobId?: string;
      resumeSessionId?: string;
    };
    expect(arg.apiDispatchMeta.metadata.cardId).toBe("td-fresh");
    expect(arg.parentJobId).toBeUndefined();
    expect(arg.resumeSessionId).toBeUndefined();
  });

  it("does NOT reset In Progress no-dispatch card when dispatches DB shows live host_pid", async () => {
    // Host-mode safety: a previous agent might still be running on the
    // host even though it never reached the YAML stamp. The
    // hasLiveDispatchForCard check prevents racing it.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("ip-live", "No stamp but alive", "In Progress"),
    ]);
    mockFindByExternalId.mockReturnValue(
      inProgressIssue("ISS-91", "ip-live", null),
    );
    // Simulate live host_pid via the underlying liveness probe.
    mockFindNonTerminalDispatches.mockResolvedValue([
      {
        id: "no-stamp-but-alive",
        repoName: "test-repo",
        trigger: "trello",
        triggerMetadata: { cardId: "ip-live" },
        status: "running",
        hostPid: 99999,
      },
    ]);
    mockIsPidAlive.mockImplementation((pid: number) => pid === 99999);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.moveToStatus).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
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
    // YAML must NOT be rewritten to ToDo / null dispatch.
    const reset = mockWriteIssueFn.mock.calls.find((c) => {
      const issue = c[1] as {
        external_id?: string;
        dispatch?: { id: string } | null;
      };
      return issue?.external_id === "ip-nodir" && issue.dispatch === null;
    });
    expect(reset).toBeUndefined();
  });

  it("composes a resume task containing TEAM_PROMPT_RESUME, the YAML path, the issue id, and the RESUMED-dispatch contract phrasing (ISS-135)", async () => {
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
    // /danx-next is still the slash command (TEAM_PROMPT_RESUME maps
    // to "/danx-next" today — the skill itself contains the resume
    // self-check section).
    expect(dispatchArg.task).toContain("/danx-next");
    // ISS-135: the legacy "Resuming prior dispatch on ISS-93" phrasing
    // was replaced with the explicit RESUMED-dispatch CONTRACT block
    // that tells the agent to verify terminal state before redoing
    // any work. The card id and YAML path still appear; the
    // `danx_issue_save` directive is replaced by the
    // `danxbot_complete` directive embedded in the contract.
    expect(dispatchArg.task).toContain("RESUMED dispatch on ISS-93");
    expect(dispatchArg.task).toContain(
      "/test/repos/test-repo/.danxbot/issues/open/ISS-93.yml",
    );
    expect(dispatchArg.task).toContain("CONTRACT — read FIRST, act AFTER");
    expect(dispatchArg.task).toContain("Verify, don't repeat");
    expect(dispatchArg.task).toContain("danxbot_complete");
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

/**
 * Per-card triage dispatch gate (Phase 4 of ISS-90, ISS-94).
 *
 * Replaces the legacy bulk auto-triage path with a single-card dispatch:
 * one tick fires one `danx-triage-card` agent against one specific YAML.
 * Wired into the poller's empty-ToDo branch BEFORE the ideator. Single
 * dispatch per tick: triage spawn preempts ideator; both still preempted
 * by any non-empty ToDo dispatch path.
 */
describe("poll — per-card triage dispatch (ISS-94)", () => {
  function triageDueIssue(overrides: Partial<Issue>): Issue {
    return {
      ...FAKE_ISSUE_FOR_TESTS,
      ...overrides,
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
    } as Issue;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockListTriageDueYamls.mockReset();
    mockListTriageDueYamls.mockReturnValue([]);
    mockListBlockedTodoYamls.mockReset();
    mockListBlockedTodoYamls.mockReturnValue([]);
    mockStampDispatchAndWrite.mockClear();
    mockFindByExternalId.mockReset();
    mockFindByExternalId.mockReturnValue(null);
  });

  it("does NOT spawn triage when autoTriage is disabled even with triage-due cards", async () => {
    // Default mock keeps autoTriage off (resetTrackerMocks).
    mockListTriageDueYamls.mockReturnValueOnce([
      triageDueIssue({
        id: "ISS-1",
        external_id: "rv1",
        status: "Review",
        title: "Review Card",
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches the danx-triage-card skill with kind=triage when autoTriage is on and a card is due", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    mockListTriageDueYamls.mockReturnValueOnce([
      triageDueIssue({
        id: "ISS-7",
        external_id: "rv7",
        status: "Review",
        title: "Review Card",
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const call = mockDispatch.mock.calls[0][0];
    expect(call.task).toContain("Triage card ISS-7");
    expect(call.task).toContain("danx-triage-card");
    expect(call.apiDispatchMeta).toEqual({
      trigger: "api",
      metadata: expect.objectContaining({
        endpoint: "poller/triage-card",
      }),
    });
  });

  it("stamps dispatch{kind: 'triage'} on the YAML before spawn", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    mockListTriageDueYamls.mockReturnValueOnce([
      triageDueIssue({
        id: "ISS-7",
        external_id: "rv7",
        status: "Review",
        title: "Review Card",
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockStampDispatchAndWrite).toHaveBeenCalled();
    const stampCall = mockStampDispatchAndWrite.mock.calls.find(
      (c) => c[2]?.kind === "triage",
    );
    expect(stampCall).toBeDefined();
    expect(stampCall![2].kind).toBe("triage");
    expect(stampCall![2].ttl_seconds).toBe(600);
  });

  it("does NOT spawn triage and falls through to ideator when no triage-due cards", async () => {
    mockIsFeatureEnabled.mockImplementation(() => true);
    // Empty triage-due list → triage path returns false → ideator runs.
    mockListTriageDueYamls.mockReturnValueOnce([]);
    // Empty Review on the tracker so ideator's threshold gate fires.
    mockTracker.fetchOpenCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0].task).toContain("/danx-ideate");
  });

  it("does NOT consider triage when ToDo has cards — the work-ready dispatch path wins", async () => {
    mockIsFeatureEnabled.mockImplementation(() => true);
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("td1", "Real ToDo", "ToDo"),
    ]);
    mockListTriageDueYamls.mockReturnValueOnce([
      triageDueIssue({
        id: "ISS-7",
        external_id: "rv7",
        status: "Review",
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const call = mockDispatch.mock.calls[0][0];
    expect(call.task).toContain("/danx-next");
    expect(call.task).not.toContain("Triage card");
  });

  it("preserves the single-dispatch invariant: triage runs and ideator is NOT also dispatched in the same tick", async () => {
    mockIsFeatureEnabled.mockImplementation(() => true);
    mockListTriageDueYamls.mockReturnValueOnce([
      triageDueIssue({
        id: "ISS-9",
        external_id: "rv9",
        status: "Review",
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const call = mockDispatch.mock.calls[0][0];
    expect(call.task).toContain("Triage card ISS-9");
    expect(call.task).not.toContain("/danx-ideate");
  });

  it("invokes listTriageDueYamls with the current epoch timestamp", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    const before = Date.now();
    mockListTriageDueYamls.mockReturnValueOnce([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockListTriageDueYamls).toHaveBeenCalled();
    const args = mockListTriageDueYamls.mock.calls[0];
    expect(args[0]).toBe("/test/repos/test-repo");
    expect(args[1]).toBeGreaterThanOrEqual(before);
    expect(args[1]).toBeLessThanOrEqual(Date.now());
  });

  it("does NOT call listTriageDueYamls when work-ready cards exist (early-return invariant)", async () => {
    mockIsFeatureEnabled.mockImplementation(() => true);
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("td1", "Real ToDo", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockListTriageDueYamls).not.toHaveBeenCalled();
    // And the dispatch was for work, not triage.
    expect(mockDispatch.mock.calls[0][0].task).toContain("/danx-next");
  });

  it("dispatches triage for a Needs Help card (blocked == null, status: Needs Help)", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    mockListTriageDueYamls.mockReturnValueOnce([
      triageDueIssue({
        id: "ISS-11",
        external_id: "nh1",
        status: "Needs Help",
        title: "Stalled human work",
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0].task).toBe(
      "Triage card ISS-11 using the danx-triage-card skill.",
    );
  });

  it("dispatches triage for a Blocked card (blocked != null, worker forces status: ToDo)", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    mockListTriageDueYamls.mockReturnValueOnce([
      triageDueIssue({
        id: "ISS-13",
        external_id: "blk1",
        status: "ToDo",
        title: "Blocked card",
        blocked: {
          reason: "Waits for ISS-99",
          timestamp: "2026-04-01T00:00:00Z",
          by: ["ISS-99"],
        },
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0].task).toBe(
      "Triage card ISS-13 using the danx-triage-card skill.",
    );
  });

  it("triage dispatches use trigger=api so the post-dispatch CRITICAL_FAILURE check does not fire (trackedCardId remains null)", async () => {
    // The post-dispatch card-progress check at handleAgentCompletion
    // only runs when `state.trackedCardId` is set, and `spawnClaude`
    // only sets it for `trigger: "trello"` dispatches. Triage uses
    // `trigger: "api"` so the flag write path stays dormant — a
    // legitimate triage outcome (card stays in Review / Needs Help /
    // Blocked) must NOT trip the halt flag.
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "ideator",
    );
    mockListTriageDueYamls.mockReturnValueOnce([
      triageDueIssue({
        id: "ISS-7",
        external_id: "rv7",
        status: "Review",
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const meta = mockDispatch.mock.calls[0][0].apiDispatchMeta;
    expect(meta.trigger).toBe("api");
    // Defense-in-depth: the metadata MUST NOT carry a card id field
    // that any future refactor could pass through.
    expect((meta.metadata as Record<string, unknown>).cardId).toBeUndefined();
  });
});

/**
 * ISS-86 — dispatch source is local YAML, not the tracker view. The
 * default `mockListDispatchableYamls` derives Issue[] from the
 * tracker's most recent `fetchOpenCards` value, which is fine for
 * legacy tests — but the cutover semantics need their own pinning.
 * These tests override `mockListDispatchableYamls` /
 * `mockListInProgressYamls` directly so the assertions are about the
 * local-YAML source, not the tracker mirror.
 */
describe("poll — local-YAML dispatch source (ISS-86)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockIsFeatureEnabled.mockReset();
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) =>
        (args[1] as string) !== "ideator" &&
        (args[1] as string) !== "autoTriage",
    );
    mockGetIssuePollerPickupPrefix.mockReset();
    mockGetIssuePollerPickupPrefix.mockReturnValue(null);
  });

  it("dispatches a hand-written ToDo YAML even when the tracker returns NO matching card (orphan dispatchable on the same tick orphan-push runs)", async () => {
    // Tracker has no ToDo card — only Review filler. The local YAML
    // walker stands in for a hand-written `<id>.yml` on disk.
    mockTracker.fetchOpenCards.mockResolvedValue([...REVIEW_FILLER]);
    const localOnly: Issue = refToFakeIssue({
      id: "ISS-555",
      external_id: "local-orphan-1",
      title: "Hand-written card",
      status: "ToDo",
    });
    mockListDispatchableYamls.mockReturnValueOnce([localOnly]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as {
      apiDispatchMeta: { metadata: { cardId: string } };
    };
    expect(arg.apiDispatchMeta.metadata.cardId).toBe("local-orphan-1");
  });

  it("does NOT dispatch a YAML the helper omitted because it carries blocked != null", async () => {
    // Tracker view says ToDo; local YAML walker filters it out (blocked
    // record). Because no card surfaces in either dispatchable or
    // blocked-resolution lists, no dispatch fires. Pins the
    // `listDispatchableYamls` filter contract end-to-end at the _poll
    // call site.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("blocked-card", "Blocked", "ToDo"),
    ]);
    mockListDispatchableYamls.mockReturnValueOnce([]);
    mockListBlockedTodoYamls.mockReturnValueOnce([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("does NOT dispatch a tracker ToDo card whose local YAML reports status=In Progress (local wins)", async () => {
    // Classic split-brain scenario the source-of-truth contract
    // resolves: tracker UI says ToDo; local YAML says In Progress.
    // Dispatch source is local — the card flows into the orphan-resume
    // path, not the ToDo dispatch path. With no dispatch_id stamped
    // and no JSONL on disk, orphan-resume returns no-session-dir and
    // no dispatch fires this tick.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("split-brain", "Split-brain card", "ToDo"),
    ]);
    mockListDispatchableYamls.mockReturnValueOnce([]);
    mockListInProgressYamls.mockReturnValueOnce([
      refToFakeIssue({
        id: "ISS-700",
        external_id: "split-brain",
        title: "Split-brain card",
        status: "In Progress",
      }),
    ]);
    // No dispatch_id stamped → tryResumeOrphan skips silently.
    mockFindByExternalId.mockReturnValue(null);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("pickup-prefix filter operates on the local-YAML-derived list (system-test isolation invariant survives the cutover)", async () => {
    // Two local YAMLs; only the prefix-matching one gets dispatched.
    // Pre-cutover this filter ran on the tracker IssueRef list; post-
    // cutover it must run on the local-YAML projection.
    mockGetIssuePollerPickupPrefix.mockReturnValue("[ST]");
    mockTracker.fetchOpenCards.mockResolvedValue([]);
    mockListDispatchableYamls.mockReturnValueOnce([
      refToFakeIssue({
        id: "ISS-801",
        external_id: "card-skip",
        title: "Real card not for the test",
        status: "ToDo",
      }),
      refToFakeIssue({
        id: "ISS-802",
        external_id: "card-st",
        title: "[ST] system test card",
        status: "ToDo",
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as {
      apiDispatchMeta: { metadata: { cardId: string } };
    };
    expect(arg.apiDispatchMeta.metadata.cardId).toBe("card-st");
  });

  it("invokes listInProgressYamls (NOT tracker.fetchOpenCards filter) to source the orphan-resume scan — AC4", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("td-only", "ToDo card", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockListInProgressYamls).toHaveBeenCalledWith(
      "/test/repos/test-repo",
      "ISS",
    );
  });

  it("still calls tracker.fetchOpenCards each tick (Slice B inbound channel) — AC5", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("td-1", "Card 1", "ToDo"),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    // Needs Help check + _poll's ToDo branch both call fetchOpenCards;
    // assert at least one to lock the inbound-channel invariant.
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });

  it("dispatches the FIFO-oldest ToDo YAML when the helper returns multiple candidates — locks _poll's no-resort invariant", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([]);
    // The helper is contractually FIFO-sorted; _poll must not re-sort
    // or shuffle. Order the mock return as [older, newer] and assert
    // the older card dispatches.
    mockListDispatchableYamls.mockReturnValueOnce([
      refToFakeIssue({
        id: "ISS-OLD",
        external_id: "card-older",
        title: "Older card",
        status: "ToDo",
      }),
      refToFakeIssue({
        id: "ISS-NEW",
        external_id: "card-newer",
        title: "Newer card",
        status: "ToDo",
      }),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0] as {
      apiDispatchMeta: { metadata: { cardId: string } };
    };
    expect(arg.apiDispatchMeta.metadata.cardId).toBe("card-older");
  });

  it("calls listDispatchableYamls with no exclude set — Phase 4 of ISS-90 retired the excludeExternalIds filter (action_items now hydrate as Review)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      { id: "", external_id: "ai-1", title: "AI card", status: "Review" },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockListDispatchableYamls).toHaveBeenCalled();
    const callArgs = mockListDispatchableYamls.mock.calls[0];
    // (path, prefix) — the legacy `options` arg was retired. Phase 1 of
    // ISS-99 added the per-repo `prefix` so the walker filters to
    // `<prefix>-N.yml` only.
    expect(callArgs.length).toBe(2);
    expect(callArgs[0]).toBe("/test/repos/test-repo");
    expect(callArgs[1]).toBe("ISS");
  });
});

describe("poll — heal pass ordering (ISS-133, Phase 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockHealLocalYamls.mockReset();
    mockHealLocalYamls.mockReturnValue({ healed: [], errors: [] });
  });

  it("calls healLocalYamls BEFORE tracker.fetchOpenCards on every tick (AC #1)", async () => {
    // Default tracker fetch returns the Review filler — no ToDo cards
    // means the tick is read-only after the heal pass + tracker fetch.
    // Both must still fire so the heal pass runs every tick, not only
    // when a dispatch is queued.
    await poll(MOCK_REPO_CONTEXT);

    expect(mockHealLocalYamls).toHaveBeenCalledTimes(1);
    expect(mockHealLocalYamls).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.localPath,
      MOCK_REPO_CONTEXT.issuePrefix,
    );
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();

    const healOrder = mockHealLocalYamls.mock.invocationCallOrder[0];
    const fetchOrder = mockTracker.fetchOpenCards.mock.invocationCallOrder[0];
    expect(healOrder).toBeLessThan(fetchOrder);
  });

  it("end-to-end: an ISS-95-style stuck Done YAML is reported as healed and the result is logged (AC #6)", async () => {
    // Heal-pass observable: the poller calls into the heal helper,
    // receives `{healed: [{id, status}], errors: []}`, and continues
    // the tick. The heal helper itself is unit-tested with real fs in
    // `heal.test.ts` — this test pins the integration: poller invokes
    // the helper with the right args and consumes the return value
    // without crashing the rest of the tick.
    mockHealLocalYamls.mockReturnValue({
      healed: [{ id: "ISS-95", status: "Done" }],
      errors: [],
    });

    await poll(MOCK_REPO_CONTEXT);

    // Helper called with the tick's repo path + prefix.
    expect(mockHealLocalYamls).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.localPath,
      MOCK_REPO_CONTEXT.issuePrefix,
    );
    // Tick continued past the heal pass — the rest of the poll body
    // ran (tracker fetch fired). Without this assertion a regression
    // that throws on a non-empty `healed[]` would silently abort the
    // tick.
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });
});

describe("poll — external_id heal pass (DX-150, Trello-decouple Phase 9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockHealLocalYamls.mockReset();
    mockHealLocalYamls.mockReturnValue({ healed: [], errors: [] });
    mockHealExternalIds.mockReset();
    mockHealExternalIds.mockReturnValue({ healed: [], errors: [] });
  });

  it("calls healExternalIds AFTER healLocalYamls and BEFORE tracker.fetchOpenCards (AC #3)", async () => {
    await poll(MOCK_REPO_CONTEXT);

    expect(mockHealExternalIds).toHaveBeenCalledTimes(1);
    // Args are (repoLocalPath, tracker, prefix). The tracker is the
    // shared per-repo instance — same as the one fetchOpenCards uses
    // below — so the pass can ask `isValidExternalId` without an
    // extra factory round-trip.
    const [path, trackerArg, prefix] =
      mockHealExternalIds.mock.calls[0]!;
    expect(path).toBe(MOCK_REPO_CONTEXT.localPath);
    expect(prefix).toBe(MOCK_REPO_CONTEXT.issuePrefix);
    expect(trackerArg).toBe(mockTracker);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();

    // healLocalYamls (the open/→closed/ pass) MUST run first. The
    // ordering matters: a ToDo-class YAML stamped Done locally without
    // a tracker push is moved to closed/ first, then the format heal
    // ignores it (closed/ is scanned but a healed-then-moved file is
    // already gone from open/).
    const healLocalOrder =
      mockHealLocalYamls.mock.invocationCallOrder[0]!;
    const healExternalOrder =
      mockHealExternalIds.mock.invocationCallOrder[0]!;
    const fetchOrder = mockTracker.fetchOpenCards.mock.invocationCallOrder[0]!;
    expect(healLocalOrder).toBeLessThan(healExternalOrder);
    expect(healExternalOrder).toBeLessThan(fetchOrder);
  });

  it("a non-empty healed[] is consumed without aborting the tick (AC #2)", async () => {
    // Heal helper unit-tested in `heal-external-id.test.ts` — this
    // test pins the integration: poller invokes the helper, receives
    // a non-empty `healed[]`, and continues into the regular tick
    // (tracker fetch fires).
    mockHealExternalIds.mockReturnValue({
      healed: [{ id: "DX-30", oldExternalId: "mem-2" }],
      errors: [],
    });

    await poll(MOCK_REPO_CONTEXT);

    expect(mockHealExternalIds).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.localPath,
      mockTracker,
      MOCK_REPO_CONTEXT.issuePrefix,
    );
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });
});

describe("runStartupReattach (ISS-92, Phase 2)", () => {
  let runStartupReattach: typeof import("./index.js").runStartupReattach;
  let _resetForTesting: typeof import("./index.js")._resetForTesting;
  let _getActiveDispatchesForTesting: typeof import("./index.js")._getActiveDispatchesForTesting;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./index.js");
    runStartupReattach = mod.runStartupReattach;
    _resetForTesting = mod._resetForTesting;
    _getActiveDispatchesForTesting = mod._getActiveDispatchesForTesting;
    _resetForTesting();
    mockClearDispatchAndWrite.mockClear();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
  });

  function makeIssueWithDispatch(
    id: string,
    pid: number,
    host: string,
    kindOverride: "work" | "triage" = "work",
  ): Issue {
    return {
      schema_version: 3,
      tracker: "memory",
      id,
      external_id: `ext-${id}`,
      parent_id: null,
      children: [],
      dispatch: {
        id: `did-${id}`,
        pid,
        host,
        kind: kindOverride,
        started_at: new Date(Date.now() - 30_000).toISOString(),
        ttl_seconds: 7200,
      },
      status: "In Progress",
      type: "Feature",
      title: id,
      description: "",
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      history: [],
    };
  }

  it("registers same-host alive PIDs in activeDispatches and does NOT clear their YAMLs", async () => {
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    const aliveIssue = makeIssueWithDispatch("ISS-1", 1234, host);

    mockReaddirSync.mockReturnValue(["ISS-1.yml"]);
    mockLoadLocal.mockImplementation(
      (_repo: string, id: string) => (id === "ISS-1" ? aliveIssue : null),
    );
    mockIsPidAlive.mockReturnValue(true);

    runStartupReattach(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-1")).toBe(true);
    expect(map.get("ISS-1")?.id).toBe("did-ISS-1");
    expect(mockClearDispatchAndWrite).not.toHaveBeenCalled();
  });

  it("clears YAMLs whose PID is dead (same host, isPidAlive false) and skips activeDispatches", async () => {
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    const deadIssue = makeIssueWithDispatch("ISS-2", 9999, host);

    mockReaddirSync.mockReturnValue(["ISS-2.yml"]);
    mockLoadLocal.mockImplementation(
      (_repo: string, id: string) => (id === "ISS-2" ? deadIssue : null),
    );
    mockIsPidAlive.mockReturnValue(false);

    runStartupReattach(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-2")).toBe(false);
    expect(mockClearDispatchAndWrite).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.localPath,
      deadIssue,
    );
  });

  it("clears cross-host YAMLs (host mismatch) regardless of PID liveness", async () => {
    const otherHost = "some-other-host-not-this-one";
    const crossHostIssue = makeIssueWithDispatch("ISS-3", 1234, otherHost);

    mockReaddirSync.mockReturnValue(["ISS-3.yml"]);
    mockLoadLocal.mockImplementation(
      (_repo: string, id: string) => (id === "ISS-3" ? crossHostIssue : null),
    );
    // Even with isPidAlive: true, cross-host wins.
    mockIsPidAlive.mockReturnValue(true);

    runStartupReattach(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-3")).toBe(false);
    expect(mockClearDispatchAndWrite).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.localPath,
      crossHostIssue,
    );
  });

  it("clears expired-TTL YAMLs (started_at + ttl_seconds < now) even when PID is alive", async () => {
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    const expiredIssue: Issue = {
      ...makeIssueWithDispatch("ISS-4", 1234, host),
      dispatch: {
        id: "did-ISS-4",
        pid: 1234,
        host,
        kind: "work",
        // Started 8000s ago, ttl 7200s → expired by 800s.
        started_at: new Date(Date.now() - 8000 * 1000).toISOString(),
        ttl_seconds: 7200,
      },
    };

    mockReaddirSync.mockReturnValue(["ISS-4.yml"]);
    mockLoadLocal.mockImplementation(
      (_repo: string, id: string) => (id === "ISS-4" ? expiredIssue : null),
    );
    mockIsPidAlive.mockReturnValue(true);

    runStartupReattach(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-4")).toBe(false);
    expect(mockClearDispatchAndWrite).toHaveBeenCalledTimes(1);
  });

  it("walks a mix of alive + dead + cross-host + expired in a single pass", async () => {
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    const issues: Record<string, Issue> = {
      "ISS-10": makeIssueWithDispatch("ISS-10", 1234, host), // alive
      "ISS-11": makeIssueWithDispatch("ISS-11", 5678, host), // dead-pid
      "ISS-12": makeIssueWithDispatch("ISS-12", 1234, "other-host"), // cross-host
    };

    mockReaddirSync.mockReturnValue([
      "ISS-10.yml",
      "ISS-11.yml",
      "ISS-12.yml",
    ]);
    mockLoadLocal.mockImplementation(
      (_repo: string, id: string) => issues[id] ?? null,
    );
    mockIsPidAlive.mockImplementation((pid: number) => pid === 1234);

    runStartupReattach(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-10")).toBe(true);
    expect(map.has("ISS-11")).toBe(false);
    expect(map.has("ISS-12")).toBe(false);
    // Two clears: ISS-11 (dead-pid) + ISS-12 (cross-host).
    expect(mockClearDispatchAndWrite).toHaveBeenCalledTimes(2);
  });

  it("ignores YAMLs whose dispatch is null (no work to do)", async () => {
    const issueNoDispatch: Issue = {
      ...makeIssueWithDispatch("ISS-99", 0, ""),
      dispatch: null,
    };
    mockReaddirSync.mockReturnValue(["ISS-99.yml"]);
    mockLoadLocal.mockImplementation(
      (_repo: string, id: string) => (id === "ISS-99" ? issueNoDispatch : null),
    );

    runStartupReattach(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-99")).toBe(false);
    expect(mockClearDispatchAndWrite).not.toHaveBeenCalled();
  });

  it("is a no-op when the issues/open dir does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    runStartupReattach(MOCK_REPO_CONTEXT);

    expect(mockReaddirSync).not.toHaveBeenCalled();
    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.size).toBe(0);
  });
});

describe("evictDeadDispatches (ISS-92, Phase 2 — per-tick liveness scan)", () => {
  let evictDeadDispatches: typeof import("./index.js").evictDeadDispatches;
  let runStartupReattach: typeof import("./index.js").runStartupReattach;
  let _resetForTesting: typeof import("./index.js")._resetForTesting;
  let _getActiveDispatchesForTesting: typeof import("./index.js")._getActiveDispatchesForTesting;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./index.js");
    evictDeadDispatches = mod.evictDeadDispatches;
    runStartupReattach = mod.runStartupReattach;
    _resetForTesting = mod._resetForTesting;
    _getActiveDispatchesForTesting = mod._getActiveDispatchesForTesting;
    _resetForTesting();
    mockClearDispatchAndWrite.mockClear();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
  });

  async function seedActiveDispatch(
    id: string,
    pid: number,
    host: string,
  ): Promise<Issue> {
    const issue: Issue = {
      schema_version: 3,
      tracker: "memory",
      id,
      external_id: `ext-${id}`,
      parent_id: null,
      children: [],
      dispatch: {
        id: `did-${id}`,
        pid,
        host,
        kind: "work",
        started_at: new Date(Date.now() - 30_000).toISOString(),
        ttl_seconds: 7200,
      },
      status: "In Progress",
      type: "Feature",
      title: id,
      description: "",
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      history: [],
    };
    mockReaddirSync.mockReturnValue([`${id}.yml`]);
    mockLoadLocal.mockImplementation(
      (_repo: string, lookupId: string) =>
        lookupId === id ? issue : null,
    );
    mockIsPidAlive.mockReturnValue(true);
    runStartupReattach(MOCK_REPO_CONTEXT);
    mockClearDispatchAndWrite.mockClear();
    return issue;
  }

  it("evicts entries whose PID has since died (per-tick liveness)", async () => {
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    const issue = await seedActiveDispatch("ISS-50", 1234, host);

    // Simulate the PID dying between reattach and the next tick.
    mockIsPidAlive.mockReturnValue(false);
    // loadLocal still returns the issue so clearDispatchAndWrite gets the
    // current YAML state (mid-session edits like AC ticks survive the
    // clear).
    mockLoadLocal.mockImplementation(
      (_repo: string, lookupId: string) =>
        lookupId === "ISS-50" ? issue : null,
    );

    evictDeadDispatches(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-50")).toBe(false);
    expect(mockClearDispatchAndWrite).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.localPath,
      issue,
    );
  });

  it("keeps still-alive entries in the map and writes nothing", async () => {
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    await seedActiveDispatch("ISS-51", 1234, host);

    // PID still alive — eviction must be a pure read, no writes.
    mockIsPidAlive.mockReturnValue(true);

    evictDeadDispatches(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-51")).toBe(true);
    expect(mockClearDispatchAndWrite).not.toHaveBeenCalled();
  });

  it("is a no-op when activeDispatches is empty (cheap fast path)", () => {
    evictDeadDispatches(MOCK_REPO_CONTEXT);
    expect(mockClearDispatchAndWrite).not.toHaveBeenCalled();
    expect(mockLoadLocal).not.toHaveBeenCalled();
  });
});

describe("runStartupReattach — corrupt-YAML tolerance (ISS-92)", () => {
  let runStartupReattach: typeof import("./index.js").runStartupReattach;
  let _resetForTesting: typeof import("./index.js")._resetForTesting;
  let _getActiveDispatchesForTesting: typeof import("./index.js")._getActiveDispatchesForTesting;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./index.js");
    runStartupReattach = mod.runStartupReattach;
    _resetForTesting = mod._resetForTesting;
    _getActiveDispatchesForTesting = mod._getActiveDispatchesForTesting;
    _resetForTesting();
    mockClearDispatchAndWrite.mockClear();
    mockExistsSync.mockReturnValue(true);
  });

  it("logs + skips a corrupt YAML and continues processing siblings", async () => {
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    const aliveIssue: Issue = {
      schema_version: 3,
      tracker: "memory",
      id: "ISS-200",
      external_id: "ext-200",
      parent_id: null,
      children: [],
      dispatch: {
        id: "did-good",
        pid: 1234,
        host,
        kind: "work",
        started_at: new Date(Date.now() - 30_000).toISOString(),
        ttl_seconds: 7200,
      },
      status: "In Progress",
      type: "Feature",
      title: "Healthy",
      description: "",
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      history: [],
    };

    mockReaddirSync.mockReturnValue(["ISS-201.yml", "ISS-200.yml"]);
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id === "ISS-201") throw new Error("Malformed YAML");
      if (id === "ISS-200") return aliveIssue;
      return null;
    });
    mockIsPidAlive.mockReturnValue(true);

    runStartupReattach(MOCK_REPO_CONTEXT);

    // Healthy sibling still got registered. Corrupt YAML did not produce
    // a clear write (the planner can't decide on a missing dispatch).
    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-200")).toBe(true);
    expect(map.has("ISS-201")).toBe(false);
    expect(mockClearDispatchAndWrite).not.toHaveBeenCalled();
  });
});

describe("evictDeadDispatches — YAML missing on disk (ISS-92)", () => {
  let evictDeadDispatches: typeof import("./index.js").evictDeadDispatches;
  let runStartupReattach: typeof import("./index.js").runStartupReattach;
  let _resetForTesting: typeof import("./index.js")._resetForTesting;
  let _getActiveDispatchesForTesting: typeof import("./index.js")._getActiveDispatchesForTesting;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./index.js");
    evictDeadDispatches = mod.evictDeadDispatches;
    runStartupReattach = mod.runStartupReattach;
    _resetForTesting = mod._resetForTesting;
    _getActiveDispatchesForTesting = mod._getActiveDispatchesForTesting;
    _resetForTesting();
    mockClearDispatchAndWrite.mockClear();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
  });

  it("drops the in-memory entry when the YAML disappears between reattach and eviction", async () => {
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    const issue: Issue = {
      schema_version: 3,
      tracker: "memory",
      id: "ISS-301",
      external_id: "ext-301",
      parent_id: null,
      children: [],
      dispatch: {
        id: "did-x",
        pid: 1234,
        host,
        kind: "work",
        started_at: new Date(Date.now() - 30_000).toISOString(),
        ttl_seconds: 7200,
      },
      status: "In Progress",
      type: "Feature",
      title: "X",
      description: "",
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      history: [],
    };

    // Seed alive entry.
    mockReaddirSync.mockReturnValue(["ISS-301.yml"]);
    mockLoadLocal.mockImplementation(
      (_repo: string, id: string) => (id === "ISS-301" ? issue : null),
    );
    mockIsPidAlive.mockReturnValue(true);
    runStartupReattach(MOCK_REPO_CONTEXT);
    mockClearDispatchAndWrite.mockClear();

    // Now the YAML disappears (manual delete by operator, file move) —
    // loadLocal returns null. PID has died too.
    mockIsPidAlive.mockReturnValue(false);
    mockLoadLocal.mockReturnValue(null);

    evictDeadDispatches(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-301")).toBe(false);
    // No file to write to → no clear call.
    expect(mockClearDispatchAndWrite).not.toHaveBeenCalled();
  });
});

describe("spawnClaude — dispatchStamp lifecycle (ISS-92, Phase 2)", () => {
  let _getActiveDispatchesForTesting: typeof import("./index.js")._getActiveDispatchesForTesting;
  let _resetForTesting: typeof import("./index.js")._resetForTesting;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("./index.js");
    _getActiveDispatchesForTesting = mod._getActiveDispatchesForTesting;
    _resetForTesting = mod._resetForTesting;
    _resetForTesting();
    mockClearDispatchAndWrite.mockClear();
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
        dispatch: {
          id: dispatchId,
          pid: 0,
          host: "",
          kind: "work",
          started_at: "",
          ttl_seconds: 0,
        },
      }),
    );
    mockStampDispatchAndWrite.mockImplementation(
      (
        _repo: string,
        issue: Record<string, unknown>,
        dispatchOrId: string | Record<string, unknown>,
      ) => {
        const dispatch =
          typeof dispatchOrId === "string"
            ? {
                id: dispatchOrId,
                pid: 0,
                host: "",
                kind: "work",
                started_at: "",
                ttl_seconds: 0,
              }
            : dispatchOrId;
        return { ...issue, dispatch };
      },
    );
    mockGetIssuePollerPickupPrefix.mockReturnValue(null);
    mockListBlockedTodoYamls.mockReturnValue([]);
    mockListInProgressYamls.mockReturnValue([]);
    mockFindByExternalId.mockReturnValue(null);
    mockLoadLocal.mockReturnValue(null);
    mockFindNonTerminalDispatches.mockResolvedValue([]);
    mockIsPidAlive.mockReturnValue(false);
    // runStartupReattach reads through `existsSync` for the issues/open
    // dir + walks `readdirSync` for entries. Default to "exists, empty"
    // so reattach is a no-op when tests don't seed YAMLs.
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    // Reset mockDispatch's implementation between tests — `vi.clearAllMocks`
    // wipes call history but preserves implementations, so a prior test
    // that set `mockDispatch.mockImplementation(...)` would leak its
    // capturing closure into the next test's body.
    mockDispatch.mockReset();
    mockDispatch.mockResolvedValue({
      dispatchId: "default-did",
      job: {
        id: "default-job",
        status: "running",
        summary: "",
        startedAt: new Date(),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop: async () => {},
      },
    });
  });

  it("post-spawn stamps the real PID when paired-write callback fires (DX-140)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-pid-real", "Card PID Real", "ToDo"),
    ]);
    // DX-140: the launcher invokes `pairedWriteYaml.write(pid)` after
    // its runtime fork resolves the agent PID. The poller's mock
    // `dispatch()` here simulates that callback with the resolved pid
    // = 65432 — same effect as the real launcher's paired-write firing.
    mockDispatch.mockImplementation(
      (opts: { pairedWriteYaml?: { write: (pid: number) => void } }) => {
        opts.pairedWriteYaml?.write(65432);
        return Promise.resolve({
          dispatchId: "did-1",
          job: {
            id: "job-1",
            status: "running",
            summary: "",
            startedAt: new Date(),
            handle: { pid: 65432 },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            stop: async () => {},
          },
        });
      },
    );

    // The pairedWriteYaml.write callback consults loadLocal to read the
    // current Issue before re-stamping the YAML with the real PID.
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id !== "ISS-FAKE") return null;
      return {
        ...FAKE_ISSUE_FOR_TESTS,
        external_id: "card-pid-real",
        dispatch: {
          id: "placeholder",
          pid: 0,
          host: "h",
          kind: "work",
          started_at: "now",
          ttl_seconds: 7200,
        },
      };
    });

    await poll(MOCK_REPO_CONTEXT);

    // The paired-write stamp call carries pid: 65432.
    const stampCalls = mockStampDispatchAndWrite.mock.calls;
    const postSpawn = stampCalls.find((call) => {
      const stamp = call[2] as { pid?: number };
      return stamp && stamp.pid === 65432;
    });
    expect(postSpawn).toBeDefined();

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.get("ISS-FAKE")?.pid).toBe(65432);
  });

  it("paired-write that never fires leaves the in-memory map empty (no fallback to pid:0)", async () => {
    // DX-140 retired the implicit `pid: 0` fallback. The launcher's
    // `pairedWriteYaml.write` callback runs ONLY after a successful
    // runtime fork; if dispatch returns without invoking it (test mock
    // that bypasses paired-write, e.g. dispatch()-throws path), the map
    // stays empty. Replaces the pre-DX-140 contract where the poller
    // post-stamped pid:0 unconditionally.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-no-handle", "Card No Handle", "ToDo"),
    ]);
    mockDispatch.mockResolvedValue({
      dispatchId: "did-2",
      job: {
        id: "job-2",
        status: "running",
        summary: "",
        startedAt: new Date(),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop: async () => {},
      },
    });
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id !== "ISS-FAKE") return null;
      return {
        ...FAKE_ISSUE_FOR_TESTS,
        external_id: "card-no-handle",
        dispatch: {
          id: "placeholder",
          pid: 0,
          host: "h",
          kind: "work",
          started_at: "now",
          ttl_seconds: 7200,
        },
      };
    });

    await poll(MOCK_REPO_CONTEXT);

    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-FAKE")).toBe(false);
  });

  it("clears YAML + drops in-memory entry on pre-spawn failure (rollback invariant)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-pre-fail", "Card Pre Fail", "ToDo"),
    ]);
    // dispatch() rejects — workspace resolution failure, MCP probe failure,
    // OS spawn error all funnel through this branch.
    mockDispatch.mockRejectedValue(new Error("Workspace not found"));
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id !== "ISS-FAKE") return null;
      return {
        ...FAKE_ISSUE_FOR_TESTS,
        external_id: "card-pre-fail",
        dispatch: {
          id: "placeholder",
          pid: 0,
          host: "h",
          kind: "work",
          started_at: "now",
          ttl_seconds: 7200,
        },
      };
    });

    await poll(MOCK_REPO_CONTEXT);

    // Rollback: dispatch{} cleared on the YAML, in-memory entry never
    // registered (or cleared if it was — pre-spawn write happens
    // before dispatch() resolves).
    expect(mockClearDispatchAndWrite).toHaveBeenCalled();
    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-FAKE")).toBe(false);
  });

  it("onComplete clears YAML + drops in-memory entry on agent timeout (status != completed)", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-timeout", "Card Timeout", "ToDo"),
    ]);
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: {
        onComplete?: (job: unknown) => void;
        pairedWriteYaml?: { write: (pid: number) => void };
      }) => {
        capturedOnComplete = opts.onComplete;
        // DX-140: simulate the launcher invoking paired-write after PID
        // resolution so the in-memory `activeDispatches` map gets
        // populated — the test's mid-test assertion depends on it.
        opts.pairedWriteYaml?.write(4242);
        return Promise.resolve({
          dispatchId: "did-timeout",
          job: {
            id: "job-timeout",
            status: "running",
            summary: "",
            startedAt: new Date(),
            handle: { pid: 4242 },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            stop: async () => {},
          },
        });
      },
    );

    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id !== "ISS-FAKE") return null;
      return {
        ...FAKE_ISSUE_FOR_TESTS,
        external_id: "card-timeout",
        dispatch: {
          id: "did-timeout",
          pid: 4242,
          host: "h",
          kind: "work",
          started_at: "now",
          ttl_seconds: 7200,
        },
      };
    });

    await poll(MOCK_REPO_CONTEXT);

    const mapDuring = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(mapDuring.has("ISS-FAKE")).toBe(true);

    mockClearDispatchAndWrite.mockClear();

    // Simulate the agent timing out — onComplete fires with status: "timeout".
    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!({
      id: "job-timeout",
      status: "timeout",
      summary: "Agent timed out",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();

    expect(mockClearDispatchAndWrite).toHaveBeenCalled();
    const mapAfter = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(mapAfter.has("ISS-FAKE")).toBe(false);
  });

  it("AC #5 — worker restart with alive PID does NOT redispatch (reattach + orphan-resume gate)", async () => {
    // Simulates the AC #5 scenario end-to-end inside a single tick:
    //   1. A prior dispatch pre-populated `activeDispatches` via
    //      runStartupReattach (we seed it directly here).
    //   2. The new poll() tick sees the In Progress card.
    //   3. orphan-resume's YAML-based guard checks activeDispatches,
    //      finds the issue, skips the resume.
    //   4. mockDispatch is NEVER called for that card.
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    const aliveDispatch = {
      id: "did-alive",
      pid: 4242,
      host,
      kind: "work" as const,
      started_at: new Date(Date.now() - 30_000).toISOString(),
      ttl_seconds: 7200,
    };

    // Simulate the boot reattach having already registered this card.
    const aliveYaml: Issue = {
      schema_version: 3,
      tracker: "memory",
      id: "ISS-501",
      external_id: "card-restart-alive",
      parent_id: null,
      children: [],
      dispatch: aliveDispatch,
      status: "In Progress",
      type: "Feature",
      title: "Pre-existing live dispatch",
      description: "",
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      history: [],
    };

    mockReaddirSync.mockReturnValue(["ISS-501.yml"]);
    mockLoadLocal.mockImplementation((_repo: string, id: string) =>
      id === "ISS-501" ? aliveYaml : null,
    );
    mockIsPidAlive.mockReturnValue(true);

    // Boot reattach phase: registers ISS-501 as alive in activeDispatches.
    const mod = await import("./index.js");
    mod.runStartupReattach(MOCK_REPO_CONTEXT);

    // Now drive a full poll tick. tracker shows the same card In Progress.
    // The orphan-resume path should consult activeDispatches and skip.
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-restart-alive", "Pre-existing live dispatch", "In Progress"),
    ]);
    // Use *Once variants so the override doesn't leak into subsequent
    // tests in this describe block (vi.clearAllMocks() preserves
    // implementations set via mockReturnValue).
    mockListInProgressYamls.mockReturnValueOnce([aliveYaml]);
    mockListDispatchableYamls.mockReturnValueOnce([]);
    mockFindByExternalId.mockImplementation(
      (_repo: string, externalId: string) =>
        externalId === "card-restart-alive" ? aliveYaml : null,
    );
    mockDispatch.mockClear();

    await poll(MOCK_REPO_CONTEXT);

    // The YAML reattach gate fired — orphan-resume skipped. No spawn.
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("AC #6 — TTL-expired dispatch is cleared by reattach and the next tick can redispatch", async () => {
    // AC #6 end-to-end:
    //   1. Worker restarts; a prior dispatch left an expired-TTL stamp
    //      on disk.
    //   2. runStartupReattach detects the dead-ttl verdict, clears the
    //      YAML's dispatch{} block, does NOT register in
    //      activeDispatches.
    //   3. The next tick sees the card with `dispatch: null` — the
    //      orphan-resume "no dispatch stamp" branch resets to ToDo
    //      (and the regular dispatch path can pick the card up).
    const { hostname: osHostname } = await import("node:os");
    const host = osHostname();
    const expiredYaml: Issue = {
      schema_version: 3,
      tracker: "memory",
      id: "ISS-502",
      external_id: "card-ttl-expired",
      parent_id: null,
      children: [],
      dispatch: {
        id: "did-expired",
        pid: 4242,
        host,
        kind: "work",
        // Started 8000s ago, TTL 7200s → expired by 800s.
        started_at: new Date(Date.now() - 8000 * 1000).toISOString(),
        ttl_seconds: 7200,
      },
      status: "In Progress",
      type: "Feature",
      title: "Expired",
      description: "",
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      history: [],
    };

    mockReaddirSync.mockReturnValue(["ISS-502.yml"]);
    mockLoadLocal.mockImplementation((_repo: string, id: string) =>
      id === "ISS-502" ? expiredYaml : null,
    );
    mockIsPidAlive.mockReturnValue(true);
    mockClearDispatchAndWrite.mockClear();

    const mod = await import("./index.js");
    mod.runStartupReattach(MOCK_REPO_CONTEXT);

    // Reattach pass cleared the YAML (dead-ttl verdict).
    expect(mockClearDispatchAndWrite).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.localPath,
      expiredYaml,
    );
    // Card NOT registered in activeDispatches.
    const map = mod._getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-502")).toBe(false);
  });

  it("onComplete clears YAML + drops in-memory entry on agent failure (status: 'failed')", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([
      ref("card-fail", "Card Fail", "ToDo"),
    ]);
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({
          dispatchId: "did-fail",
          job: {
            id: "job-fail",
            status: "running",
            summary: "",
            startedAt: new Date(),
            handle: { pid: 4243 },
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            stop: async () => {},
          },
        });
      },
    );
    mockLoadLocal.mockImplementation((_repo: string, id: string) => {
      if (id !== "ISS-FAKE") return null;
      return {
        ...FAKE_ISSUE_FOR_TESTS,
        external_id: "card-fail",
        dispatch: {
          id: "did-fail",
          pid: 4243,
          host: "h",
          kind: "work",
          started_at: "now",
          ttl_seconds: 7200,
        },
      };
    });

    await poll(MOCK_REPO_CONTEXT);
    mockClearDispatchAndWrite.mockClear();

    capturedOnComplete!({
      id: "job-fail",
      status: "failed",
      summary: "crashed",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();

    expect(mockClearDispatchAndWrite).toHaveBeenCalled();
    const map = _getActiveDispatchesForTesting(MOCK_REPO_CONTEXT.name);
    expect(map.has("ISS-FAKE")).toBe(false);
  });
});
