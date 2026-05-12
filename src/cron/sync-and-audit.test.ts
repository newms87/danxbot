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
  hostPath: "/test/repos/test-repo",
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
    requiresHumanLabelId: "rh-label",
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
      doneListId: "done-list",
      cancelledListId: "cancelled-list",
      actionItemsListId: "ai-list",
      bugLabelId: "bug-label",
      featureLabelId: "feature-label",
      epicLabelId: "epic-label",
      needsHelpLabelId: "nh-label",
      blockedLabelId: "blk-label",
      requiresHumanLabelId: "rh-label",
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

vi.mock("../poller/constants.js", () => ({
  getReposBase: () => "/danxbot/repos",
  REVIEW_MIN_CARDS: 10,
  TEAM_PROMPT: "/danx-next",
  TEAM_PROMPT_RESUME: "/danx-next",
  IDEATOR_PROMPT: "/danx-ideate",
  TRIAGE_CARD_PROMPT: (id: string) => `/danx-triage-card ${id}`,
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

// DX-142 Phase 3: process-table orphan scan called once per tick in
// `runSync` (alongside `evictDeadDispatches`). Mock it to a no-op so the
// poller tick stays Layer 1 and any test that wants to assert the
// per-tick call shape can reach the captured fn directly.
const mockReapOrphans = vi
  .fn()
  .mockResolvedValue({ scanned: 0, reaped: [], mismatched: [], healthy: 0 });
vi.mock("../worker/process-scan.js", () => ({
  reapOrphans: (...args: unknown[]) => mockReapOrphans(...args),
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
  priority: 3.0,
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
const mockLoadLocal = vi.fn().mockResolvedValue(null);
const mockFindByExternalId = vi.fn().mockResolvedValue(null);
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
    schema_version: 7,
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
    priority: 3.0,
    position: null,
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
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
//
// DX-222: factory defaults extracted as named functions so a beforeEach
// can `mockReset()` + re-apply them. Without this, leftover
// `mockResolvedValueOnce` queues from prior tests in the same describe
// block leak (vi.clearAllMocks preserves both impls AND once queues),
// silently flipping later tests' poll() into the wrong dispatch branch.
async function defaultListDispatchableYamls(
  _repoPath: string,
  _prefix?: string,
): Promise<Issue[]> {
  return _currentOpenCards()
    .filter((r) => r.status === "ToDo")
    .map(refToFakeIssue);
}
async function defaultListInProgressYamls(
  _repoPath: string,
  _prefix?: string,
): Promise<Issue[]> {
  return _currentOpenCards()
    .filter((r) => r.status === "In Progress")
    .map(refToFakeIssue);
}
const mockListDispatchableYamls = vi.fn(defaultListDispatchableYamls);
const mockListInProgressYamls = vi.fn(defaultListInProgressYamls);
const mockListTriageDueYamls = vi.fn(
  async (
    _repoPath: string,
    _now: number,
    _prefix?: string,
  ): Promise<Issue[]> => [],
);

vi.mock("../poller/local-issues.js", () => ({
  listDispatchableYamls: (...args: unknown[]) =>
    mockListDispatchableYamls(...(args as [string, string?])),
  listInProgressYamls: (...args: unknown[]) =>
    mockListInProgressYamls(...(args as [string, string?])),
  listTriageDueYamls: (...args: unknown[]) =>
    mockListTriageDueYamls(...(args as [string, number, string?])),
}));

// epic-status: queries the DB for parents/children since DX-155. The
// unit-mock suite has no live PG, so stub recompute to a no-op. Spy
// kept on `mockRecomputeParentStatuses` so DX-217 Phase 2 anti-
// regression tests can assert `runSync` no longer calls it.
const mockRecomputeParentStatuses = vi
  .fn()
  .mockResolvedValue([] as unknown[]);
vi.mock("../poller/epic-status.js", () => ({
  recomputeParentStatuses: (...args: unknown[]) =>
    mockRecomputeParentStatuses(...args),
  deriveStatus: () => null,
}));

const mockClearDispatchAndWrite = vi.fn((...args: unknown[]) => {
  const issue = args[1] as Record<string, unknown>;
  return { ...issue, dispatch: null };
});

vi.mock("../poller/yaml-lifecycle.js", () => ({
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
vi.mock("../poller/heal.js", () => ({
  healLocalYamls: (...args: unknown[]) => mockHealLocalYamls(...args),
}));

// DX-150: per-tick external_id format heal pass. Mocked so existing
// tests' fake fs doesn't crash the real readdirSync; the wiring test
// below overrides the implementation to assert call order vs
// healLocalYamls / tracker.fetchOpenCards.
const mockHealExternalIds = vi
  .fn()
  .mockReturnValue({ healed: [], errors: [] });
vi.mock("../poller/heal-external-id.js", () => ({
  healExternalIds: (...args: unknown[]) => mockHealExternalIds(...args),
}));

// DX-218 (Event-Driven Worker Phase 3) retired the per-tick retry-queue
// drain from `runSync`. The poller no longer imports `drainRetries` or
// `recordSystemError`; what remains lives behind the timer callback in
// `src/issue-tracker/retry-queue.ts` (boot-rescheduled by `src/index.ts`)
// and is exercised in `src/issue-tracker/retry-queue.test.ts`.

// Feature-aware default: ideator's env default is `false` (explicit
// opt-in via `<repo>/.danxbot/settings.json` overrides). Every other
// feature defaults to `true` so existing tests that don't care about
// the toggle continue to dispatch.
const mockIsFeatureEnabled = vi.fn(
  (...args: unknown[]) => (args[1] as string) !== "ideator",
);
vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

vi.mock("../workspace/write-if-changed.js", () => ({
  writeIfChanged: (path: string, content: string): boolean => {
    mockWriteFileSync(path, content);
    return true;
  },
}));

// DX-290: zero-dispatch invariant spy. `runSync` MUST NOT invoke the
// multi-agent picker — every dispatch decision moved to the scheduler's
// `runPicker` callback (registered at boot in `src/index.ts`). Keep the
// mock at module level so the assertion captures any future regression
// where `runSync` re-introduces a direct picker call.
const mockTryMultiAgentDispatch = vi
  .fn()
  .mockResolvedValue({ dispatched: 0, conflictBlocked: 0 });
vi.mock("../poller/multi-agent-pick.js", () => ({
  tryMultiAgentDispatch: (...args: unknown[]) =>
    mockTryMultiAgentDispatch(...args),
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
const mockChmodSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
  renameSync: vi.fn(),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
  symlinkSync: vi.fn(),
  readlinkSync: (...args: unknown[]) => mockReadlinkSync(...args),
  lstatSync: (...args: unknown[]) => mockLstatSync(...args),
}));

import {
  poll,
  shutdown,
  start,
  _resetForTesting,
} from "./sync-and-audit.js";
import { syncRepoFiles } from "../inject/sync.js";

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
  priority: 3.0,
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
  // leak into the current `beforeEach` and silently flip ideator on.
  mockIsFeatureEnabled.mockReset();
  mockIsFeatureEnabled.mockImplementation(
    (...args: unknown[]) =>
      (args[1] as string) !== "ideator" && (args[1] as string) !== "autoTriage",
  );
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
  });


  it("does nothing when no cards in ToDo", async () => {
    // Default fetchOpenCards (REVIEW_FILLER only — no ToDo cards) means
    // the ToDo branch is empty.
    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
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
      `${workspaceClaudePrefix}rules/danx-issue-prefix.md`,
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

    // DX-103 Phase 4: per-workspace `danx-issue-prefix.md` carries the live
    // RepoContext.issuePrefix value so workspace skills can resolve the
    // literal at agent-dispatch time without ancestor-walking the repo.
    const issuePrefixCall = mockWriteFileSync.mock.calls.find(
      (c: unknown[]) => (c[0] as string).endsWith("rules/danx-issue-prefix.md"),
    );
    expect(issuePrefixCall).toBeDefined();
    const issuePrefixBody = issuePrefixCall![1] as string;
    expect(issuePrefixBody).toContain("AUTO-GENERATED by danxbot");
    expect(issuePrefixBody).toContain(`**\`${MOCK_REPO_CONTEXT.issuePrefix}\`**`);
    expect(issuePrefixBody).toContain(
      `\`${MOCK_REPO_CONTEXT.issuePrefix}-<N>\``,
    );
  });

  it("syncRepoFiles invokes injectDanxIssueMcp per repo per tick (DX-201)", async () => {
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
      if (path.endsWith("/.danxbot/workspaces")) return ["issue-worker"];
      return [];
    });
    mockStatSync.mockReturnValue({ isDirectory: () => true });

    syncRepoFiles(MOCK_REPO_CONTEXT);

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    const tmpWrite = writtenPaths.find(
      (p) => p === "/test/repos/test-repo/.mcp.json.tmp",
    );
    expect(tmpWrite).toBeDefined();
    const writtenContent = mockWriteFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === "/test/repos/test-repo/.mcp.json.tmp",
    )?.[1] as string;
    expect(writtenContent).toContain("danx-issue");
    expect(writtenContent).toContain("@thehammer/danx-issue-mcp");
  });

  it("syncRepoFiles mirrors danxbot-shipped scripts into <repo>/.danxbot/scripts/ with executable bit (DX-162)", () => {
    // Phase 4 of the multi-worker dispatch epic. The agent invokes
    // `bash .danxbot/scripts/agent-finalize.sh ...` from inside its
    // worktree at `<repo>/.danxbot/worktrees/<agent>/` to squash-merge
    // its branch onto origin/main. The inject pipeline mirrors the
    // script source from `src/inject/scripts/` into the
    // connected repo on every poll tick — same idempotent
    // writeIfChanged + chmod-exec contract `injectDanxWorkspaces`
    // uses for tools/.
    const scriptSourceDir = "src/inject/scripts";
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (path.endsWith("tools.md")) return true;
      // Source script dir + every file inside resolve as existing.
      if (path.endsWith(scriptSourceDir)) return true;
      if (path.includes(`${scriptSourceDir}/`)) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith(scriptSourceDir)) return ["agent-finalize.sh"];
      return [];
    });
    mockStatSync.mockImplementation((path: unknown) => {
      // The scripts source is a dir; its files (including the .sh) are
      // files. `injectDanxbotScripts` filters non-files via `isFile()`.
      if (typeof path === "string" && path.endsWith("agent-finalize.sh")) {
        return { isDirectory: () => false, isFile: () => true };
      }
      return { isDirectory: () => true, isFile: () => false };
    });
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      if (path.endsWith("agent-finalize.sh"))
        return "#!/usr/bin/env bash\necho hi\n";
      return "";
    });

    syncRepoFiles(MOCK_REPO_CONTEXT);

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(writtenPaths).toContain(
      "/test/repos/test-repo/.danxbot/scripts/agent-finalize.sh",
    );
    const mkdirPaths = mockMkdirSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(mkdirPaths).toContain("/test/repos/test-repo/.danxbot/scripts");
    // The .sh helper must be executable — agents `bash` it (works
    // either way) but operators / CI may invoke it directly. The
    // contract matches `copyRepoToolScripts` for tools/.
    const chmodPaths = mockChmodSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(chmodPaths).toContain(
      "/test/repos/test-repo/.danxbot/scripts/agent-finalize.sh",
    );
  });

  it("injectDanxbotScripts is a no-op when the inject scripts source dir is missing (DX-162)", () => {
    // Empty inject source — the function early-returns. The rest of
    // syncRepoFiles must keep working.
    const scriptSourceDir = "src/inject/scripts";
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (path.endsWith("tools.md")) return true;
      // The scripts source dir DOES NOT exist.
      if (path.endsWith(scriptSourceDir)) return false;
      return false;
    });
    mockReaddirSync.mockReturnValue([]);
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      return "";
    });

    syncRepoFiles(MOCK_REPO_CONTEXT);

    // No agent-finalize.sh write.
    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(
      writtenPaths.some((p) => p.endsWith("agent-finalize.sh")),
    ).toBe(false);
    // No chmod on it either.
    const chmodPaths = mockChmodSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(
      chmodPaths.some((p) => p.endsWith("agent-finalize.sh")),
    ).toBe(false);
  });

  it("injectDanxbotScripts is write-only — a target file absent from the inject source is NOT pruned (asymmetric with injectDanxWorkspaces by design; DX-162)", () => {
    // The script set is small + operator-visible; pruning would risk
    // nuking an operator-authored helper that lives alongside ours.
    // The test passes by NOT seeing any unlink / rmSync of the
    // sibling target file. We only have one source file
    // (`agent-finalize.sh`) and assert NO delete tracking happens
    // for an unrelated `legacy.sh` we pretend exists at target.
    const scriptSourceDir = "src/inject/scripts";
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (path.endsWith("tools.md")) return true;
      if (path.endsWith(scriptSourceDir)) return true;
      if (path.includes(`${scriptSourceDir}/`)) return true;
      // Pretend a sibling `legacy.sh` exists at the TARGET path —
      // outside the inject source. A pruning implementation would
      // unlink it.
      if (path.endsWith(".danxbot/scripts/legacy.sh")) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith(scriptSourceDir)) return ["agent-finalize.sh"];
      return [];
    });
    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("agent-finalize.sh")) {
        return { isDirectory: () => false, isFile: () => true };
      }
      return { isDirectory: () => true, isFile: () => false };
    });
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      if (path.endsWith("agent-finalize.sh"))
        return "#!/usr/bin/env bash\necho hi\n";
      return "";
    });

    syncRepoFiles(MOCK_REPO_CONTEXT);

    // No unlink / rmSync of the legacy file. The contract pins the
    // write-only behavior — re-introducing prune would fail this
    // assertion AND force the next maintainer to re-read the
    // function's header rationale before changing it.
    const unlinkPaths = mockUnlinkSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(
      unlinkPaths.some((p) => p.endsWith(".danxbot/scripts/legacy.sh")),
    ).toBe(false);
  });

  it("injectDanxbotScripts skips non-file entries (subdir) so a future grouping subdir does not chmod-execute as a script (DX-162)", () => {
    // readdir returns a regular file + a subdir. Only the file should
    // be copied + chmod'd. Pins the `isFile()` filter on the source loop.
    const scriptSourceDir = "src/inject/scripts";
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (path.endsWith("tools.md")) return true;
      if (path.endsWith(scriptSourceDir)) return true;
      if (path.includes(`${scriptSourceDir}/`)) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith(scriptSourceDir))
        return ["agent-finalize.sh", "shared"];
      return [];
    });
    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string")
        return { isDirectory: () => false, isFile: () => false };
      if (path.endsWith("agent-finalize.sh"))
        return { isDirectory: () => false, isFile: () => true };
      if (path.endsWith("/shared"))
        return { isDirectory: () => true, isFile: () => false };
      return { isDirectory: () => true, isFile: () => false };
    });
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      if (path.endsWith("agent-finalize.sh"))
        return "#!/usr/bin/env bash\necho hi\n";
      return "";
    });

    syncRepoFiles(MOCK_REPO_CONTEXT);

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    // Subdir was NOT written as a file.
    expect(
      writtenPaths.some((p) => p.endsWith(".danxbot/scripts/shared")),
    ).toBe(false);
    // .sh file still landed.
    expect(writtenPaths).toContain(
      "/test/repos/test-repo/.danxbot/scripts/agent-finalize.sh",
    );
    // Subdir was NOT chmod'd executable.
    const chmodPaths = mockChmodSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(
      chmodPaths.some((p) => p.endsWith(".danxbot/scripts/shared")),
    ).toBe(false);
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
    const workspacesSource = "src/inject/workspaces";
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
    const workspacesSource = "src/inject/workspaces";
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
    const workspacesSource = "src/inject/workspaces";
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
    const workspacesSource = "src/inject/workspaces";
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
    const workspacesSource = "src/inject/workspaces";
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
    const workspacesSource = "src/inject/workspaces";
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
    const workspacesSource = "src/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;
    const demoTargetRulesDir = `${demoTargetRoot}/.claude/rules`;
    const renderedNames = [
      "danx-repo-config.md",
      "danx-repo-overview.md",
      "danx-repo-workflow.md",
      "danx-tools.md",
      "danx-issue-prefix.md",
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
    const workspacesSource = "src/inject/workspaces";
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
  // `runSync`: the worker process must survive a single bad tick so
  // Slack listener / dispatch API / dashboard SSE stay alive when
  // ONE per-tick failure (tracker, lock, fs) hits. The replacement
  // contract — log+swallow at the top of `runSync`, retry on the next
  // tick — applies to syncRepoFiles' rm failures too because the
  // wrap is intentionally one block (see DX-149 design rationale on
  // top-level vs per-call). This test pins the new shape so a
  // future regression that re-introduces the rethrow surfaces
  // immediately.
  it("injectDanxWorkspaces rm failure during prune is logged + swallowed (DX-149)", async () => {
    const workspacesSource = "src/inject/workspaces";
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
      String(c[0]).includes("_sync crashed"),
    );
    expect(errCalls).toHaveLength(1);
    expect(String(errCalls[0][0])).toMatch(/EACCES/);
  });

  // DX-272: the sibling `pruneRetiredWorkspaceFiles` helper deletes
  // retired NON-`danx-*`-prefixed inject artifacts that the prefix-
  // scoped scrubber cannot reach. Specifically — `issue-worker/.claude/
  // skills/issue-blocker/` (a directory whose name lacks the `danx-`
  // prefix). The fixture places the stale dir at the target AND seeds
  // an operator-authored sibling (`my-custom-skill/`) that MUST survive
  // the prune; the tombstone is an explicit allowlist, not a prefix
  // match.
  it("injectDanxWorkspaces prunes retired non-prefixed workspace files (DX-272 issue-blocker tombstone)", async () => {
    const workspacesSource = "src/inject/workspaces";
    const issueWorkerSource = `${workspacesSource}/issue-worker`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const issueWorkerTargetRoot = `${workspacesTargetRoot}/issue-worker`;
    const issueWorkerTargetSkillsDir = `${issueWorkerTargetRoot}/.claude/skills`;
    const retiredSkillDir = `${issueWorkerTargetSkillsDir}/issue-blocker`;
    const operatorSkillDir = `${issueWorkerTargetSkillsDir}/my-custom-skill`;

    const sourceDirSuffixes = [issueWorkerSource];
    const targetDirExact = new Set<string>([
      workspacesTargetRoot,
      issueWorkerTargetRoot,
      `${issueWorkerTargetRoot}/.claude`,
      issueWorkerTargetSkillsDir,
      retiredSkillDir,
      operatorSkillDir,
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
      if (path.endsWith(workspacesSource)) return ["issue-worker"];
      // Inject source has no static rules/skills any more (DX-272
      // retired them in favor of the danxbot plugin), so the tombstone
      // is the ONLY signal that prunes the stale dir.
      if (path.endsWith(issueWorkerSource)) return ["workspace.yml"];
      if (path === workspacesTargetRoot) return ["issue-worker"];
      if (path === issueWorkerTargetRoot) return [".claude"];
      if (path === `${issueWorkerTargetRoot}/.claude`) return ["skills"];
      if (path === issueWorkerTargetSkillsDir)
        return ["issue-blocker", "my-custom-skill"];
      if (path === retiredSkillDir) return [];
      if (path === operatorSkillDir) return [];
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
        return "name: issue-worker\ndescription: issue-worker\n";
      return "";
    });

    await poll(MOCK_REPO_CONTEXT);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).toContain(retiredSkillDir);
    expect(rmPaths).not.toContain(operatorSkillDir);
  });

  // DX-272 + DX-149: `pruneRetiredWorkspaceFiles` is a sibling of the
  // prefix scrubber; an `rm` failure there must follow the same
  // log+swallow contract so the worker process survives one bad tick.
  // Without this test, a future refactor that wraps the new helper in
  // its own try/catch would silently revert the DX-149 invariant.
  it("injectDanxWorkspaces rm failure during retired-files prune is logged + swallowed (DX-149 parity for DX-272)", async () => {
    const workspacesSource = "src/inject/workspaces";
    const issueWorkerSource = `${workspacesSource}/issue-worker`;
    const workspacesTargetRoot = "/test/repos/test-repo/.danxbot/workspaces";
    const issueWorkerTargetRoot = `${workspacesTargetRoot}/issue-worker`;
    const issueWorkerTargetSkillsDir = `${issueWorkerTargetRoot}/.claude/skills`;
    const retiredSkillDir = `${issueWorkerTargetSkillsDir}/issue-blocker`;

    const sourceDirSuffixes = [issueWorkerSource];
    const targetDirExact = new Set<string>([
      workspacesTargetRoot,
      issueWorkerTargetRoot,
      `${issueWorkerTargetRoot}/.claude`,
      issueWorkerTargetSkillsDir,
      retiredSkillDir,
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
      if (path.endsWith(workspacesSource)) return ["issue-worker"];
      if (path.endsWith(issueWorkerSource)) return ["workspace.yml"];
      if (path === workspacesTargetRoot) return ["issue-worker"];
      if (path === issueWorkerTargetRoot) return [".claude"];
      if (path === `${issueWorkerTargetRoot}/.claude`) return ["skills"];
      if (path === issueWorkerTargetSkillsDir) return ["issue-blocker"];
      if (path === retiredSkillDir) return [];
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
        return "name: issue-worker\ndescription: issue-worker\n";
      return "";
    });

    mockRmSync.mockImplementation((path: unknown) => {
      if (path === retiredSkillDir) {
        throw new Error("EACCES: permission denied");
      }
    });

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    const errCalls = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_sync crashed"),
    );
    expect(errCalls).toHaveLength(1);
    expect(String(errCalls[0][0])).toMatch(/EACCES/);
  });

  // Symmetric DX-149 update for `scrubRepoRootDanxArtifacts`. Pre-DX-149
  // an rm failure here propagated out of `poll()`; post-DX-149 the
  // `runSync` top-level catch logs+swallows so the worker process
  // survives. Stale `danx-*` rules at `<repo>/.claude/` will retry on
  // the next tick — same convergence model as the tracker call wrap.
  it("scrubRepoRootDanxArtifacts rm failure is logged + swallowed (DX-149)", async () => {
    const workspacesSource = "src/inject/workspaces";
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
      String(c[0]).includes("_sync crashed"),
    );
    expect(errCalls).toHaveLength(1);
    expect(String(errCalls[0][0])).toMatch(/EACCES/);
  });
});



/**
 * DX-149 — runSync crash isolation.
 *
 * Before the fix, any tracker call inside `runSync` AFTER the existing
 * inner try/catch around `fetchOpenCards` (e.g. `tryAcquireLock` →
 * `tracker.getComments`) would throw straight past `runSync` and out
 * through `poll()`'s `finally`, killing the whole worker process.
 *
 * Contract: a single top-level try/catch in `runSync` swallows any
 * thrown error, logs it, and returns cleanly so the next tick fires.
 * `state.polling` is already reset in `poll()`'s finally; these tests
 * verify that property end-to-end by calling `poll()` twice.
 */
describe("poll — runSync crash isolation (DX-149)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("survives tracker.getComments rejection from a deeper runSync path — no rethrow", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    // Pre-DX-241 this test hit `tracker.getComments` via
    // `tryAcquireLock` inside `runSync`. DX-241 moved the lock
    // acquisition to `tryMultiAgentDispatch` (and removed it from
    // `runSync` entirely — every poll tick used to write an orphan
    // lock comment), but the property the test guards is broader: a
    // tracker rejection from ANY `runSync` code path must not kill the
    // worker. The orphan-push path under `runSync` calls
    // `tracker.getComments` to dedupe stamps, so it's a faithful
    // replacement crash class.
    mockTracker.getComments.mockRejectedValue(
      new Error("Trello API error: 400 Bad Request (GET /cards/mem-2/actions)"),
    );

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();

    // Either the top-level runSync catch OR an inner per-card catch
    // absorbs the error — both satisfy the contract. Assert the
    // worker did NOT escalate the throw (which would kill the
    // process via poll()'s finally).
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("subsequent poll() tick fires after a runSync crash — state.polling reset", async () => {
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card 1", "ToDo")]);
    mockTracker.getComments.mockRejectedValueOnce(new Error("boom"));

    // First tick: crashes inside runSync, swallowed by top-level catch.
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

  it("survives an early-runSync throw from healExternalIds (representative non-tracker path) — no rethrow, dispatch skipped", async () => {
    // Reviewer-recommended representative test for the deeper-in-runSync
    // throw paths the wrap also covers (now: reapOrphans,
    // runInvariantHeal, bulkSyncMissingYamls — the dispatch-decision
    // paths the wrap used to cover were retired in DX-290). Pins the
    // contract that the catch covers the WHOLE body, not just the
    // tracker subset.
    //
    // DX-217 (Event-Driven Worker Phase 2): replaces an earlier test
    // that used `healLocalYamls` for this same purpose. That helper was
    // absorbed into `reconcileIssue` step 3c and no longer runs from
    // `runSync`; `healExternalIds` is the next-best representative early
    // path.
    mockHealExternalIds.mockImplementationOnce(() => {
      throw new Error("disk full during external_id heal pass");
    });

    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();

    const crashLogs = mockLogger.error.mock.calls.filter((c) =>
      String(c[0]).includes("_sync crashed"),
    );
    expect(crashLogs).toHaveLength(1);
    expect(String(crashLogs[0][0])).toContain(
      "disk full during external_id heal pass",
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });


  it("top-level catch does not trip backoff (next tick fetches cards as normal, no `In backoff` skip)", async () => {
    // Pin the invariant in the comment at index.ts:516–519: a `runSync`
    // crash is logged + swallowed but does NOT count as a dispatch
    // failure for backoff purposes. Observable behavior: after a crash
    // the very next `poll()` invokes `fetchOpenCards` and does NOT log
    // `In backoff`. A regression that incremented a failure counter
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
    // since `runSync` may call `fetchOpenCards` more than once per tick
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

// DX-218 (Event-Driven Worker Phase 3) retired the per-tick
// `drainRetries` call from `runSync`; the retry queue's timers are now
// armed inside `enqueueRetry` (`src/issue-tracker/retry-queue.ts`) at
// `setTimeout(nextEligibleAt - now)` and tested at module level in
// `src/issue-tracker/retry-queue.test.ts`. The corresponding wiring
// describe block (`poll — DX-132 retry-queue drain wiring`) was deleted
// alongside the call site — there is nothing in `runSync` to assert
// against.

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

  it("starts polling without errors", async () => {
    await expect(start()).resolves.not.toThrow();
  });

  it("starts polling for every repo regardless of trelloEnabled — the per-tick isFeatureEnabled check decides whether to skip", async () => {
    mockRepoContexts[0].trelloEnabled = false;
    mockIsFeatureEnabled.mockImplementation(
      (...args: unknown[]) => (args[1] as string) !== "issuePoller",
    );

    await start();

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "issuePoller",
    );
    expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();

    mockRepoContexts[0].trelloEnabled = true;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("polls every repo in repoContexts — per-tick toggle decides which fetch the tracker", async () => {
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

    await start();

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

  /**
   * DX-322 — throttle source. `readFlag` is responsible for auto-
   * clearing past `resume_at` and returning `null`; the gate trusts
   * that contract. These tests pin the two branches the gate cares
   * about: throttle-in-window halts (same as critical_failure) and
   * throttle-post-window proceeds (readFlag returned null because it
   * auto-cleared).
   */
  it("halts when a throttle flag is in-window (now < resume_at)", async () => {
    mockReadFlag.mockReturnValue({
      timestamp: "2026-05-12T20:00:00.000Z",
      source: "throttle",
      dispatchId: "d-throttle",
      reason: "Anthropic rate-limit reached",
      resume_at: "2099-01-01T00:00:00.000Z",
      throttle_kind: "rate_limit",
    });
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockTracker.fetchOpenCards).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("proceeds when readFlag returned null after auto-clearing an expired throttle flag", async () => {
    // readFlag's own auto-clear branch unlinks the file and returns
    // null past `resume_at`. The gate sees a null payload, same as
    // any "no flag present" state, and the tick runs normally.
    mockReadFlag.mockReturnValue(null);
    mockTracker.fetchOpenCards.mockResolvedValue([ref("c1", "Card", "ToDo")]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockReadFlag).toHaveBeenCalled();
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });
});

describe("poll — DX-142 process-table orphan scan (per-tick)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockReadFlag.mockReturnValue(null);
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("invokes reapOrphans once per tick with the repo's name + localPath (sibling pass to evictDeadDispatches)", async () => {
    await poll(MOCK_REPO_CONTEXT);

    expect(mockReapOrphans).toHaveBeenCalledTimes(1);
    expect(mockReapOrphans).toHaveBeenCalledWith({
      repoName: MOCK_REPO_CONTEXT.name,
      repoLocalPath: MOCK_REPO_CONTEXT.localPath,
    });
  });

  it("a reapOrphans rejection does not crash the tick — the rest of runSync still runs", async () => {
    // The wiring is wrapped in try/catch — a failed reap pass should
    // not prevent the rest of the tick (tracker fetch, dispatch, etc).
    mockReapOrphans.mockRejectedValueOnce(new Error("pgrep exploded"));

    await poll(MOCK_REPO_CONTEXT);

    // Tracker fetch still happens — proves the catch landed and
    // runSync continued past the reap pass.
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
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





describe("poll — DX-217 Phase 2 absorbed-helpers invariant", () => {
  // After Event-Driven Worker Phase 2 (DX-217), `runSync` no longer
  // calls `healLocalYamls`, `recomputeParentStatuses`, or
  // `resolveWaitingOnCards` directly. Each helper's logic was absorbed
  // into `reconcileIssue` step 3 (`src/issue/reconcile.ts`); chokidar
  // events on YAML mutations propagate the same effects via reconcile
  // recursion (steps 9 + 10). Behavior parity for the absorbed paths
  // is exercised by `src/issue/reconcile.test.ts`. This block is the
  // anti-regression guard: a future edit that re-introduces an in-tick
  // call to any of the three helpers fails here.
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockHealLocalYamls.mockReset();
    mockHealLocalYamls.mockReturnValue({ healed: [], errors: [] });
  });

  it("does NOT call healLocalYamls from runSync (Phase 2 — absorbed into reconcile step 3c)", async () => {
    await poll(MOCK_REPO_CONTEXT);
    expect(mockHealLocalYamls).not.toHaveBeenCalled();
    // Tick still advances past the (now absent) heal pass.
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });

  it("does NOT call recomputeParentStatuses from runSync (Phase 2 — absorbed into reconcile step 3a)", async () => {
    mockRecomputeParentStatuses.mockClear();
    await poll(MOCK_REPO_CONTEXT);
    expect(mockRecomputeParentStatuses).not.toHaveBeenCalled();
    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();
  });

  // DX-218 (Event-Driven Worker Phase 3): the per-tick drainRetries
  // wiring (the previous DX-134-Phase-4 producer-wiring test) was
  // removed alongside the call site. Retry-queue MAX_ATTEMPTS
  // exhaustion now fires `recordSystemError` from inside the
  // `setTimeout`-armed timer callback in retry-queue.ts; the hook is
  // registered per-repo by `src/index.ts` and tested at module level
  // in `src/issue-tracker/retry-queue.test.ts`.
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

  it("calls healExternalIds BEFORE tracker.fetchOpenCards (AC #3)", async () => {
    // DX-217 Phase 2: the original AC #3 ordered healExternalIds AFTER
    // healLocalYamls. Phase 2 absorbed healLocalYamls into reconcile
    // step 3c, so the AFTER-healLocalYamls leg of the ordering is
    // irrelevant at the poller level. The remaining contract — the
    // external_id heal precedes the tracker fetch so a foreign id is
    // blanked before it can trigger a tracker 400 — still holds.
    await poll(MOCK_REPO_CONTEXT);

    expect(mockHealExternalIds).toHaveBeenCalledTimes(1);
    const [path, trackerArg, prefix] = mockHealExternalIds.mock.calls[0]!;
    expect(path).toBe(MOCK_REPO_CONTEXT.localPath);
    expect(prefix).toBe(MOCK_REPO_CONTEXT.issuePrefix);
    expect(trackerArg).toBe(mockTracker);

    expect(mockTracker.fetchOpenCards).toHaveBeenCalled();

    const healExternalOrder =
      mockHealExternalIds.mock.invocationCallOrder[0]!;
    const fetchOrder = mockTracker.fetchOpenCards.mock.invocationCallOrder[0]!;
    expect(healExternalOrder).toBeLessThan(fetchOrder);

    // Phase 2 anti-regression: healLocalYamls is NOT called from runSync
    // (was previously asserted to run before healExternalIds; it now
    // runs from reconcile, not the tick).
    expect(mockHealLocalYamls).not.toHaveBeenCalled();
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


/**
 * DX-290 (Event-Driven Worker Phase 4b.3) — zero-dispatch spy invariant.
 *
 * `runSync` is sync + audit only. Every dispatch decision belongs to the
 * scheduler's `runPicker` callback (fired by reconcile's
 * `onReconcileResult` and settings-watch's `onAgentRosterChange`); the
 * per-card triage + TTL timers (DX-289) own their own scheduling. A
 * regression that re-introduces a `dispatch()` call OR a
 * `tryMultiAgentDispatch` call from `runSync`'s body trips this spy.
 *
 * The fixture seeds a dispatchable ToDo card on disk (the shape that
 * historically would have triggered the legacy picker invocation) and
 * runs one `poll()` tick. Both spies MUST stay at zero invocations.
 */
describe("poll — DX-290 zero-dispatch invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    resetTrackerMocks();
    setupRepoConfigMocks();
    mockTryMultiAgentDispatch.mockClear();
  });

  it("runSync never invokes dispatch() or tryMultiAgentDispatch with a dispatchable ToDo card on disk", async () => {
    // Seed BOTH the tracker fetch AND the local-YAML dispatch source.
    // A regression that re-introduces the legacy
    // `tryMultiAgentDispatch({cards: dispatchableIssues, ...})` call
    // reads `cards` from `listDispatchableYamls`, not from the tracker
    // fetch. Without the YAML-source seed, a re-introduced picker call
    // could observe `cards: []` and the spy would falsely pass — the
    // YAML-source seed ensures the regression surface is exercised.
    const dispatchableRef = ref("card-pending", "Dispatchable ToDo", "ToDo");
    mockTracker.fetchOpenCards.mockResolvedValue([dispatchableRef]);
    mockListDispatchableYamls.mockResolvedValueOnce([
      refToFakeIssue(dispatchableRef),
    ]);

    await poll(MOCK_REPO_CONTEXT);

    // The dispatch decision belongs to the scheduler's runPicker
    // callback (registered at boot in src/index.ts), NOT runSync.
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockTryMultiAgentDispatch).not.toHaveBeenCalled();
  });
});


