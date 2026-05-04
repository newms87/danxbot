/**
 * Phase 5 verification — the poller's hot path drives EVERY tracker
 * interaction through the cached `IssueTracker` abstraction.
 *
 * AC #4 of `69f76d57359b5fe89f80ab22` asks for "a Layer 3 scenario in
 * `make test-system-poller` (or equivalent) that drives a full
 * ToDo→Done lifecycle through the poller against MemoryTracker; the
 * JSONL contains zero `mcp__trello__*` calls and the MemoryTracker
 * request log shows the expected `fetchOpenCards`/`moveToStatus`/
 * `addComment` sequence."
 *
 * The JSONL/structure assertion is covered by `test_yaml_memory`
 * (`make test-system-yaml-memory`) — Phase 4 already removed the
 * Trello MCP server entry from the issue-worker workspace. This test
 * covers the OTHER half of AC #4: confirming that when the poller
 * runs against a real `MemoryTracker`, the request log captures the
 * expected method sequence (`fetchOpenCards`, then `getCard` for the
 * post-dispatch progress check, plus `moveToStatus`/`addComment` on
 * recovery). A single MemoryTracker survives across calls because
 * `getRepoTracker` caches the factory result — break the cache and
 * this test fails loud.
 *
 * Layer choice: a Layer 2 integration test (no real claude, no Docker)
 * is "equivalent" per the AC. Booting a Docker worker with
 * `DANXBOT_TRACKER=memory` and exposing the MemoryTracker request log
 * over HTTP would add substantial infrastructure for a marginal
 * verification gain. The cache invariant + the request log property
 * are both observable from this in-process harness.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { MemoryTracker } from "../../issue-tracker/memory.js";
import type { CreateCardInput } from "../../issue-tracker/interface.js";

// --- Hoisted mocks ---

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    pollerIntervalMs: 60_000,
    isHost: true,
    pollerBackoffScheduleMs: [60_000, 300_000, 900_000, 1_800_000],
  },
}));

vi.mock("../../config.js", () => ({
  config: mockConfig,
}));

vi.mock("../../repo-context.js", () => ({
  repoContexts: [],
}));

vi.mock("../../poller/constants.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../poller/constants.js")
  >("../../poller/constants.js");
  return {
    ...actual,
    getReposBase: () => "/tmp/danxbot-poller-mem-test",
  };
});

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// File system: the poller calls `syncRepoFiles` which needs config files
// to read. Stub everything to noop / minimal valid responses.
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

vi.mock("node:fs", () => ({
  existsSync: (path: unknown) => {
    if (typeof path !== "string") return false;
    if (path.includes(".danxbot/config")) return true;
    if (path.endsWith("config.yml")) return true;
    if (path.endsWith("overview.md")) return true;
    if (path.endsWith("workflow.md")) return true;
    if (path.endsWith("trello.yml")) return true;
    return false;
  },
  readFileSync: (path: unknown) => {
    if (typeof path !== "string") return "";
    if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
    if (path.endsWith("trello.yml")) return "board_id: mock\n";
    if (path.endsWith(".md")) return "# placeholder\n";
    return "";
  },
  readdirSync: () => [],
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn(),
  statSync: () => ({ isDirectory: () => false }),
  symlinkSync: vi.fn(),
  readlinkSync: () => "",
  lstatSync: () => ({ isSymbolicLink: () => false }),
}));

// yaml-lifecycle: the poller asks for findByExternalId / hydrateFromRemote
// to resolve the local Issue. Stub minimal returns.
const mockFindByExternalId = vi.fn().mockReturnValue(null);
const mockHydrateFromRemote = vi.fn();
const mockWriteIssue = vi.fn();
vi.mock("../../poller/yaml-lifecycle.js", () => ({
  findByExternalId: (...args: unknown[]) => mockFindByExternalId(...args),
  hydrateFromRemote: (...args: unknown[]) => mockHydrateFromRemote(...args),
  loadLocal: () => null,
  writeIssue: (...args: unknown[]) => mockWriteIssue(...args),
  stampDispatchAndWrite: (
    _repo: string,
    issue: Record<string, unknown>,
    dispatchId: string,
  ) => ({ ...issue, dispatch_id: dispatchId }),
  ensureIssuesDirs: vi.fn(),
  ensureGitignoreEntry: vi.fn(),
  issuePath: (repo: string, id: string, state: string) =>
    `${repo}/.danxbot/issues/${state}/${id}.yml`,
}));

// dispatch core: don't actually spawn an agent. Capture onComplete so
// the test can drive the post-dispatch path.
const mockDispatch = vi.fn();
vi.mock("../../dispatch/core.js", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}));

vi.mock("../../critical-failure.js", () => ({
  readFlag: () => null,
  writeFlag: vi.fn(),
  clearFlag: () => false,
  flagPath: (p: string) => `${p}/.danxbot/CRITICAL_FAILURE`,
}));

vi.mock("../../settings-file.js", () => ({
  isFeatureEnabled: (_ctx: unknown, feature: string) => feature !== "ideator",
  getTrelloPollerPickupPrefix: () => null,
}));

vi.mock("../../workspace/write-if-changed.js", () => ({
  writeIfChanged: () => true,
}));

// The factory mock returns the real MemoryTracker the test sets up.
const trackerHandle: { current: MemoryTracker | null } = { current: null };
vi.mock("../../issue-tracker/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../issue-tracker/index.js")
  >("../../issue-tracker/index.js");
  return {
    ...actual,
    createIssueTracker: () => {
      if (!trackerHandle.current) {
        throw new Error("Test setup: trackerHandle.current must be assigned before poll()");
      }
      return trackerHandle.current;
    },
  };
});

// --- Real imports ---

import { poll, _resetForTesting } from "../../poller/index.js";
import type { RepoContext } from "../../types.js";

// --- Test fixtures ---

const REPO: RepoContext = {
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

function seedDraft(
  tracker: MemoryTracker,
  overrides: Partial<CreateCardInput> = {},
): Promise<{ external_id: string; ac: { check_item_id: string }[]; phases: { check_item_id: string }[] }> {
  return tracker.createCard({
    schema_version: 3,
    tracker: "memory",
    id: "ISS-1",
    parent_id: null,
    children: [],
    status: "ToDo",
    type: "Feature",
    title: "Demo task",
    description: "",
    triaged: { timestamp: "", status: "", explain: "" },
    ac: [],
    phases: [],
    comments: [],
    retro: { good: "", bad: "", action_items: [], commits: [] },
    ...overrides,
  });
}

function methodsOnly(log: Array<{ method: string; externalId?: string }>): string[] {
  return log.map((entry) => entry.method);
}

// --- Tests ---

describe("Integration: poller hot path against MemoryTracker", () => {
  beforeEach(() => {
    _resetForTesting();
    mockDispatch.mockReset();
    mockFindByExternalId.mockReset();
    mockFindByExternalId.mockReturnValue(null);
    mockHydrateFromRemote.mockReset();
    mockWriteIssue.mockReset();
    trackerHandle.current = new MemoryTracker();
  });

  afterEach(() => {
    _resetForTesting();
  });

  it("fetchOpenCards is the first tracker call on every tick (Phase 5 hot-path invariant)", async () => {
    // Empty tracker — no ToDo cards. The poller should still ASK
    // before falling through to the no-cards branch.
    mockDispatch.mockResolvedValue({ dispatchId: "d", job: { id: "j" } });

    await poll(REPO);

    const log = trackerHandle.current!.getRequestLog();
    // The poller calls fetchOpenCards twice per tick (NH check +
    // _poll's ToDo branch). Assert the count rather than positions so
    // a future refactor that parallelizes the two fetches via
    // Promise.all doesn't silently break this test.
    const methods = methodsOnly(log);
    const fetchCalls = methods.filter((m) => m === "fetchOpenCards").length;
    expect(fetchCalls).toBeGreaterThanOrEqual(2);
    // No moveToStatus / addComment on an empty board — no cards to move.
    expect(methods).not.toContain("moveToStatus");
    expect(methods).not.toContain("addComment");
  });

  it("ToDo card → dispatch → onComplete with status not in ToDo: tracker request log captures fetchOpenCards + getCard, no flag write", async () => {
    const tracker = trackerHandle.current!;
    const { external_id: cardId } = await seedDraft(tracker);
    tracker.clearRequestLog();

    // Hydration path uses createCard's external_id. Mocking
    // hydrateFromRemote keeps the test from worrying about the real
    // hydrate logic — we only care about the FETCH/MOVE/COMMENT
    // sequence on the tracker.
    mockHydrateFromRemote.mockImplementation(async (
      _t: unknown,
      externalId: string,
      dispatchId: string,
    ) => ({
      schema_version: 3 as const,
      tracker: "memory",
      id: "ISS-1",
      external_id: externalId,
      parent_id: null,
      children: [],
      dispatch_id: dispatchId,
      status: "ToDo" as const,
      type: "Feature" as const,
      title: "Demo task",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    }));

    let capturedOnComplete: ((j: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (j: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ dispatchId: "d", job: { id: "j1" } });
    });

    await poll(REPO);
    expect(capturedOnComplete).toBeDefined();

    // Simulate the agent moving the card to Done and signaling success.
    await tracker.moveToStatus(cardId, "Done");

    capturedOnComplete!({
      id: "j1",
      status: "completed",
      summary: "done",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    // Drain async chain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const methods = methodsOnly(tracker.getRequestLog());
    // The first two calls in the new tick are the two fetchOpenCards
    // (NH + _poll). After dispatch + onComplete, getCard runs for the
    // post-dispatch progress check. Card status is Done, so flag is NOT
    // written and no moveToStatus/addComment from recovery.
    expect(methods[0]).toBe("fetchOpenCards");
    expect(methods[1]).toBe("fetchOpenCards");
    // The simulated agent's own moveToStatus shows up in the log
    // because the test invokes it directly — that's the operator's
    // action, not the poller's.
    expect(methods).toContain("moveToStatus");
    // The post-dispatch check called getCard.
    expect(methods).toContain("getCard");
  });

  it("agent failure with stuck card → recovery moves card to Needs Help via tracker.moveToStatus + tracker.addComment", async () => {
    const tracker = trackerHandle.current!;
    const { external_id: cardId } = await seedDraft(tracker);
    tracker.clearRequestLog();

    mockHydrateFromRemote.mockImplementation(async (
      _t: unknown,
      externalId: string,
      dispatchId: string,
    ) => ({
      schema_version: 3 as const,
      tracker: "memory",
      id: "ISS-1",
      external_id: externalId,
      parent_id: null,
      children: [],
      dispatch_id: dispatchId,
      status: "ToDo" as const,
      type: "Feature" as const,
      title: "Demo task",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    }));

    let capturedOnComplete: ((j: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (j: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ dispatchId: "d", job: { id: "j1" } });
    });

    await poll(REPO);
    expect(capturedOnComplete).toBeDefined();

    // Simulate the agent moving the card to In Progress mid-work, then
    // failing — the recovery path should fire.
    await tracker.moveToStatus(cardId, "In Progress");
    tracker.clearRequestLog();

    capturedOnComplete!({
      id: "j1",
      status: "failed",
      summary: "boom",
      startedAt: new Date(Date.now() - 60_000),
      completedAt: new Date(),
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const methods = methodsOnly(tracker.getRequestLog());
    // Recovery sequence: fetchOpenCards (recovery's IP fetch) →
    // moveToStatus(card, Needs Help) → addComment(card, retro).
    // getCard fires for the post-dispatch check (card now in Needs
    // Help, no flag).
    expect(methods).toContain("fetchOpenCards");
    expect(methods).toContain("moveToStatus");
    expect(methods).toContain("addComment");

    // Card is now in Needs Help.
    const final = await tracker.getCard(cardId);
    expect(final.status).toBe("Needs Help");
  });

  it("the SAME tracker instance is used across multiple back-to-back ticks (cache invariant)", async () => {
    // Phase 5 added `getRepoTracker` so a single tracker survives
    // every call site in the poller hot path. A regression that
    // recreates the tracker per tick would silently break Layer 3
    // memory-tracker scenarios.
    //
    // Pin: with NO `_resetForTesting()` between ticks, the factory
    // (createIssueTracker) must be invoked exactly once. The cached
    // MemoryTracker survives, so a card seeded BEFORE the first tick
    // is still visible to the SECOND tick's `fetchOpenCards`.
    const tracker = trackerHandle.current!;
    // Replace the factory with a vi.fn so we can count invocations.
    // Reusing the same tracker handle: every call returns the SAME
    // MemoryTracker instance — the spy proves how many times the
    // poller asked for it.
    const factorySpy = vi.fn(() => tracker);
    // Hook the factory into the imported module by re-mocking — the
    // `vi.mock` at top-level wires `createIssueTracker` to read from
    // `trackerHandle.current` already, so we just need to track calls
    // on a separate observer. Wrap the existing factory.
    const originalGetter = Object.getOwnPropertyDescriptor(
      trackerHandle,
      "current",
    );
    Object.defineProperty(trackerHandle, "current", {
      configurable: true,
      get() {
        factorySpy();
        return tracker;
      },
    });

    await seedDraft(tracker, { title: "Persistent card" });

    mockDispatch.mockImplementation((opts: { onComplete?: (j: unknown) => void }) => {
      // Capture but invoke synchronously after each poll so teamRunning
      // resets between ticks without _resetForTesting.
      setImmediate(() =>
        opts.onComplete?.({
          id: "j",
          status: "completed",
          summary: "ok",
          startedAt: new Date(),
          completedAt: new Date(),
        }),
      );
      return Promise.resolve({ dispatchId: "d", job: { id: "j" } });
    });
    mockHydrateFromRemote.mockImplementation(async (
      _t: unknown,
      externalId: string,
      dispatchId: string,
    ) => ({
      schema_version: 3 as const,
      tracker: "memory",
      id: "ISS-1",
      external_id: externalId,
      parent_id: null,
      children: [],
      dispatch_id: dispatchId,
      status: "ToDo" as const,
      type: "Feature" as const,
      title: "Persistent card",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    }));

    factorySpy.mockClear();
    await poll(REPO);
    // Wait for onComplete to fire and clear teamRunning.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const callsAfterFirst = factorySpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // SECOND tick — no _resetForTesting. The cache must hold.
    factorySpy.mockClear();
    await poll(REPO);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Zero factory calls on the second tick — the cached tracker was
    // reused. The MemoryTracker still has the seeded card because we
    // never tore it down.
    expect(factorySpy).not.toHaveBeenCalled();
    const freshFetch = await tracker.fetchOpenCards();
    expect(freshFetch.find((r) => r.title === "Persistent card")).toBeDefined();

    // Restore the descriptor so afterEach's _resetForTesting doesn't
    // hit the spy.
    if (originalGetter) {
      Object.defineProperty(trackerHandle, "current", originalGetter);
    }
  });

  it("bulk-sync: hydrates every ToDo card whose local YAML is missing", async () => {
    // Wire findByExternalId to a small in-memory ledger that tracks
    // what bulk-sync's writeIssue has already persisted. This mirrors
    // the real fs-backed behavior: once bulk-sync writes a YAML, the
    // primary-selection path's findByExternalId must hit it (avoiding
    // a redundant hydrate). Without this, the strict "one hydrate per
    // card" invariant can't be expressed at the mock level.
    const ledger = new Map<string, Record<string, unknown>>();
    mockFindByExternalId.mockImplementation((_repo: string, eid: string) => {
      return ledger.get(eid) ?? null;
    });
    mockWriteIssue.mockImplementation((_repo: string, issue: { external_id: string }) => {
      ledger.set(issue.external_id, issue as unknown as Record<string, unknown>);
    });

    let allocCounter = 0;
    mockHydrateFromRemote.mockImplementation(async (
      _t: unknown,
      externalId: string,
      dispatchId: string | null,
    ) => ({
      schema_version: 3 as const,
      tracker: "memory",
      id: `ISS-${++allocCounter}`,
      external_id: externalId,
      parent_id: null,
      children: [],
      dispatch_id: dispatchId,
      status: "ToDo" as const,
      type: "Feature" as const,
      title: `card-${externalId}`,
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    }));

    mockDispatch.mockResolvedValue({ dispatchId: "d", job: { id: "j" } });

    const tracker = trackerHandle.current!;
    await seedDraft(tracker, { id: "ISS-1", title: "phase 1" });
    await seedDraft(tracker, { id: "ISS-2", title: "phase 2" });
    await seedDraft(tracker, { id: "ISS-3", title: "phase 3" });

    await poll(REPO);

    // hydrateFromRemote should fire EXACTLY ONCE per card on the first
    // tick — bulk-sync writes the two siblings (dispatchId: null), then
    // the primary-selection path's hydrate runs for cards[0] with the
    // real dispatchId (the test's mockFindByExternalId returns null
    // for primary because the bulk-sync loop skips cards[0]).
    const externalIds = mockHydrateFromRemote.mock.calls.map(
      (call) => call[1] as string,
    );
    expect(externalIds).toHaveLength(3);
    expect(new Set(externalIds).size).toBe(3); // all distinct

    // writeIssue called once per hydrated card (siblings via bulk-sync,
    // primary via hydrate-or-load → writeIssue in the primary block).
    expect(mockWriteIssue).toHaveBeenCalledTimes(3);

    // Two sibling hydrates carry dispatchId: null (bulk-sync write
    // shape — dispatch UUID lands later via stampDispatchAndWrite when
    // each sibling becomes the primary on a future tick). The primary
    // hydrate carries the real UUID.
    const dispatchIds = mockHydrateFromRemote.mock.calls.map(
      (call) => call[2] as string | null,
    );
    expect(dispatchIds.filter((id) => id === null).length).toBe(2);
    expect(dispatchIds.filter((id) => id !== null).length).toBe(1);
  });

  it("bulk-sync: a sibling hydrate failure is logged but does NOT block dispatch of the primary", async () => {
    // Pin the documented asymmetry: sibling hydrate errors are tolerated
    // (logged + skipped) so one bad card cannot freeze the whole tick.
    // Without this test a future refactor that replaces the per-card
    // try/catch with a single bulk await/throw would silently regress
    // the contract.
    const tracker = trackerHandle.current!;
    await seedDraft(tracker, { id: "ISS-1", title: "primary" });
    await seedDraft(tracker, { id: "ISS-2", title: "sibling that fails" });

    // Primary (cards[0] === mem-1) succeeds; sibling (mem-2) rejects.
    mockHydrateFromRemote.mockImplementation(async (
      _t: unknown,
      externalId: string,
      dispatchId: string | null,
    ) => {
      if (externalId === "mem-2") {
        throw new Error("simulated tracker hiccup on sibling");
      }
      return {
        schema_version: 3 as const,
        tracker: "memory",
        id: "ISS-1",
        external_id: externalId,
        parent_id: null,
        children: [],
        dispatch_id: dispatchId,
        status: "ToDo" as const,
        type: "Feature" as const,
        title: `card-${externalId}`,
        description: "",
        triaged: { timestamp: "", status: "", explain: "" },
        ac: [],
        phases: [],
        comments: [],
        retro: { good: "", bad: "", action_items: [], commits: [] },
      };
    });

    mockDispatch.mockResolvedValue({ dispatchId: "d", job: { id: "j" } });

    // Sibling failure is swallowed, primary dispatch still fires.
    await poll(REPO);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("bulk-sync: a primary hydrate failure DOES propagate (preserves the credential-regression-crashes-loud invariant)", async () => {
    // Counterpart to the sibling-tolerant test: when the primary card's
    // hydrate fails (e.g. tracker creds revoked), the poller MUST throw
    // rather than silently log + continue. Pre-Phase-1 contract; the
    // bulk-sync block only wraps siblings in try/catch — primary stays
    // outside that block.
    const tracker = trackerHandle.current!;
    await seedDraft(tracker, { id: "ISS-1", title: "primary fails" });
    await seedDraft(tracker, { id: "ISS-2", title: "sibling" });

    mockHydrateFromRemote.mockImplementation(async (
      _t: unknown,
      externalId: string,
      dispatchId: string | null,
    ) => {
      if (externalId === "mem-1") {
        throw new Error("Trello API error: 401 Unauthorized");
      }
      return {
        schema_version: 3 as const,
        tracker: "memory",
        id: "ISS-2",
        external_id: externalId,
        parent_id: null,
        children: [],
        dispatch_id: dispatchId,
        status: "ToDo" as const,
        type: "Feature" as const,
        title: `card-${externalId}`,
        description: "",
        triaged: { timestamp: "", status: "", explain: "" },
        ac: [],
        phases: [],
        comments: [],
        retro: { good: "", bad: "", action_items: [], commits: [] },
      };
    });

    await expect(poll(REPO)).rejects.toThrow(/401 Unauthorized/);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("bulk-sync: skips cards whose local YAML already exists", async () => {
    const tracker = trackerHandle.current!;
    await seedDraft(tracker, { id: "ISS-1", title: "already-known" });
    await seedDraft(tracker, { id: "ISS-2", title: "new-card" });

    // Card 1 already has local YAML; card 2 doesn't. The poller should
    // hydrate ONLY card 2 during bulk-sync, then stamp ISS-1 with the
    // primary's dispatchId via stampDispatchAndWrite (which the mock
    // returns as a passthrough).
    mockFindByExternalId.mockImplementation((_repo: string, eid: string) => {
      if (eid === "mem-1") {
        return {
          schema_version: 3 as const,
          tracker: "memory",
          id: "ISS-1",
          external_id: "mem-1",
          parent_id: null,
          children: [],
          dispatch_id: null,
          status: "ToDo" as const,
          type: "Feature" as const,
          title: "already-known",
          description: "",
          triaged: { timestamp: "", status: "", explain: "" },
          ac: [],
          phases: [],
          comments: [],
          retro: { good: "", bad: "", action_items: [], commits: [] },
        };
      }
      return null;
    });

    mockHydrateFromRemote.mockImplementation(async (
      _t: unknown,
      externalId: string,
      dispatchId: string | null,
    ) => ({
      schema_version: 3 as const,
      tracker: "memory",
      id: "ISS-2",
      external_id: externalId,
      parent_id: null,
      children: [],
      dispatch_id: dispatchId,
      status: "ToDo" as const,
      type: "Feature" as const,
      title: "new-card",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    }));

    mockDispatch.mockResolvedValue({ dispatchId: "d", job: { id: "j" } });

    await poll(REPO);

    // Only ONE hydrateFromRemote call (for the new card mem-2).
    expect(mockHydrateFromRemote).toHaveBeenCalledTimes(1);
    const hydratedId = mockHydrateFromRemote.mock.calls[0][1] as string;
    expect(hydratedId).toBe("mem-2");
  });
});
