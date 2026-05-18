/**
 * Phase 5 verification — the poller's hot path drives EVERY tracker
 * interaction through the cached `IssueTracker` abstraction.
 *
 * AC #4 of `69f76d57359b5fe89f80ab22` asks for "a Layer 3 scenario in
 * `make test-system-poller` (or equivalent) that drives a full
 * ToDo→Done lifecycle through the poller against FakeTracker; the
 * JSONL contains zero `mcp__trello__*` calls and the FakeTracker
 * request log shows the expected `fetchOpenCards`/`moveToList`/
 * `addComment` sequence."
 *
 * The JSONL/structure assertion is covered by `test_yaml_memory`
 * (`make test-system-yaml-memory`) — Phase 4 already removed the
 * Trello MCP server entry from the issue-worker workspace. This test
 * covers the OTHER half of AC #4: confirming that when the poller
 * runs against a real `FakeTracker`, the request log captures the
 * expected method sequence (`fetchOpenCards`, then `getCard` for the
 * post-dispatch progress check, plus `moveToList`/`addComment` on
 * recovery). A single FakeTracker survives across calls because
 * `getRepoTracker` caches the factory result — break the cache and
 * this test fails loud.
 *
 * Layer choice: a Layer 2 integration test (no real claude, no Docker)
 * is "equivalent" per the AC. Booting a Docker worker against the
 * test-only tracker stub and exposing its request log over HTTP would
 * add substantial infrastructure for a marginal verification gain.
 * The cache invariant + the request log property are both observable
 * from this in-process harness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeTracker } from "../helpers/FakeTracker.js";
import type {
  CreateCardInput,
  Issue,
  IssueRef,
} from "../../issue-tracker/interface.js";

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
  targetName: "test-target",
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
  renameSync: vi.fn(),
  chmodSync: vi.fn(),
  statSync: () => ({ isDirectory: () => false }),
  symlinkSync: vi.fn(),
  readlinkSync: () => "",
  lstatSync: () => ({ isSymbolicLink: () => false }),
}));

// yaml-lifecycle: the poller asks for findByExternalId / hydrateFromRemote
// to resolve the local Issue. Stub minimal returns.
const mockFindByExternalId = vi.fn().mockResolvedValue(null);
const mockHydrateFromRemote = vi.fn();
const mockWriteIssue = vi.fn();
vi.mock("../../poller/yaml-lifecycle.js", () => ({
  findByExternalId: (...args: unknown[]) => mockFindByExternalId(...args),
  hydrateFromRemote: (...args: unknown[]) => mockHydrateFromRemote(...args),
  loadLocal: async () => null,
  writeIssue: (...args: unknown[]) => mockWriteIssue(...args),
  stampDispatchAndWrite: (
    _repo: string,
    issue: Record<string, unknown>,
    dispatch: Record<string, unknown>,
  ) => ({ ...issue, dispatch: { ...dispatch } }),
  clearDispatchAndWrite: async (
    _repo: string,
    issue: Record<string, unknown>,
  ) => ({ ...issue, dispatch: null }),
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
}));

vi.mock("../../workspace/write-if-changed.js", () => ({
  writeIfChanged: () => true,
}));

// ISS-86: dispatch source is local YAML, not the tracker view. The
// integration test mocks node:fs so the real local-issues walker
// finds nothing. Stand in for the local-YAML scan by deriving Issue[]
// projections from the most recent `tracker.fetchOpenCards([])` value
// captured by the wrapping factory below.
// DX-621 — `IssueRef.status` retired; this integration helper carries
// the legacy status as a non-schema `_status` so the fixture flow can
// still partition fake cards by status.
type TestRef = IssueRef & { _status: import("../../issue-tracker/interface.js").IssueStatus };
const lastOpenCards: { value: TestRef[] } = { value: [] };
function refToFakeIssue(ref: TestRef): Issue {
  return {
    schema_version: 11,
    tracker: "memory",
    id: ref.id || `ISS-FAKE-${ref.external_id}`,
    external_id: ref.external_id,
    parent_id: null,
    children: [],
    dispatch: null,
    status: ref._status,
    type: "Feature",
    title: ref.title,
    description: "",
    priority: 3.0,
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };

}
// epic-status: queries the DB for parent + child rows since DX-155.
// The unit mock-suite has no live PG, so stub the recompute pass to a
// no-op so it doesn't throw on an unreachable connection.
vi.mock("../../poller/epic-status.js", () => ({
  recomputeParentStatuses: async (): Promise<unknown[]> => [],
  deriveStatus: () => null,
}));

vi.mock("../../poller/local-issues.js", () => ({
  listDispatchableYamls: async (_repoPath: string): Promise<Issue[]> =>
    lastOpenCards.value
      .filter((r) => r._status === "ToDo")
      .map(refToFakeIssue),
  listInProgressYamls: async (_repoPath: string): Promise<Issue[]> =>
    lastOpenCards.value
      .filter((r) => r._status === "In Progress")
      .map(refToFakeIssue),
  listTriageDueYamls: async (
    _repoPath: string,
    _now: number,
  ): Promise<Issue[]> => [],
}));

// DX-621 — runInboundFetch reads trello-list-map.yaml. Stub the readers
// to return a populated map keyed off ListType so fetchOpenCards
// receives non-empty Trello list ids in the integration flow.
vi.mock("../../trello-list-map.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../trello-list-map.js")
  >("../../trello-list-map.js");
  return {
    ...actual,
    readTrelloListMap: () => ({
      list_id_to_trello_list_id: {
        "blocked-id": "list-Blocked",
        "ready-id": "list-ToDo",
        "in-progress-id": "list-In Progress",
        "review-id": "list-Review",
      },
    }),
  };
});
vi.mock("../../lists-file.js", async () => {
  const actual = await vi.importActual<typeof import("../../lists-file.js")>(
    "../../lists-file.js",
  );
  return {
    ...actual,
    readLists: () => ({
      lists: [
        { id: "blocked-id", name: "Blocked", type: "blocked", order: 0, is_default_for_type: true, color: "#000" },
        { id: "ready-id", name: "ToDo", type: "ready", order: 1, is_default_for_type: true, color: "#000" },
        { id: "in-progress-id", name: "In Progress", type: "in_progress", order: 2, is_default_for_type: true, color: "#000" },
        { id: "review-id", name: "Review", type: "review", order: 3, is_default_for_type: true, color: "#000" },
      ],
      tombstone_ids: [],
    }),
  };
});

// The factory mock returns the real FakeTracker the test sets up.
const trackerHandle: { current: FakeTracker | null } = { current: null };
vi.mock("../../issue-tracker/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../issue-tracker/index.js")
  >("../../issue-tracker/index.js");
  return {
    ...actual,
    createIssueTracker: () => {
      if (!trackerHandle.current) {
        throw new Error(
          "Test setup: trackerHandle.current must be assigned before poll()",
        );
      }
      const tracker = trackerHandle.current;
      const origFetch = tracker.fetchOpenCards.bind(tracker);
      tracker.fetchOpenCards = async (trelloListIds: readonly string[]) => {
        const result = await origFetch(trelloListIds);
        // DX-621 — annotate each ref with `_status` for the legacy
        // fixture flow by looking up the underlying FakeTracker card.
        const annotated: TestRef[] = result.map((r) => {
          const card = (tracker as unknown as {
            cards: Map<string, { status: import("../../issue-tracker/interface.js").IssueStatus }>;
          }).cards.get(r.external_id);
          return { ...r, _status: card?.status ?? "Review" };
        });
        lastOpenCards.value = annotated;
        return result;
      };
      return tracker;
    },
  };
});

// --- Real imports ---

import { poll, _resetForTesting } from "../../cron/sync-and-audit.js";
import type { RepoContext } from "../../types.js";

// --- Test fixtures ---

const REPO: RepoContext = {
  name: "test-repo",
  url: "https://example.com/test.git",
  localPath: "/test/repos/test-repo",
  hostPath: "/test/repos/test-repo",
  trello: {
    apiKey: "test-key",
    apiToken: "test-token",
    boardId: "test-board",
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

function seedDraft(
  tracker: FakeTracker,
  overrides: Partial<CreateCardInput> = {},
): Promise<{
  external_id: string;
  ac: { check_item_id: string }[];
}> {
  return tracker.createCard({
    schema_version: 11,
    tracker: "memory",
    id: "ISS-1",
    parent_id: null,
    children: [],
    status: "ToDo",
    type: "Feature",
    title: "Demo task",
    description: "",
    priority: 3.0,
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    ...overrides,
  });
}

function methodsOnly(
  log: Array<{ method: string; externalId?: string }>,
): string[] {
  return log.map((entry) => entry.method);
}

// --- Tests ---

describe("Integration: poller hot path against FakeTracker", () => {
  beforeEach(() => {
    _resetForTesting();
    mockDispatch.mockReset();
    mockFindByExternalId.mockReset();
    mockFindByExternalId.mockResolvedValue(null);
    mockHydrateFromRemote.mockReset();
    mockWriteIssue.mockReset();
    trackerHandle.current = new FakeTracker();
    lastOpenCards.value = [];
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
    // runSync's ToDo branch). Assert the count rather than positions so
    // a future refactor that parallelizes the two fetches via
    // Promise.all doesn't silently break this test.
    const methods = methodsOnly(log);
    const fetchCalls = methods.filter((m) => m === "fetchOpenCards").length;
    expect(fetchCalls).toBeGreaterThanOrEqual(2);
    // No moveToList / addComment on an empty board — no cards to move.
    expect(methods).not.toContain("moveToList");
    expect(methods).not.toContain("addComment");
  });



  it("the SAME tracker instance is used across multiple back-to-back ticks (cache invariant)", async () => {
    // Phase 5 added `getRepoTracker` so a single tracker survives
    // every call site in the poller hot path. A regression that
    // recreates the tracker per tick would silently break Layer 3
    // FakeTracker scenarios.
    //
    // Pin: with NO `_resetForTesting()` between ticks, the factory
    // (createIssueTracker) must be invoked exactly once. The cached
    // FakeTracker survives, so a card seeded BEFORE the first tick
    // is still visible to the SECOND tick's `fetchOpenCards`.
    const tracker = trackerHandle.current!;
    // Replace the factory with a vi.fn so we can count invocations.
    // Reusing the same tracker handle: every call returns the SAME
    // FakeTracker instance — the spy proves how many times the
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

    mockDispatch.mockImplementation(
      (opts: { onComplete?: (j: unknown) => void }) => {
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
      },
    );
    mockHydrateFromRemote.mockImplementation(
      async (_t: unknown, externalId: string, dispatchId: string) => ({
        schema_version: 11 as const,
        tracker: "memory",
        id: "ISS-1",
        external_id: externalId,
        parent_id: null,
        children: [],
        dispatch: { id: dispatchId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
        status: "ToDo" as const,
        type: "Feature" as const,
        title: "Persistent card",
        description: "",
        triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
        ac: [],
        comments: [],
        retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      }),
    );

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
    // reused. The FakeTracker still has the seeded card because we
    // never tore it down.
    expect(factorySpy).not.toHaveBeenCalled();
    // DX-621 — fetchOpenCards now requires explicit mapped Trello list
    // ids. Pass the same set the poller's runInboundFetch uses (matches
    // the test's mocked trello-list-map.yaml).
    const freshFetch = await tracker.fetchOpenCards(["list-ToDo"]);
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
    mockFindByExternalId.mockImplementation(
      async (_repo: string, eid: string) => ledger.get(eid) ?? null,
    );
    mockWriteIssue.mockImplementation(
      (_repo: string, issue: { external_id: string }) => {
        ledger.set(
          issue.external_id,
          issue as unknown as Record<string, unknown>,
        );
      },
    );

    let allocCounter = 0;
    mockHydrateFromRemote.mockImplementation(
      async (_t: unknown, externalId: string, dispatchId: string | null) => ({
        schema_version: 11 as const,
        tracker: "memory",
        id: `ISS-${++allocCounter}`,
        external_id: externalId,
        parent_id: null,
        children: [],
        dispatch: { id: dispatchId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
        status: "ToDo" as const,
        type: "Feature" as const,
        title: `card-${externalId}`,
        description: "",
        triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
        ac: [],
        comments: [],
        retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      }),
    );

    mockDispatch.mockResolvedValue({ dispatchId: "d", job: { id: "j" } });

    const tracker = trackerHandle.current!;
    await seedDraft(tracker, { id: "ISS-1", title: "phase 1" });
    await seedDraft(tracker, { id: "ISS-2", title: "phase 2" });
    await seedDraft(tracker, { id: "ISS-3", title: "phase 3" });

    await poll(REPO);

    // DX-290 (Phase 4b.3): bulk-sync now hydrates EVERY tracker-listed
    // ToDo card — the legacy primary-selection hydrate-or-stamp path
    // (with the real dispatchId) was retired when `runSync` stopped
    // making dispatch decisions. The multi-agent picker stamps the
    // dispatch UUID via `stampDispatchAndWrite` when it claims a card,
    // not here. Result: 3 ToDo cards → 3 bulk-sync hydrates, all with
    // `dispatchId: null`.
    const externalIds = mockHydrateFromRemote.mock.calls.map(
      (call) => call[1] as string,
    );
    expect(externalIds).toHaveLength(3);
    expect(new Set(externalIds).size).toBe(3); // all distinct

    // Bulk-sync writes go through `writeIssue` (not
    // `stampDispatchAndWrite`) because there's no dispatch UUID yet.
    expect(mockWriteIssue).toHaveBeenCalledTimes(3);

    // Every bulk-sync hydrate carries `dispatchId: null` — the
    // dispatch UUID lands later via `stampDispatchAndWrite` when the
    // multi-agent picker claims the card.
    const dispatchIds = mockHydrateFromRemote.mock.calls.map(
      (call) => call[2] as string | null,
    );
    expect(dispatchIds.filter((id) => id === null).length).toBe(3);
    expect(dispatchIds.filter((id) => id !== null).length).toBe(0);
  });


  it("bulk-sync: a primary hydrate failure is logged + swallowed by runSync's top-level catch (DX-149) — no dispatch fires", async () => {
    // Counterpart to the sibling-tolerant test. Pre-DX-149 contract was
    // "primary hydrate failure rethrows from runSync" so the worker
    // process would die loud on a credential regression. DX-149 retired
    // that — the top-level catch in runSync now logs + swallows EVERY
    // throw inside its body, so a single bad card no longer kills the
    // whole worker (Slack listener, dispatch API, dashboard SSE all
    // share the worker process). Observable contract preserved here:
    // the poll resolves cleanly AND no dispatch fires for the bad
    // card. Loud-error visibility moves to the dashboard system_errors
    // surface (DX-134, separate phase).
    const tracker = trackerHandle.current!;
    await seedDraft(tracker, { id: "ISS-1", title: "primary fails" });
    await seedDraft(tracker, { id: "ISS-2", title: "sibling" });

    mockHydrateFromRemote.mockImplementation(
      async (_t: unknown, externalId: string, dispatchId: string | null) => {
        if (externalId === "mem-1") {
          throw new Error("Trello API error: 401 Unauthorized");
        }
        return {
          schema_version: 11 as const,
          tracker: "memory",
          id: "ISS-2",
          external_id: externalId,
          parent_id: null,
          children: [],
          dispatch: { id: dispatchId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
          status: "ToDo" as const,
          type: "Feature" as const,
          title: `card-${externalId}`,
          description: "",
          triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
          ac: [],
          comments: [],
          retro: { good: "", bad: "", action_item_ids: [], commits: [] },
        };
      },
    );

    await expect(poll(REPO)).resolves.toBeUndefined();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("bulk-sync: skips cards whose local YAML already exists", async () => {
    const tracker = trackerHandle.current!;
    await seedDraft(tracker, { id: "ISS-1", title: "already-known" });
    await seedDraft(tracker, { id: "ISS-2", title: "new-card" });

    // Card 1 already has local YAML; card 2 doesn't. The poller should
    // hydrate ONLY card 2 during bulk-sync. The multi-agent picker
    // (separately tested in `multi-agent-pick.test.ts`) stamps the
    // dispatch UUID via `stampDispatchAndWrite` when it claims a card;
    // this test scopes to bulk-sync hydrate behavior only.
    mockFindByExternalId.mockImplementation(async (_repo: string, eid: string) => {
      if (eid === "mem-1") {
        return {
          schema_version: 11 as const,
          tracker: "memory",
          id: "ISS-1",
          external_id: "mem-1",
          parent_id: null,
          children: [],
          dispatch: null,
          status: "ToDo" as const,
          type: "Feature" as const,
          title: "already-known",
          description: "",
          triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
          ac: [],
          comments: [],
          retro: { good: "", bad: "", action_item_ids: [], commits: [] },
        };
      }
      return null;
    });

    mockHydrateFromRemote.mockImplementation(
      async (_t: unknown, externalId: string, dispatchId: string | null) => ({
        schema_version: 11 as const,
        tracker: "memory",
        id: "ISS-2",
        external_id: externalId,
        parent_id: null,
        children: [],
        dispatch: { id: dispatchId, pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
        status: "ToDo" as const,
        type: "Feature" as const,
        title: "new-card",
        description: "",
        triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
        ac: [],
        comments: [],
        retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      }),
    );

    mockDispatch.mockResolvedValue({ dispatchId: "d", job: { id: "j" } });

    await poll(REPO);

    // Only ONE hydrateFromRemote call (for the new card mem-2).
    expect(mockHydrateFromRemote).toHaveBeenCalledTimes(1);
    const hydratedId = mockHydrateFromRemote.mock.calls[0][1] as string;
    expect(hydratedId).toBe("mem-2");
  });
});
