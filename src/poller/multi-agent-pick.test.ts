import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resetAgentLocksQueryFn,
  setAgentLocksQueryFn,
} from "../agent/agent-locks.js";

vi.mock("../dispatch/core.js", () => ({
  dispatch: vi.fn(),
}));
vi.mock("../dispatch/recovery-mode.js", () => ({
  dispatchWithRecovery: vi.fn(),
}));
vi.mock("../dispatch/conflict-check.js", () => ({
  runConflictCheck: vi.fn(),
}));
// Stub the scheduler module so the multi-agent test doesn't drag in
// the DB connection chain (`dashboard/dispatches-db.js` →
// `db/connection.js` hard-requires DANXBOT_DB_*). The scheduler is the
// single API surface for dispatch-time protections — `multi-agent-pick`
// imports the lock helpers from here too, so the mock must re-route
// `buildLockHolderInfo`/`tryAcquireLock` to the real implementations
// from `../issue-tracker/lock.js` (which has no DB-chain transitive
// load). Defaults match the legacy path: no live PID, no-op post-
// dispatch check.
vi.mock("../dispatch/scheduler.js", async () => {
  const lock = await vi.importActual<typeof import("../issue-tracker/lock.js")>(
    "../issue-tracker/lock.js",
  );
  return {
    guardLiveDispatchForCard: vi.fn().mockResolvedValue(false),
    runPostDispatchProgressCheck: vi.fn().mockResolvedValue(undefined),
    buildLockHolderInfo: lock.buildLockHolderInfo,
    tryAcquireLock: lock.tryAcquireLock,
    releaseLock: lock.releaseLock,
  };
});
vi.mock("../agent/worktree-manager.js", () => ({
  createWorktreeManager: vi.fn().mockReturnValue({
    worktreePath: vi
      .fn()
      .mockImplementation(
        (_repo: { localPath: string }, agentName: string) =>
          `${_repo.localPath}/.danxbot/worktrees/${agentName}`,
      ),
    bootstrap: vi.fn(),
    teardown: vi.fn(),
    validate: vi.fn().mockResolvedValue({ state: "clean" }),
    syncWorktree: vi.fn().mockResolvedValue({ kind: "noop" }),
    ensureProvisioned: vi.fn(),
    fetchOrigin: vi.fn().mockResolvedValue(true),
  }),
}));
vi.mock("./yaml-lifecycle.js", async () => {
  const actual = await vi.importActual<typeof import("./yaml-lifecycle.js")>(
    "./yaml-lifecycle.js",
  );
  return {
    ...actual,
    stampAssignedAgentAndWrite: vi.fn(async (_p, issue, name) => ({
      ...issue,
      assigned_agent: name,
    })),
    stampDispatchAndWrite: vi.fn(async (_p, issue, dispatchOrId) => ({
      ...issue,
      dispatch:
        typeof dispatchOrId === "string"
          ? {
              id: dispatchOrId,
              pid: 0,
              host: "",
              kind: "work" as const,
              started_at: "",
              ttl_seconds: 0,
            }
          : dispatchOrId,
    })),
    clearDispatchAndWrite: vi.fn(async (_p, issue) => ({
      ...issue,
      dispatch: null,
      assigned_agent: null,
    })),
    loadLocal: vi.fn(async () => null),
    loadLocalFromDisk: vi.fn(() => null),
    writeIssue: vi.fn(async () => undefined),
  };
});

import { tryMultiAgentDispatch } from "./multi-agent-pick.js";
import { renderLockComment } from "../issue-tracker/lock.js";
import { runConflictCheck } from "../dispatch/conflict-check.js";
import { dispatchWithRecovery } from "../dispatch/recovery-mode.js";
import {
  guardLiveDispatchForCard,
  runPostDispatchProgressCheck,
} from "../dispatch/scheduler.js";
import {
  clearDispatchAndWrite,
  loadLocal,
  loadLocalFromDisk,
  stampAssignedAgentAndWrite,
} from "./yaml-lifecycle.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";

/**
 * Lock-acquire stub for the multi-agent path (DX-241). Tests in this
 * file assert agent picking + dispatch wiring; the tracker-comment
 * lock is exercised in `src/__tests__/issue-tracker/lock.test.ts`. The
 * stub always grants the lock so the loop reaches the dispatch call —
 * a separate test below covers the lock-refusal branch explicitly.
 */
function fakeTracker(): IssueTracker {
  return {
    fetchOpenCards: async () => [],
    isValidExternalId: () => true,
    getCard: async () => {
      throw new Error("getCard not used in multi-agent-pick.test.ts");
    },
    createCard: async () => ({ external_id: "", ac: [] }),
    updateCard: async () => {},
    moveToStatus: async () => {},
    setLabels: async () => {},
    addComment: async () => ({ id: "lock-cmt", timestamp: "" }),
    editComment: async () => {},
    getComments: async () => [],
    addAcItem: async () => ({ check_item_id: "" }),
    updateAcItem: async () => {},
    deleteAcItem: async () => {},
  };
}

let tmpRepo: string;

const mockedDispatchWithRecovery = vi.mocked(dispatchWithRecovery);
const mockedRunConflictCheck = vi.mocked(runConflictCheck);

function writeSettings(agents: Record<string, unknown>, conflictCheckEnabled?: boolean): void {
  const settingsPath = join(tmpRepo, ".danxbot/settings.json");
  mkdirSync(join(tmpRepo, ".danxbot"), { recursive: true });
  const body: Record<string, unknown> = {
    overrides: {
      slack: { enabled: null },
      issuePoller: { enabled: null, pickupNamePrefix: null },
      dispatchApi: { enabled: null },
      ideator: { enabled: null },
      autoTriage: { enabled: null },
    },
    display: {},
    agents,
    meta: { updatedAt: new Date().toISOString(), updatedBy: "worker" },
  };
  if (conflictCheckEnabled !== undefined) {
    body.agentDefaults = { conflictCheckEnabled };
  }
  writeFileSync(settingsPath, JSON.stringify(body, null, 2));
}

function alwaysOpenSchedule() {
  return {
    tz: "America/Chicago",
    mon: ["00:00-23:59"],
    tue: ["00:00-23:59"],
    wed: ["00:00-23:59"],
    thu: ["00:00-23:59"],
    fri: ["00:00-23:59"],
    sat: ["00:00-23:59"],
    sun: ["00:00-23:59"],
  };
}

function agentRecord(name: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    bio: `I am ${name}.`,
    capabilities: ["issue-worker"],
    schedule: alwaysOpenSchedule(),
    enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakeRepo(): RepoContext {
  return {
    name: "danxbot",
    localPath: tmpRepo,
    issuePrefix: "DX",
    workerPort: 5562,
    trello: { todoListId: "todo-list-id" },
  } as unknown as RepoContext;
}

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 7,
    tracker: "memory",
    id,
    external_id: `ext-${id}`,
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: id,
    description: "",
    priority: 3.0,
    position: null,
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
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    history: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), "multi-agent-pick-"));
  setAgentLocksQueryFn(async () => [] as never);
  vi.clearAllMocks();
});

afterEach(() => {
  resetAgentLocksQueryFn();
  rmSync(tmpRepo, { recursive: true, force: true });
});

const NOW = new Date("2026-04-20T15:00:00Z");

describe("tryMultiAgentDispatch", () => {
  it("returns 0 dispatched when no agents are configured (no-op)", async () => {
    writeSettings({});
    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(0);
    expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
  });

  it("dispatches three free agents to three disjoint cards in one tick", async () => {
    writeSettings({
      alice: agentRecord("alice"),
      bob: agentRecord("bob"),
      charlie: agentRecord("charlie"),
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const cards = [issue("DX-1"), issue("DX-2"), issue("DX-3")];
    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards,
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(3);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(3);
    // Every dispatched call carries an `agent` persona block.
    for (const call of mockedDispatchWithRecovery.mock.calls) {
      const [input, worktree] = call;
      expect(input.agent).toBeDefined();
      expect(worktree.agentName).toMatch(/^(alice|bob|charlie)$/);
    }
  });

  it("conflict-check ok=true → all candidates dispatched", async () => {
    writeSettings({
      alice: agentRecord("alice"),
      bob: agentRecord("bob"),
    });
    // DX-262 follow-up — picker now intersects `inProgress` with the
    // live-dispatch set before calling conflict-check. Tell the SQL
    // handler that DX-99 has a live dispatch so the conflict-check
    // path actually fires.
    setAgentLocksQueryFn(async (sql) => {
      if (sql.includes("FROM dispatches") && sql.includes("issue_id")) {
        return [{ issue_id: "DX-99" }] as never;
      }
      return [] as never;
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    mockedRunConflictCheck.mockResolvedValue({ kind: "ok", reason: "no overlap" });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1"), issue("DX-2")],
      inProgress: [issue("DX-99", { status: "In Progress" })],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(2);
    expect(result.conflictBlocked).toBe(0);
    expect(mockedRunConflictCheck).toHaveBeenCalledTimes(2);
  });

  it("conflict-check ok=false → candidate is blocked, NOT dispatched", async () => {
    writeSettings({
      alice: agentRecord("alice"),
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    mockedRunConflictCheck.mockResolvedValue({
      kind: "conflict",
      reason: "overlaps with launcher.ts",
      partners: [{ id: "DX-141", reason: "shared launcher fn" }],
    });

    const yl = await import("./yaml-lifecycle.js");
    vi.mocked(yl.loadLocal).mockResolvedValue(issue("DX-1"));

    // DX-262 follow-up — picker only consults conflict-check when the
    // YAML's in-progress status is backed by a LIVE dispatch row.
    setAgentLocksQueryFn(async (sql) => {
      if (sql.includes("FROM dispatches") && sql.includes("issue_id")) {
        return [{ issue_id: "DX-141" }] as never;
      }
      return [] as never;
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [issue("DX-141", { status: "In Progress" })],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(0);
    expect(result.conflictBlocked).toBe(1);
    expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
    // Conflict-check rejection is a TRANSIENT per-tick gate. The
    // overlap reason evaporates the moment the sibling leaves In
    // Progress — picker re-evaluates next tick. Persisting via
    // `waiting_on` (which clears only on TERMINAL deps) created stale
    // stamps + cycles (DX-292 ↔ DX-294). Picker MUST NOT write to the
    // YAML on conflict-check rejection.
    expect(yl.writeIssue).not.toHaveBeenCalled();
  });

  it("DX-262 — stale in-progress YAML with no live dispatch is filtered out → conflict-check skipped, candidate dispatched", async () => {
    // Orphan YAML left "In Progress" by a dispatch that died outside
    // the orderly completion path (worker OOM, operator DB cancel,
    // broken-worktree sync abort, claude-auth fail). The dispatches
    // table has NO live row for DX-99 — without this filter the
    // picker would burn a conflict-check triage every tick.
    writeSettings({
      alice: agentRecord("alice"),
    });
    // SQL handler returns empty for the live-issue-ids query →
    // liveInProgress becomes empty → conflict-check skipped.
    setAgentLocksQueryFn(async () => [] as never);
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [issue("DX-99", { status: "In Progress" })],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(1);
    expect(result.conflictBlocked).toBe(0);
    expect(mockedRunConflictCheck).not.toHaveBeenCalled();
  });

  it("DX-262 — partial overlap: only the live-dispatch in-progress card reaches conflict-check; stale one is dropped", async () => {
    // Two YAMLs claim "In Progress" but only one has a live dispatch.
    // Conflict-check sees ONLY the live one, not both.
    writeSettings({
      alice: agentRecord("alice"),
    });
    setAgentLocksQueryFn(async (sql) => {
      if (sql.includes("FROM dispatches") && sql.includes("issue_id")) {
        return [{ issue_id: "DX-50" }] as never;
      }
      return [] as never;
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    mockedRunConflictCheck.mockResolvedValue({ kind: "ok", reason: "no overlap" });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [
        issue("DX-50", { status: "In Progress" }),
        issue("DX-99", { status: "In Progress" }),
      ],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(1);
    expect(mockedRunConflictCheck).toHaveBeenCalledTimes(1);
    const passedInProgress = mockedRunConflictCheck.mock.calls[0][0].inProgress;
    expect(passedInProgress.map((c) => c.id)).toEqual(["DX-50"]);
  });

  it("conflictCheckEnabled=false → no triage spawn, all candidates dispatched", async () => {
    writeSettings(
      {
        alice: agentRecord("alice"),
        bob: agentRecord("bob"),
        charlie: agentRecord("charlie"),
      },
      false,
    );
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1"), issue("DX-2"), issue("DX-3")],
      inProgress: [issue("DX-99", { status: "In Progress" })],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(3);
    expect(mockedRunConflictCheck).not.toHaveBeenCalled();
  });

  // DX-292 Phase 1 — broken agents are filtered out of the picker pool
  // by `pickFreeAgent`. End-to-end check on the orchestrator: a broken
  // alice + healthy bob in the same roster ends with bob dispatching
  // (alice would have been alphabetically first but is filtered out).
  it("DX-292: skips an agent whose broken !== null; healthy peer dispatches", async () => {
    writeSettings({
      alice: agentRecord("alice", {
        broken: {
          reason: "Worktree rebase aborted",
          suggested_steps: ["cd <worktree>", "git rebase --abort"],
          set_at: "2026-05-12T03:00:00Z",
        },
      }),
      bob: agentRecord("bob"),
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
    expect(mockedDispatchWithRecovery.mock.calls[0][1].agentName).toBe("bob");
  });

  it("DX-292: returns 0 dispatched when every agent is broken (no fallback)", async () => {
    writeSettings({
      alice: agentRecord("alice", {
        broken: {
          reason: "Stale worktree",
          suggested_steps: [],
          set_at: "2026-05-12T03:00:00Z",
        },
      }),
      bob: agentRecord("bob", {
        broken: {
          reason: "Auth missing",
          suggested_steps: [],
          set_at: "2026-05-12T03:01:00Z",
        },
      }),
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1"), issue("DX-2")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(0);
    expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
  });

  it("agent already in busy set → not picked", async () => {
    writeSettings({
      alice: agentRecord("alice"),
      bob: agentRecord("bob"),
    });
    // alice is busy on a prior dispatch — only bob can pick.
    setAgentLocksQueryFn(async (sql) => {
      if (sql.includes("FROM dispatches")) {
        return [{ agent_name: "alice" }] as never;
      }
      return [] as never;
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1"), issue("DX-2")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
    expect(mockedDispatchWithRecovery.mock.calls[0][1].agentName).toBe("bob");
  });

  it("dispatched agent is removed from the busy candidate pool within the same tick (no double-claim)", async () => {
    // Single agent + two cards — without the in-loop `busy.add(name)`,
    // pickFreeAgent would return alice on iteration 2 and dispatch her
    // a second card while her first is still spawning. The assertion
    // that we get exactly ONE dispatch (not two) is the tight invariant.
    writeSettings({
      alice: agentRecord("alice"),
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1"), issue("DX-2")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
    expect(mockedDispatchWithRecovery.mock.calls[0][1].agentName).toBe("alice");
  });

  it("DX-284: catch-cleanup uses loadLocalFromDisk so awaitMirror lag doesn't strand the orphan pre-stamp", async () => {
    // Specific to the DX-284 regression: when `awaitMirror` times out
    // inside the just-fired `stampDispatchAndWrite`, the DB lags the
    // YAML. The old code re-read via `loadLocal` (DB), saw `dispatch:
    // null`, and skipped the clear → orphan pre-stamp persisted. The
    // fix swaps the cleanup re-read to `loadLocalFromDisk`.
    //
    // Setup: simulate the race by making `loadLocal` return the stale
    // (pre-stamp) shape — the old code would have followed this path
    // and skipped the clear. `loadLocalFromDisk` returns the post-
    // stamp shape — the fixed code follows THIS path and clears.
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockRejectedValueOnce(
      new Error("dispatch failed post-stamp"),
    );
    const lifecycle = await import("./yaml-lifecycle.js");
    vi.mocked(lifecycle.loadLocal).mockResolvedValueOnce(
      issue("DX-1", { dispatch: null }), // stale DB shape
    );
    vi.mocked(lifecycle.loadLocalFromDisk).mockReturnValueOnce(
      issue("DX-1", {
        dispatch: {
          id: "stamp-uuid",
          pid: 0,
          host: "test",
          kind: "work" as const,
          started_at: "",
          ttl_seconds: 7200,
        },
      }),
    );
    const clearMock = vi.mocked(lifecycle.clearDispatchAndWrite);
    clearMock.mockClear();

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(0);
    // Cleared via the disk-read path even though the DB still showed
    // dispatch: null.
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(clearMock.mock.calls[0][1].id).toBe("DX-1");
  });

  it("dispatchWithRecovery throws AFTER YAML stamp → clearDispatchAndWrite fires so the stamp doesn't persist", async () => {
    /**
     * Regression for the poller-idle-with-ToDo-queue bug seen on
     * 2026-05-11. Before the fix, the catch block in
     * `tryMultiAgentDispatch` logged and continued, leaving the
     * just-stamped `dispatch:` block on the YAML. The next tick's
     * `listDispatchableYamls` filter rejected the card
     * (`if (i.dispatch !== null) return false`), so failed dispatches
     * accumulated until the entire ToDo queue was filtered out and the
     * worker stalled with "No cards in ToDo" while cards were waiting.
     *
     * Contract: dispatch throws → loadLocal the just-stamped YAML →
     * `clearDispatchAndWrite` invoked so subsequent ticks see a clean
     * slate. `loadLocal` returns null in the default mock; this test
     * overrides it to return an Issue with a non-null `dispatch{}` so
     * the clear branch fires and we can assert against the call.
     */
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockRejectedValueOnce(
      new Error("dispatch failed post-stamp"),
    );
    const lifecycle = await import("./yaml-lifecycle.js");
    // DX-284: cleanup paths now read from DISK, not the DB-mirror,
    // to dodge the awaitMirror lag that was orphaning pre-stamps.
    // Mock the disk reader (sync, NOT async).
    vi.mocked(lifecycle.loadLocalFromDisk).mockReturnValueOnce({
      ...issue("DX-1"),
      dispatch: {
        id: "stamp-uuid",
        pid: 0,
        host: "test",
        kind: "work" as const,
        started_at: "",
        ttl_seconds: 7200,
      },
    });
    const clearMock = vi.mocked(lifecycle.clearDispatchAndWrite);
    clearMock.mockClear();

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(0);
    expect(clearMock).toHaveBeenCalledTimes(1);
    const [, clearedIssue] = clearMock.mock.calls[0];
    expect(clearedIssue.id).toBe("DX-1");
  });

  it("dispatchWithRecovery throws → loop continues with remaining cards (no halt)", async () => {
    writeSettings({
      alice: agentRecord("alice"),
      bob: agentRecord("bob"),
    });
    // First call throws; subsequent succeeds.
    mockedDispatchWithRecovery
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValue({ dispatchId: "did", job: {} as never });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1"), issue("DX-2")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });
    // First throw drops DX-1 from the working set; bob then picks
    // DX-2 and succeeds.
    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(2);
  });

  it("tracker dispatch lock held by another holder → card is skipped, dispatch never called (DX-241)", async () => {
    writeSettings({
      alice: agentRecord("alice"),
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    // Tracker reports an existing lock held by ANOTHER holder, fresh
    // (within TTL). The picker must skip the card without invoking
    // dispatchWithRecovery.
    const heldLockTracker: IssueTracker = {
      ...fakeTracker(),
      getComments: async () => [
        {
          id: "lock-1",
          author: "danxbot",
          timestamp: "",
          // Hand-built lock body matching renderLockComment.
          text: [
            "<!-- danxbot -->",
            "<!-- danxbot-lock -->",
            "",
            "**Dispatch lock**",
            "",
            "| Field | Value |",
            "|---|---|",
            "| holder | `other-target` |",
            "| host | `other-host` |",
            "| host_pid | `4242` |",
            "| dispatch_id | `held-dispatch-uuid` |",
            "| repo_path | `/x` |",
            "| jsonl_dir | `/y` |",
            "| workspace | `issue-worker` |",
            "| started_at | `" + NOW.toISOString() + "` |",
            "| ttl | `120m` |",
            "| stale_after | `2099-12-31T00:00:00.000Z` |",
            "| released_at | `` |",
          ].join("\n"),
        },
      ],
    };

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: heldLockTracker,
      now: NOW,
    });
    expect(result.dispatched).toBe(0);
    expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
  });

  it("dispatch input carries lockRelease pointing at the same tracker + external_id (DX-241)", async () => {
    writeSettings({
      alice: agentRecord("alice"),
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    const tracker = fakeTracker();

    await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker,
      now: NOW,
    });

    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.lockRelease).toBeDefined();
    expect(dispatchInput.lockRelease!.tracker).toBe(tracker);
    expect(dispatchInput.lockRelease!.externalId).toBe("ext-DX-1");
  });

  it("card already assigned to another agent → other agent's card is skipped", async () => {
    writeSettings({
      alice: agentRecord("alice"),
    });
    // The DB says DX-1 is owned by bob.
    setAgentLocksQueryFn(async (sql) => {
      if (sql.includes("FROM issues")) {
        return [{ id: "DX-1", assigned_agent: "bob" }] as never;
      }
      return [] as never;
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1"), issue("DX-2")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
    // alice picked DX-2 (DX-1 was claimed by bob).
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.issueId).toBe("DX-2");
  });

  /**
   * AC #2 of DX-219 — pre-claim DB liveness guard. Ports
   * `hasLiveDispatchForCard` (ISS-69) onto the multi-agent path. When a
   * live PID dispatch already owns the card (host-mode claude that
   * reparented to PID 1 after a worker restart), the picker MUST skip
   * it. Without this port, the picker would double-claim and melt the
   * working tree.
   */
  it("AC #2: skips a card when guardLiveDispatchForCard reports a live PID — picker refuses to assign", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    vi.mocked(guardLiveDispatchForCard).mockResolvedValueOnce(true);

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(0);
    expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
    expect(guardLiveDispatchForCard).toHaveBeenCalledWith({
      repoName: "danxbot",
      cardId: "ext-DX-1",
      internalIssueId: "DX-1",
    });
  });

  it("AC #2: proceeds when guard returns false (no live PID) and forwards external_id + internalIssueId", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    vi.mocked(guardLiveDispatchForCard).mockResolvedValue(false);

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
    expect(guardLiveDispatchForCard).toHaveBeenCalledWith({
      repoName: "danxbot",
      cardId: "ext-DX-1",
      internalIssueId: "DX-1",
    });
  });

  it("AC #2: locally-only cards (empty external_id) skip the DB guard — no inter-worker double-claim risk", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1", { external_id: "" })],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    expect(guardLiveDispatchForCard).not.toHaveBeenCalled();
  });

  /**
   * AC #4 of DX-219 — post-dispatch card-progress check ported into
   * the multi-agent onComplete chain. When the dispatch ends and the
   * card is trello-tracked, the scheduler's check runs so an env-level
   * stuck-card writes the CRITICAL_FAILURE flag.
   */
  it("AC #4: wires runPostDispatchProgressCheck into dispatch.onComplete for trello-tracked cards", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    vi.mocked(runPostDispatchProgressCheck).mockResolvedValue(undefined);

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    // Extract the onComplete passed to dispatch() and invoke it like
    // the launcher would on agent termination. The mocked scheduler
    // call should fire with the card's external_id + job metadata.
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.onComplete).toBeDefined();
    await dispatchInput.onComplete!({
      id: "did-1",
      status: "completed",
      summary: "ok",
    } as never);

    expect(runPostDispatchProgressCheck).toHaveBeenCalledTimes(1);
    const passed = vi.mocked(runPostDispatchProgressCheck).mock.calls[0][0];
    expect(passed.cardId).toBe("ext-DX-1");
    expect(passed.jobId).toBe("did-1");
    expect(passed.jobStatus).toBe("completed");
    expect(passed.jobSummary).toBe("ok");
  });

  /**
   * DX-290 (Event-Driven Worker Phase 4b.3) — the same hook MUST also
   * fire when the dispatch ends with a failure status. AC #4 explicitly
   * pins this: `recoverStuckCards is wired via … onComplete; test
   * asserts the hook fires on a failed dispatch`. Without the assertion
   * a future refactor that branches "skip check on failure" would slip
   * past the happy-path coverage above. The previous in-poller
   * `recoverStuckCards` ran specifically on failure to surface stuck
   * cards to operators; the multi-agent equivalent is
   * `runPostDispatchProgressCheck` writing CRITICAL_FAILURE when the
   * card never moved out of ToDo — regardless of jobStatus.
   */
  it("AC #4 (DX-290): runPostDispatchProgressCheck fires from dispatch.onComplete on a FAILED dispatch", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    vi.mocked(runPostDispatchProgressCheck).mockResolvedValue(undefined);

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.onComplete).toBeDefined();

    // Simulate the launcher invoking onComplete with a failed status —
    // mirrors the lifecycle stop signal the worker emits when the agent
    // exits non-zero or is killed by the stall detector.
    await dispatchInput.onComplete!({
      id: "did-1",
      status: "failed",
      summary: "agent crashed mid-dispatch",
    } as never);

    expect(runPostDispatchProgressCheck).toHaveBeenCalledTimes(1);
    const passed = vi.mocked(runPostDispatchProgressCheck).mock.calls[0][0];
    expect(passed.cardId).toBe("ext-DX-1");
    expect(passed.jobId).toBe("did-1");
    expect(passed.jobStatus).toBe("failed");
    expect(passed.jobSummary).toBe("agent crashed mid-dispatch");
  });

  it("AC #4: dispatch.onComplete runs BOTH the YAML dispatch{} cleanup AND the post-dispatch progress check in one invocation", async () => {
    // Composite-behaviour test for the multi-agent onComplete chain.
    // The handler must (a) clear the YAML's `dispatch{}` block via
    // `clearDispatchAndWrite` when a stale block exists, AND (b) fire
    // `runPostDispatchProgressCheck` for the trello-tracked card. A
    // future refactor that drops either step would slip past the
    // narrowly-scoped per-effect tests; this asserts they coexist.
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    vi.mocked(runPostDispatchProgressCheck).mockResolvedValue(undefined);
    // DX-284: cleanup now reads from disk via `loadLocalFromDisk`.
    // Return a fresh issue carrying a stale dispatch block so the
    // cleanup branch actually runs (default mock returns null →
    // short-circuit).
    vi.mocked(loadLocalFromDisk).mockReturnValueOnce(
      issue("DX-1", {
        dispatch: {
          id: "old-did",
          pid: 999,
          host: "h",
          kind: "work",
          started_at: "2026-05-10T00:00:00Z",
          ttl_seconds: 7200,
        },
      }),
    );

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    await dispatchInput.onComplete!({
      id: "did-1",
      status: "completed",
      summary: "ok",
    } as never);

    // Both effects fire — the order they run in is not part of the
    // contract (no shared state between them), but BOTH must run.
    expect(clearDispatchAndWrite).toHaveBeenCalledTimes(1);
    expect(runPostDispatchProgressCheck).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runPostDispatchProgressCheck).mock.calls[0][0].cardId).toBe(
      "ext-DX-1",
    );
  });

  it("recovery-mode dispatches skip runPostDispatchProgressCheck (branch cleanup, not card work — would write spurious CRITICAL_FAILURE)", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    await dispatchInput.onComplete!({
      id: "did-1",
      status: "completed",
      summary: "recovered branch",
      recoveryMode: true,
    } as never);

    expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
  });

  it("AC #4: locally-only cards skip runPostDispatchProgressCheck (no tracker round-trip possible)", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1", { external_id: "" })],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    await dispatchInput.onComplete!({
      id: "did-1",
      status: "completed",
      summary: "ok",
    } as never);

    expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
  });

  // Heal: orphan assigned_agent (agent name no longer in roster — agent
  // deleted via the settings-clobber race in DX-281, or removed without
  // running the DX-283 cascade). pickCardForAgent treats those cards as
  // owned-by-other-agent forever and the picker silently skips them. The
  // heal pass at the top of tryMultiAgentDispatch clears the orphan claim
  // so the card becomes pickable on the same tick.
  // DX-286: heal uses clearDispatchAndWrite (not stampAssignedAgentAndWrite)
  // to enforce the (dispatch !== null) === (assigned_agent !== null)
  // invariant atomically — see the heal-pass header comment in
  // multi-agent-pick.ts for the full rationale.
  it("heals orphan assigned_agent (agent not in roster) → clears claim, dispatches card", async () => {
    writeSettings({ murphy: agentRecord("murphy") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const orphanCard = issue("DX-220", { assigned_agent: "phil" });
    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [orphanCard],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(clearDispatchAndWrite).toHaveBeenCalledWith(
      tmpRepo,
      expect.objectContaining({ id: "DX-220", assigned_agent: "phil" }),
    );
    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.issueId).toBe("DX-220");
    expect(dispatchInput.agent!.name).toBe("murphy");
  });

  // Invariant: 1 open card per agent at a time. When two open ToDo cards
  // both stamp assigned_agent=dani (clearDispatchAndWrite miss, manual
  // edit, etc.), the heal pass keeps the first in pick order and clears
  // the rest. The kept card dispatches this tick; cleared cards become
  // unclaimed and re-enter the pool next tick.
  it("heals duplicate assigned_agent across open cards → keeps first, clears rest", async () => {
    writeSettings({ dani: agentRecord("dani") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const a = issue("DX-1", { assigned_agent: "dani" });
    const b = issue("DX-2", { assigned_agent: "dani" });
    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [a, b],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(clearDispatchAndWrite).toHaveBeenCalledWith(
      tmpRepo,
      expect.objectContaining({ id: "DX-2", assigned_agent: "dani" }),
    );
    expect(clearDispatchAndWrite).not.toHaveBeenCalledWith(
      tmpRepo,
      expect.objectContaining({ id: "DX-1", assigned_agent: "dani" }),
    );
    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.issueId).toBe("DX-1");
  });

  // DX-286 AC #2 — the heal must clear BOTH dispatch{} and
  // assigned_agent atomically when the duplicate carries a stale
  // dispatch{} block (e.g. a chokidar mirror lag let a stamped card
  // sneak past the listDispatchableYamls filter). Pre-fix the heal
  // used stampAssignedAgentAndWrite(c, null) which preserved
  // dispatch{}, leaving the orphan state described in the bug
  // (assigned_agent: null + dispatch: {pid:0}).
  it("AC #2: heal-clears-duplicate when dispatch{} is also stamped → both fields cleared atomically", async () => {
    writeSettings({ dani: agentRecord("dani") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const a = issue("DX-1", { assigned_agent: "dani" });
    const b = issue("DX-2", {
      assigned_agent: "dani",
      dispatch: {
        id: "did-stale",
        pid: 0,
        host: "dan",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    });
    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [a, b],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    // Heal should clear DX-2 (the duplicate) via clearDispatchAndWrite
    // — clears both dispatch{} AND assigned_agent in one write.
    expect(clearDispatchAndWrite).toHaveBeenCalledWith(
      tmpRepo,
      expect.objectContaining({
        id: "DX-2",
        assigned_agent: "dani",
        dispatch: expect.objectContaining({ id: "did-stale", pid: 0 }),
      }),
    );
    // And the heal must NOT use stampAssignedAgentAndWrite(_, _, null)
    // which would preserve the dispatch{} block (the bug).
    expect(stampAssignedAgentAndWrite).not.toHaveBeenCalledWith(
      tmpRepo,
      expect.anything(),
      null,
    );
    // First card still dispatched.
    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery.mock.calls[0][0].issueId).toBe("DX-1");
  });

  // DX-286 AC #1 — explicit end-state assertion: a dispatch() throw
  // post-stamp leaves both fields null on disk, NOT the orphan
  // pre-stamp state. The pre-existing test on line 557 asserts the
  // call-shape; this complements by asserting the produced YAML state
  // (via the clearDispatchAndWrite mock contract — the mock returns
  // {dispatch: null, assigned_agent: null} so the post-state matches
  // production behavior).
  it("AC #1: dispatch() throw post-stamp → end-state YAML has dispatch=null AND assigned_agent=null", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockRejectedValueOnce(
      new Error("dispatch failed post-stamp"),
    );
    const lifecycle = await import("./yaml-lifecycle.js");
    // The post-stamp disk view: assigned_agent + dispatch BOTH set
    // (the picker just stamped them on lines 438 and 443).
    vi.mocked(lifecycle.loadLocalFromDisk).mockReturnValueOnce({
      ...issue("DX-1"),
      assigned_agent: "alice",
      dispatch: {
        id: "stamp-uuid",
        pid: 0,
        host: "host-a",
        kind: "work" as const,
        started_at: "",
        ttl_seconds: 7200,
      },
    });
    const clearMock = vi.mocked(lifecycle.clearDispatchAndWrite);
    clearMock.mockClear();

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      inProgress: [],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(0);
    // Catch fired clearDispatchAndWrite — the function clears BOTH
    // fields by contract (see yaml-lifecycle.ts:461-471). The mock
    // factory at top of file mirrors that contract.
    expect(clearMock).toHaveBeenCalledTimes(1);
    const [, clearedIssue] = clearMock.mock.calls[0];
    expect(clearedIssue.id).toBe("DX-1");
    // Post-state derived from the mock contract:
    const postState = await clearMock.mock.results[0].value;
    expect(postState.dispatch).toBeNull();
    expect(postState.assigned_agent).toBeNull();
  });

  /**
   * DX-306: a transient `tryAcquireLock` throw (e.g. Trello 429) drops
   * the agent from the picker's eligible pool for the rest of this
   * tick. Pre-fix the same agent walks every remaining card, 429s on
   * each, and burns Trello quota during the exact window the API is
   * asking for backoff. The `lockResult.acquired === false` branch is
   * a different concern (another holder owns the lock, NOT a tracker
   * error) and MUST keep the agent eligible for other cards.
   */
  describe("DX-306: per-tick agent skip on lock-acquire throw", () => {
    function trackerWithFlakyGetComments(
      throwOnExternalIds: ReadonlySet<string>,
    ): IssueTracker & { getCommentsCalls: string[] } {
      const calls: string[] = [];
      return {
        fetchOpenCards: async () => [],
        isValidExternalId: () => true,
        getCard: async () => {
          throw new Error("getCard not used");
        },
        createCard: async () => ({ external_id: "", ac: [] }),
        updateCard: async () => {},
        moveToStatus: async () => {},
        setLabels: async () => {},
        addComment: async () => ({ id: "lock-cmt", timestamp: "" }),
        editComment: async () => {},
        getComments: async (id: string) => {
          calls.push(id);
          if (throwOnExternalIds.has(id)) {
            throw new Error(`429 Too Many Requests on ${id}`);
          }
          return [];
        },
        addAcItem: async () => ({ check_item_id: "" }),
        updateAcItem: async () => {},
        deleteAcItem: async () => {},
        get getCommentsCalls() {
          return calls;
        },
      } as IssueTracker & { getCommentsCalls: string[] };
    }

    it("a 429 on card #1 removes the agent from this tick's pool — agent does NOT walk card #2", async () => {
      writeSettings({ dani: agentRecord("dani") });
      const cards = [issue("DX-1"), issue("DX-2")];
      // First card's getComments throws (simulated 429); the second card
      // would resolve cleanly IF the picker tried it. Pre-fix: agent
      // walks both → 2 getComments calls. Post-fix: agent skipped after
      // first throw → 1 getComments call.
      const tracker = trackerWithFlakyGetComments(new Set(["ext-DX-1"]));

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
        inProgress: [],
        tracker,
        now: NOW,
      });

      expect(result.dispatched).toBe(0);
      expect(tracker.getCommentsCalls).toEqual(["ext-DX-1"]);
      expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
    });

    it("a 429 on agent A's card does NOT skip agent B — B still picks the next card", async () => {
      writeSettings({
        dani: agentRecord("dani"),
        murphy: agentRecord("murphy"),
      });
      const cards = [issue("DX-1"), issue("DX-2")];
      // Only DX-1 throws. dani picks DX-1 (alphabetical), throws,
      // dani is added to skipAgents. Next iteration: pickFreeAgent
      // returns murphy (alphabetical second). murphy picks DX-2,
      // getComments returns [], lock acquired, dispatch proceeds.
      const tracker = trackerWithFlakyGetComments(new Set(["ext-DX-1"]));
      mockedDispatchWithRecovery.mockResolvedValueOnce({
        ok: true,
        kind: "normal",
      } as never);

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
        inProgress: [],
        tracker,
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
      const dispatchCall = mockedDispatchWithRecovery.mock.calls[0];
      expect(dispatchCall[1].agentName).toBe("murphy");
    });

    it("when EVERY agent throws on its first card the loop terminates cleanly with 0 dispatches and one lock-attempt per agent (no infinite walk)", async () => {
      writeSettings({
        dani: agentRecord("dani"),
        murphy: agentRecord("murphy"),
      });
      const cards = [issue("DX-1"), issue("DX-2"), issue("DX-3")];
      // Both agents 429 on the first card they try. dani picks DX-1
      // (alphabetical), throws → skipped. murphy picks DX-2, throws
      // → skipped. Loop must exit (no eligible agent), not walk DX-3
      // with either skipped agent.
      const tracker = trackerWithFlakyGetComments(
        new Set(["ext-DX-1", "ext-DX-2", "ext-DX-3"]),
      );

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
        inProgress: [],
        tracker,
        now: NOW,
      });

      expect(result.dispatched).toBe(0);
      // Exactly 2 getComments calls — one per agent. NOT 6 (2 agents
      // × 3 cards) which would indicate skipAgents wasn't filtering.
      expect(tracker.getCommentsCalls.length).toBe(2);
      expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
    });

    it("skipAgents is tick-local — an agent that threw on tick 1 dispatches normally on tick 2", async () => {
      writeSettings({ dani: agentRecord("dani") });
      const cards = [issue("DX-1")];
      // Tick 1: tracker throws → dani skipped → 0 dispatches.
      // Tick 2: same dani, fresh tracker that does NOT throw → dani
      // must be eligible again (skipAgents lifetime is per-call, not
      // persistent).
      const flaky = trackerWithFlakyGetComments(new Set(["ext-DX-1"]));
      const tick1 = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
        inProgress: [],
        tracker: flaky,
        now: NOW,
      });
      expect(tick1.dispatched).toBe(0);

      mockedDispatchWithRecovery.mockResolvedValueOnce({
        ok: true,
        kind: "normal",
      } as never);
      const fresh = trackerWithFlakyGetComments(new Set());
      const tick2 = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
        inProgress: [],
        tracker: fresh,
        now: NOW,
      });
      expect(tick2.dispatched).toBe(1);
      const dispatchCall = mockedDispatchWithRecovery.mock.calls[0];
      expect(dispatchCall[1].agentName).toBe("dani");
    });

    it("the `lockResult.acquired === false` branch (other holder owns lock) keeps the agent eligible — agent retries card #2 unchanged", async () => {
      writeSettings({ dani: agentRecord("dani") });
      const cards = [issue("DX-1"), issue("DX-2")];
      // Tracker returns a lock comment owned by ANOTHER worker for
      // card #1 → tryAcquireLock returns {acquired: false}. Card #2
      // has no lock comment → tryAcquireLock grants it. dani must
      // attempt BOTH cards (this is the lock-held branch, NOT a
      // tracker error).
      const otherWorkerLockText = renderLockComment(
        {
          holder: "other-worker",
          host: "other-host",
          hostPid: 99999,
          dispatchId: "other-dispatch",
          repoPath: "/tmp/other-repo",
          jsonlDir: "/tmp/other-jsonl",
          workspace: "issue-worker",
        },
        // started a few minutes ago — well within the lock TTL so
        // tryAcquireLock returns {acquired: false, existing: ...}.
        new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      );
      const calls: string[] = [];
      const tracker: IssueTracker = {
        fetchOpenCards: async () => [],
        isValidExternalId: () => true,
        getCard: async () => {
          throw new Error("getCard not used");
        },
        createCard: async () => ({ external_id: "", ac: [] }),
        updateCard: async () => {},
        moveToStatus: async () => {},
        setLabels: async () => {},
        addComment: async () => ({ id: "lock-cmt", timestamp: "" }),
        editComment: async () => {},
        getComments: async (id: string) => {
          calls.push(id);
          if (id === "ext-DX-1") {
            return [
              {
                id: "existing-lock",
                author: "other-worker",
                text: otherWorkerLockText,
                timestamp: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
              },
            ];
          }
          return [];
        },
        addAcItem: async () => ({ check_item_id: "" }),
        updateAcItem: async () => {},
        deleteAcItem: async () => {},
      };
      mockedDispatchWithRecovery.mockResolvedValueOnce({
        ok: true,
        kind: "normal",
      } as never);

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
        inProgress: [],
        tracker,
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      // Agent walked BOTH cards — DX-1 (lock held → skip card, agent
      // stays eligible) then DX-2 (acquired, dispatched).
      expect(calls).toEqual(["ext-DX-1", "ext-DX-2"]);
    });
  });
});
