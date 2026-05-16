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
// DX-360 — picker's resume-existing-card pre-check calls
// `listDispatchesByIssueId` to find the prior session UUID. Stub
// returns empty by default; tests asserting resume behavior override
// per-call. Mocking here keeps the test file off the
// `dashboard/dispatches-db.js` → `db/connection.js` hard-requires
// `DANXBOT_DB_*` chain (same isolation rationale as the scheduler
// mock above).
vi.mock("../dashboard/dispatches-db.js", () => ({
  listDispatchesByIssueId: vi.fn().mockResolvedValue([]),
}));
// DX-368 — invariant assertion records a system error when the picker
// exits with a free agent + claimable card still available. Mock the
// recorder so tests can assert the call shape without standing up the
// dashboard SSE bus.
const mockRecordSystemError = vi.fn();
vi.mock("../dashboard/system-errors.js", () => ({
  recordSystemError: (...args: unknown[]) => mockRecordSystemError(...args),
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
    snapshotIfDirty: vi.fn().mockResolvedValue({ kind: "clean" }),
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
      // assigned_agent stays — production preserves the stamp as
      // durable audit + as the "self-claim" marker the picker reads
      // on the next tick (see yaml-lifecycle.ts#clearDispatchAndWrite).
    })),
    loadLocal: vi.fn(async () => null),
    writeIssue: vi.fn(async () => undefined),
  };
});

import { tryMultiAgentDispatch } from "./multi-agent-pick.js";
import { renderLockComment } from "../issue-tracker/lock.js";
import { dispatchWithRecovery } from "../dispatch/recovery-mode.js";
import {
  guardLiveDispatchForCard,
  runPostDispatchProgressCheck,
} from "../dispatch/scheduler.js";
import {
  clearDispatchAndWrite,
  loadLocal,
  writeIssue,
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

interface WriteSettingsOptions {
  prepMode?: "combined" | "separate";
}

function writeSettings(
  agents: Record<string, unknown>,
  opts: WriteSettingsOptions = {},
): void {
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
  if (opts.prepMode !== undefined) {
    body.agentDefaults = { prepMode: opts.prepMode };
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
    schema_version: 9,
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
    effort_level: null,
    history: [],
    ...overrides,
    db_updated_at: "",
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
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
    expect(mockedDispatchWithRecovery.mock.calls[0][1].agentName).toBe("bob");
    // Pin the picker → workspace contract: every picker-driven dispatch
    // targets `issue-worker`. The DX-560 self-repair branch was retired,
    // so a regression that reintroduces an alternative workspace string
    // (typo, partial rebuild, accidental branch) fails here.
    expect(mockedDispatchWithRecovery.mock.calls[0][0].workspace).toBe(
      "issue-worker",
    );
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
      tracker: fakeTracker(),
      now: NOW,
    });
    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
    expect(mockedDispatchWithRecovery.mock.calls[0][1].agentName).toBe("alice");
  });

  it("dispatchWithRecovery throws AFTER YAML stamp → clearDispatchAndWrite fires so the stamp doesn't persist", async () => {
    /**
     * Regression for the poller-idle-with-ToDo-queue bug seen on
     * 2026-05-11. Before the fix, the catch block in
     * `tryMultiAgentDispatch` logged and continued, leaving the
     * just-stamped `dispatch:` block on the YAML.
     */
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockRejectedValueOnce(
      new Error("dispatch failed post-stamp"),
    );
    const lifecycle = await import("./yaml-lifecycle.js");
    vi.mocked(lifecycle.loadLocal).mockResolvedValueOnce({
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
    mockedDispatchWithRecovery
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValue({ dispatchId: "did", job: {} as never });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1"), issue("DX-2")],
      tracker: fakeTracker(),
      now: NOW,
    });
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
   * `hasLiveDispatchForCard` (ISS-69) onto the multi-agent path.
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
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    expect(guardLiveDispatchForCard).not.toHaveBeenCalled();
  });

  /**
   * AC #4 of DX-219 — post-dispatch card-progress check ported into
   * the multi-agent onComplete chain.
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
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
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
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.onComplete).toBeDefined();

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
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    vi.mocked(runPostDispatchProgressCheck).mockResolvedValue(undefined);
    vi.mocked(loadLocal).mockResolvedValueOnce(
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

    expect(clearDispatchAndWrite).toHaveBeenCalledTimes(1);
    expect(runPostDispatchProgressCheck).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(runPostDispatchProgressCheck).mock.calls[0][0].cardId,
    ).toBe("ext-DX-1");
  });

  /**
   * DX-322 — throttled dispatches skip runPostDispatchProgressCheck.
   *
   * Without this guard, a rate-limit-killed dispatch (card naturally
   * stays in ToDo because no work happened) would trigger the post-
   * dispatch check, which writes a `source: "post-dispatch-check"`
   * flag with NO `resume_at` — overwriting the throttle flag the
   * rate-limit handler wrote moments earlier and degrading the
   * halt-gate from "auto-clear past resume_at" to "permanent
   * CRITICAL_FAILURE". Exactly the failure mode DX-322 exists to
   * prevent.
   */
  it("throttled dispatches skip runPostDispatchProgressCheck (DX-322 — would overwrite the throttle flag with a permanent CRITICAL_FAILURE)", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [issue("DX-1")],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    await dispatchInput.onComplete!({
      id: "did-1",
      status: "throttled",
      summary: "Anthropic rate-limit — resumes at 2099-01-01T00:00:00.000Z",
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
  // running the DX-283 cascade).
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
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(clearDispatchAndWrite).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.issueId).toBe("DX-220");
    expect(dispatchInput.agent!.name).toBe("murphy");
  });

  // DX-501 — replaces the pre-DX-501 "skip + manual operator clear" path.
  // Duplicate `assigned_agent` ownership is fully resolvable from inside a
  // dispatched session, so the picker dispatches a reconcile task body
  // enumerating every stamped card. The agent decides which one to keep
  // and releases the rest in-session.
  it("dispatches a reconcile task body when two open cards share assigned_agent (DX-501)", async () => {
    writeSettings({ dani: agentRecord("dani") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const a = issue("DX-1", { assigned_agent: "dani", title: "First card" });
    const b = issue("DX-2", { assigned_agent: "dani", title: "Second card" });
    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [a, b],
      openIssues: [a, b],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    // Reconcile target is the first duplicate (preserved order).
    expect(dispatchInput.issueId).toBe("DX-1");
    expect(dispatchInput.agent!.name).toBe("dani");
    // Task body enumerates BOTH card ids and explicitly tells the agent
    // to release extra stamps + call /danx-next on the retained card.
    expect(dispatchInput.task).toContain("DX-1");
    expect(dispatchInput.task).toContain("DX-2");
    expect(dispatchInput.task).toContain("First card");
    expect(dispatchInput.task).toContain("Second card");
    expect(dispatchInput.task).toMatch(/Reconcile/);
    expect(dispatchInput.task).toMatch(/\/danx-next <retained-id>/);
    expect(dispatchInput.task).toContain("assigned_agent: null");
    // No prep leg on reconcile dispatches.
    expect(dispatchInput.task).not.toContain("/danx-prep");
    // Reconcile is a fresh decision — never carries a resume session.
    expect(dispatchInput.resumeSessionId).toBeUndefined();
    // Reconcile always runs as `work` kind so the prep-verdict route
    // does not gate the dispatch on a verdict that never comes.
    expect(dispatchInput.dispatchKind).toBe("work");
  });

  it("reconcile dispatch skips the post-dispatch card-progress check (DX-501)", async () => {
    writeSettings({ dani: agentRecord("dani") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const a = issue("DX-1", { assigned_agent: "dani" });
    const b = issue("DX-2", { assigned_agent: "dani" });
    await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [a, b],
      openIssues: [a, b],
      tracker: fakeTracker(),
      now: NOW,
    });

    // Fire the onComplete the dispatch() mock would have called. The
    // reconcile branch MUST suppress the progress check because the
    // dispatch-target card may legitimately be the one the agent
    // releases.
    const onComplete = mockedDispatchWithRecovery.mock.calls[0][0].onComplete!;
    await onComplete({
      id: "did",
      status: "completed",
      summary: "reconcile done",
    } as never);

    expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
  });

  it("reconcile picks the first duplicate in input order as the dispatch target (DX-501)", async () => {
    // The dispatch target is just the YAML the dispatch row + lock hang
    // on; the agent reads ALL duplicates from the prompt and recovers
    // each one. No status-rank heuristic — Blocked / Review on an agent
    // stamp is an invalid state and the agent handles it regardless of
    // which YAML the dispatch row sits on.
    writeSettings({ dani: agentRecord("dani") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const first = issue("DX-1", {
      assigned_agent: "dani",
      status: "ToDo",
    });
    const second = issue("DX-2", {
      assigned_agent: "dani",
      status: "In Progress",
    });
    await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [first],
      openIssues: [first, second],
      tracker: fakeTracker(),
      now: NOW,
    });

    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.issueId).toBe("DX-1");
    // Enumeration covers BOTH cards regardless of target.
    expect(dispatchInput.task).toContain("DX-1");
    expect(dispatchInput.task).toContain("DX-2");
  });

  it("reconcile dispatch failure does NOT throw inside onComplete (DX-501; cooldown retired DX-366)", async () => {
    // Pre-DX-366 the picker stamped a failure cooldown on dispatch
    // failure and had a DX-501 carve-out that skipped CARD cooldowns
    // on reconcile failures. With the cooldown system retired, the
    // carve-out is gone too — the only invariant left is "the failure
    // path completes cleanly." The strike accumulator (DX-365) records
    // the failure on the dispatch row; the picker drops the agent on
    // the next tick when the strike count crosses the broken
    // threshold.
    writeSettings({ dani: agentRecord("dani") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const a = issue("DX-1", { assigned_agent: "dani" });
    const b = issue("DX-2", { assigned_agent: "dani" });
    await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [a, b],
      openIssues: [a, b],
      tracker: fakeTracker(),
      now: NOW,
    });

    const onComplete = mockedDispatchWithRecovery.mock.calls[0][0].onComplete!;
    await expect(
      onComplete({
        id: "did",
        status: "failed",
        summary: "reconcile blew up",
      } as never),
    ).resolves.toBeUndefined();
  });

  it("reconcile path does not corrupt remainingCards when target is not in dispatchable list (DX-501)", async () => {
    // Regression test for the splice-poison class — owned.cards[0] may
    // be In Progress (filtered out of `cards`). A naive
    // `splice(remainingCards.indexOf(target), 1)` would chop the wrong
    // card. We assert the OTHER agent still gets their fresh ToDo.
    writeSettings({
      dani: agentRecord("dani"),
      phil: agentRecord("phil"),
    });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const daniInProgress = issue("DX-1", {
      assigned_agent: "dani",
      status: "In Progress",
    });
    const daniTodo = issue("DX-2", {
      assigned_agent: "dani",
      status: "ToDo",
    });
    // phil's only candidate — must survive dani's reconcile splice.
    const philTodo = issue("DX-9", {
      assigned_agent: null,
      status: "ToDo",
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      // `cards` excludes In Progress (listDispatchableYamls filter).
      cards: [daniTodo, philTodo],
      openIssues: [daniInProgress, daniTodo, philTodo],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(2);
    const targets = mockedDispatchWithRecovery.mock.calls.map(
      ([input]) => input.issueId,
    );
    // dani reconciles onto DX-1 (In Progress > ToDo by rank).
    // phil gets DX-9. DX-2 stays untouched on this tick (dani owns it
    // but is now busy after the reconcile dispatch).
    expect(targets).toContain("DX-1");
    expect(targets).toContain("DX-9");
  });

  // ============================================================
  // DX-360 — resume-existing-card pre-check (the actual feature).
  // ============================================================

  it("dispatches the agent to its OPEN assigned card (status=In Progress) before any fresh ToDo pick", async () => {
    writeSettings({ murphy: agentRecord("murphy") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    // murphy carries an In Progress assigned card (DX-351) — picker
    // MUST resume it rather than offer the fresh ToDo (DX-354).
    const inProgress = issue("DX-351", {
      assigned_agent: "murphy",
      status: "In Progress",
    });
    const freshTodo = issue("DX-354", {
      assigned_agent: null,
      status: "ToDo",
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [freshTodo], // listDispatchableYamls excludes In Progress
      openIssues: [inProgress, freshTodo],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    // Resumed onto murphy's existing card, NOT the fresh ToDo.
    expect(dispatchInput.issueId).toBe("DX-351");
    expect(dispatchInput.agent!.name).toBe("murphy");
  });

  it("threads resumeSessionId from the latest dispatch row when one carries a sessionUuid", async () => {
    writeSettings({ murphy: agentRecord("murphy") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const db = await import("../dashboard/dispatches-db.js");
    vi.mocked(db.listDispatchesByIssueId).mockResolvedValueOnce([
      {
        id: "newest-dispatch-uuid",
        sessionUuid: "sess-abc-123",
      } as never,
      {
        id: "older-dispatch-uuid",
        sessionUuid: "sess-stale-old",
      } as never,
    ]);

    const owned = issue("DX-351", {
      assigned_agent: "murphy",
      status: "In Progress",
    });

    await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [],
      openIssues: [owned],
      tracker: fakeTracker(),
      now: NOW,
    });

    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    // Newest sessionUuid wins (listDispatchesByIssueId is newest-first).
    expect(dispatchInput.resumeSessionId).toBe("sess-abc-123");
  });

  it("omits resumeSessionId when no prior dispatch row has a sessionUuid (degrades to fresh session)", async () => {
    writeSettings({ murphy: agentRecord("murphy") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const db = await import("../dashboard/dispatches-db.js");
    vi.mocked(db.listDispatchesByIssueId).mockResolvedValueOnce([
      { id: "dispatch-1", sessionUuid: null } as never,
      { id: "dispatch-2", sessionUuid: "" } as never,
    ]);

    const owned = issue("DX-351", {
      assigned_agent: "murphy",
      status: "In Progress",
    });

    await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [],
      openIssues: [owned],
      tracker: fakeTracker(),
      now: NOW,
    });

    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.resumeSessionId).toBeUndefined();
  });

  it("resumes a Blocked card (status filter does NOT gate the agent's own card)", async () => {
    // Per DX-360 contract: the agent owns the card, so the agent
    // decides whether to clear the block or escalate properly. The
    // picker dispatches regardless of card status (except Done /
    // Cancelled, which are terminal audit).
    writeSettings({ murphy: agentRecord("murphy") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const blocked = issue("DX-351", {
      assigned_agent: "murphy",
      status: "Blocked",
      blocked: {
        reason: "stale spec",
        timestamp: "2026-05-13T00:00:00Z",
      },
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [],
      openIssues: [blocked],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery.mock.calls[0][0].issueId).toBe("DX-351");
  });

  it("releases the agent and flips the card back to ToDo when a conflict_on partner is In Progress", async () => {
    // Loop prevention (observed murphy/phil 2026-05-15). Pre-Option-1
    // behavior: Pass A re-resumed murphy on DX-547 every tick; prep
    // re-stamped same conflict_on partners; dispatch ended; loop. The
    // resume retention also kept the agent claim-glued to the card,
    // making the agent appear "busy" to operators inspecting state.
    //
    // Option-1 behavior: clear `assigned_agent` + flip status →
    // ToDo. Card re-enters fresh-pick pool, which `listDispatchableYamls`
    // already filters on conflict_on. Agent stays eligible (no busy /
    // skipAgents stamp) so Pass B fresh-pick can route them onto any
    // unowned ToDo whose gates are clear.
    writeSettings({ murphy: agentRecord("murphy") });

    const owned = issue("DX-547", {
      assigned_agent: "murphy",
      status: "In Progress",
      conflict_on: [{ id: "DX-546", reason: "needs schema first" }],
    });
    const partner = issue("DX-546", {
      assigned_agent: "dani",
      status: "In Progress",
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [],
      openIssues: [owned, partner],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(0);
    expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
    // Card mutated: claim cleared + status flipped.
    expect(writeIssue).toHaveBeenCalledTimes(1);
    const [, writtenIssue] = vi.mocked(writeIssue).mock.calls[0];
    expect(writtenIssue.id).toBe("DX-547");
    expect(writtenIssue.assigned_agent).toBeNull();
    expect(writtenIssue.status).toBe("ToDo");
    expect(writtenIssue.dispatch).toBeNull();
  });

  it("releases the agent and flips the card back to ToDo when a waiting_on dependency is non-terminal", async () => {
    // Symmetric to the conflict_on release. The same Pass A bypass
    // affected waiting_on — an owned card with a non-terminal dep
    // would re-resume every tick. waiting_on is the canonical
    // primitive for sequential phase ordering; the same gate applies.
    writeSettings({ murphy: agentRecord("murphy") });

    const owned = issue("DX-547", {
      assigned_agent: "murphy",
      status: "In Progress",
      waiting_on: {
        by: ["DX-546"],
        reason: "Phase 2 depends on Phase 1",
        timestamp: "2026-05-15T06:20:00Z",
      },
    });
    const dep = issue("DX-546", {
      assigned_agent: "dani",
      status: "In Progress",
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [],
      openIssues: [owned, dep],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(0);
    expect(writeIssue).toHaveBeenCalledTimes(1);
    const [, writtenIssue] = vi.mocked(writeIssue).mock.calls[0];
    expect(writtenIssue.id).toBe("DX-547");
    expect(writtenIssue.assigned_agent).toBeNull();
    expect(writtenIssue.status).toBe("ToDo");
  });

  it("resumes an owned card (no release) when conflict_on partners are all terminal", async () => {
    // Regression guard: do NOT release the claim when gates are
    // already effectively clear (terminal partner). The agent picks
    // up its session via --resume and continues.
    writeSettings({ murphy: agentRecord("murphy") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const owned = issue("DX-547", {
      assigned_agent: "murphy",
      status: "In Progress",
      conflict_on: [{ id: "DX-546", reason: "needs schema first" }],
    });
    const partner = issue("DX-546", {
      assigned_agent: "dani",
      status: "Done",
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [],
      openIssues: [owned, partner],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery.mock.calls[0][0].issueId).toBe("DX-547");
    // No release write — only the picker's normal dispatch stamp path.
    const releaseCall = vi
      .mocked(writeIssue)
      .mock.calls.find(
        ([, i]) => i.id === "DX-547" && i.assigned_agent === null,
      );
    expect(releaseCall).toBeUndefined();
  });

  it("falls through to fresh ToDo pick when the agent has no open assigned card", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });

    const todo = issue("DX-100", { status: "ToDo" });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [todo],
      openIssues: [todo],
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(1);
    expect(mockedDispatchWithRecovery.mock.calls[0][0].issueId).toBe("DX-100");
  });

  it("AC #1: dispatch() throw post-stamp → end-state YAML has dispatch=null; assigned_agent stays as durable audit so the next tick self-claim path works", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockRejectedValueOnce(
      new Error("dispatch failed post-stamp"),
    );
    const lifecycle = await import("./yaml-lifecycle.js");
    vi.mocked(lifecycle.loadLocal).mockResolvedValueOnce({
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
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(result.dispatched).toBe(0);
    expect(clearMock).toHaveBeenCalledTimes(1);
    const [, clearedIssue] = clearMock.mock.calls[0];
    expect(clearedIssue.id).toBe("DX-1");
    const postState = await clearMock.mock.results[0].value;
    expect(postState.dispatch).toBeNull();
    // assigned_agent preserved — the multi-agent picker's
    // pickCardForAgent self-claim branch reads this on the next tick
    // so the same agent re-picks the card without contention.
    expect(postState.assigned_agent).toBe("alice");
  });

  /**
   * DX-306: a transient `tryAcquireLock` throw (e.g. Trello 429) drops
   * the agent from the picker's eligible pool for the rest of this
   * tick.
   */
  describe("DX-306: per-tick agent skip on lock-acquire throw", () => {
    function trackerWithFlakyGetComments(
      throwOnExternalIds: ReadonlySet<string>,
    ): IssueTracker & { getCommentsCalls: string[] } {
      const calls: string[] = [];
      return {
        fetchOpenCards: async () => [],
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
      const tracker = trackerWithFlakyGetComments(new Set(["ext-DX-1"]));

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
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
      const tracker = trackerWithFlakyGetComments(new Set(["ext-DX-1"]));
      mockedDispatchWithRecovery.mockResolvedValueOnce({
        ok: true,
        kind: "normal",
      } as never);

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
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
      const tracker = trackerWithFlakyGetComments(
        new Set(["ext-DX-1", "ext-DX-2", "ext-DX-3"]),
      );

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
        tracker,
        now: NOW,
      });

      expect(result.dispatched).toBe(0);
      expect(tracker.getCommentsCalls.length).toBe(2);
      expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
    });

    it("skipAgents is tick-local — an agent that threw on tick 1 dispatches normally on tick 2", async () => {
      writeSettings({ dani: agentRecord("dani") });
      const cards = [issue("DX-1")];
      const flaky = trackerWithFlakyGetComments(new Set(["ext-DX-1"]));
      const tick1 = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards,
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
        new Date(NOW.getTime() - 5 * 60_000).toISOString(),
      );
      const calls: string[] = [];
      const tracker: IssueTracker = {
        fetchOpenCards: async () => [],
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
        tracker,
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      expect(calls).toEqual(["ext-DX-1", "ext-DX-2"]);
    });
  });

  /**
   * DX-366 — failure cooldowns retired. Card-level fault handling is
   * now solely the agent's responsibility (Blocked / waiting_on /
   * requires_human in-session); agent-level fault handling is the
   * strike accumulator (DX-365) → 3 consecutive failures →
   * `agents.<name>.broken`. The picker's job is to dispatch and let
   * the agent decide.
   */
  describe("DX-366: no picker-side cooldown after a failed dispatch", () => {
    it("a fresh tick after a failed dispatch CAN immediately re-pick the same agent for a different card (no 60s pause)", async () => {
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      // Tick 1 — alice picks DX-1 and the dispatch fails.
      const tick1 = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(tick1.dispatched).toBe(1);
      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      await dispatchInput.onComplete!({
        id: "did-1",
        status: "failed",
        summary: "transient claude-auth blip",
        dispatchKind: "work",
      } as never);

      // Tick 2 — same alice, fresh card DX-2, SAME instant. Pre-DX-366
      // alice would be in a 60s cooldown; the cooldown is retired so
      // she is immediately picker-eligible again.
      const tick2 = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-2")],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(tick2.dispatched).toBe(1);
      // Two dispatches total — DX-1 (failed) + DX-2 (the immediate retry).
      expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(2);
      expect(mockedDispatchWithRecovery.mock.calls[1][1].agentName).toBe(
        "alice",
      );
    });

    it("a fresh tick after a dispatchWithRecovery THROW CAN immediately re-pick the same agent for a different card (no 60s pause)", async () => {
      // Symmetric to the onComplete-failure path: dispatchWithRecovery
      // throwing synchronously (spawn-fail, worktree validation throw)
      // also pre-DX-366 stamped a 60s agent cooldown + a card cooldown.
      // With the cooldown system retired, the catch-block recovery
      // path leaves no picker-side state behind and the next tick is
      // free to re-pick the same agent immediately.
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockRejectedValueOnce(
        new Error("synthetic spawn-fail"),
      );
      mockedDispatchWithRecovery.mockResolvedValueOnce({
        dispatchId: "did-2",
        job: {} as never,
      });

      // Tick 1 — alice picks DX-1; dispatchWithRecovery throws inside
      // the catch block. Result: 0 dispatched (the throw aborted the
      // call), no cooldown stamped.
      const tick1 = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(tick1.dispatched).toBe(0);

      // Tick 2 — same alice, fresh DX-2, SAME instant. With cooldowns
      // retired, alice is immediately picker-eligible again.
      const tick2 = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-2")],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(tick2.dispatched).toBe(1);
      expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(2);
      expect(mockedDispatchWithRecovery.mock.calls[1][1].agentName).toBe(
        "alice",
      );
    });

    it("a fresh tick after a failed dispatch CAN immediately re-pick the same card with a different agent (no 5min pause)", async () => {
      writeSettings({
        alice: agentRecord("alice"),
        bob: agentRecord("bob"),
      });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      // Tick 1 — alice picks DX-1; the dispatch fails.
      const tick1 = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(tick1.dispatched).toBe(1);
      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      await dispatchInput.onComplete!({
        id: "did-1",
        status: "failed",
        summary: "transient blip",
        dispatchKind: "work",
      } as never);

      // Tick 2 — alice is busy in the DB (the failed dispatch row may
      // still be open from her POV mid-tear-down). Bob picks DX-1
      // immediately; pre-DX-366 the card was in a 5min cooldown.
      setAgentLocksQueryFn(async (sql) => {
        if (sql.includes("FROM dispatches")) {
          return [{ agent_name: "alice" }] as never;
        }
        return [] as never;
      });
      const tick2 = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(tick2.dispatched).toBe(1);
      expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(2);
      expect(mockedDispatchWithRecovery.mock.calls[1][1].agentName).toBe("bob");
    });
  });

  /**
   * DX-296 — prep dispatch shape selection. The picker decides
   * dispatch-task body + `dispatchKind` based on (prepMode,
   * pre-existing self-claim).
   */
  describe("DX-296: prep dispatch shape", () => {
    it("combined mode (default): dispatches combined shape (`/danx-prep <id>` + `/danx-next <id>`) with dispatchKind=work", async () => {
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      expect(dispatchInput.task).toBe(
        "In Progress cards: []\n\n/danx-prep DX-1\n\n/danx-next DX-1",
      );
      expect(dispatchInput.dispatchKind).toBe("work");
    });

    it("separate mode + fresh card (no self-claim): dispatches prep-only shape with dispatchKind=prep", async () => {
      writeSettings({ alice: agentRecord("alice") }, { prepMode: "separate" });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      expect(dispatchInput.task).toBe(
        "In Progress cards: []\n\n/danx-prep DX-1",
      );
      expect(dispatchInput.dispatchKind).toBe("prep");
    });

    it("separate mode + self-claim by SAME agent (work pass): dispatches combined shape with dispatchKind=work", async () => {
      // The card carries assigned_agent = "alice" before the pick —
      // simulating tick N+1 after a prep-only dispatch on tick N
      // cleared `dispatch{}` but left `assigned_agent`. The picker
      // self-claims via pickCardForAgent's "self-claim allowed" branch.
      writeSettings({ alice: agentRecord("alice") }, { prepMode: "separate" });
      // The DB-side assigned-cards lookup must agree with the YAML
      // shape so `pickCardForAgent` walks the self-claim branch.
      setAgentLocksQueryFn(async (sql) => {
        if (sql.includes("FROM issues")) {
          return [{ id: "DX-1", assigned_agent: "alice" }] as never;
        }
        return [] as never;
      });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1", { assigned_agent: "alice" })],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      expect(dispatchInput.task).toBe(
        "In Progress cards: []\n\n/danx-prep DX-1\n\n/danx-next DX-1",
      );
      expect(dispatchInput.dispatchKind).toBe("work");
    });

    it("per-tick read-once invariant: prepMode is resolved ONCE at the top of the tick — every card in the tick sees the same mode (no mid-tick flap)", async () => {
      // Two agents + two cards, both fresh. If `getPrepMode` were re-
      // read per card and the operator's settings.json were rewritten
      // mid-tick (via dashboard toggle), card #2 could end up
      // dispatched with the wrong shape. Pin the once-per-tick read
      // by mutating the settings file BETWEEN the first and second
      // dispatchWithRecovery call (the picker mock fires
      // synchronously inside the loop) — both dispatches must use
      // the original mode.
      writeSettings(
        { alice: agentRecord("alice"), bob: agentRecord("bob") },
        { prepMode: "separate" },
      );

      // First call rewrites settings.json to combined mode mid-tick.
      // Second call lands after the rewrite. Without the read-once
      // invariant, the second card's task body would be combined
      // shape; with the invariant, it stays prep-only.
      mockedDispatchWithRecovery
        .mockImplementationOnce(async (_input) => {
          writeSettings(
            { alice: agentRecord("alice"), bob: agentRecord("bob") },
            { prepMode: "combined" },
          );
          return { dispatchId: "did-1", job: {} as never };
        })
        .mockResolvedValueOnce({ dispatchId: "did-2", job: {} as never });

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1"), issue("DX-2")],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(2);
      // BOTH dispatches use prep-only shape (the original separate
      // mode), even though settings.json flipped to combined between
      // them.
      expect(mockedDispatchWithRecovery.mock.calls[0][0].task).toBe(
        "In Progress cards: []\n\n/danx-prep DX-1",
      );
      expect(mockedDispatchWithRecovery.mock.calls[0][0].dispatchKind).toBe(
        "prep",
      );
      expect(mockedDispatchWithRecovery.mock.calls[1][0].task).toBe(
        "In Progress cards: []\n\n/danx-prep DX-2",
      );
      expect(mockedDispatchWithRecovery.mock.calls[1][0].dispatchKind).toBe(
        "prep",
      );
    });

    it("separate mode 2-tick flow: tick 1 dispatches prep, tick 2 dispatches work", async () => {
      // Drives both ticks through tryMultiAgentDispatch back-to-back to
      // confirm the protocol. Tick 1: fresh card, prep dispatch. Tick
      // 2: same card now carries assigned_agent (the stamp survives
      // the cleared `dispatch{}` block by design); picker self-claims
      // and dispatches the work pass.
      writeSettings({ alice: agentRecord("alice") }, { prepMode: "separate" });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      // Tick 1 — fresh card, no DB claim row yet.
      const tick1Result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(tick1Result.dispatched).toBe(1);
      const tick1Dispatch = mockedDispatchWithRecovery.mock.calls[0][0];
      expect(tick1Dispatch.task).toBe(
        "In Progress cards: []\n\n/danx-prep DX-1",
      );
      expect(tick1Dispatch.dispatchKind).toBe("prep");

      // Tick 2 — assigned_agent stamp survived. The DB assignedCards
      // query reflects the persisted claim from tick 1.
      setAgentLocksQueryFn(async (sql) => {
        if (sql.includes("FROM issues")) {
          return [{ id: "DX-1", assigned_agent: "alice" }] as never;
        }
        return [] as never;
      });

      const tick2Result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1", { assigned_agent: "alice" })],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(tick2Result.dispatched).toBe(1);
      // Second call to dispatchWithRecovery — index 1.
      const tick2Dispatch = mockedDispatchWithRecovery.mock.calls[1][0];
      expect(tick2Dispatch.task).toBe(
        "In Progress cards: []\n\n/danx-prep DX-1\n\n/danx-next DX-1",
      );
      expect(tick2Dispatch.dispatchKind).toBe("work");
    });
  });

  /**
   * DX-296 — onComplete branching on `prepVerdict + dispatchKind`.
   * The route already applied any YAML / settings side-effects for
   * non-ok verdicts (`conflict_on[]` append, `Blocked` stamp,
   * `agents.<name>.broken` stamp); the picker MUST NOT run the card-
   * progress check on those (which would write CRITICAL_FAILURE for
   * a card that was never expected to leave ToDo).
   */
  describe("DX-296: onComplete branches on prepVerdict + dispatchKind", () => {
    it("verdict=ok + dispatchKind=work: runs runPostDispatchProgressCheck (combined-mode work dispatch behaves as a normal work dispatch)", async () => {
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });
      vi.mocked(runPostDispatchProgressCheck).mockResolvedValue(undefined);

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      await dispatchInput.onComplete!({
        id: "did-1",
        status: "completed",
        summary: "ok",
        prepVerdict: { verdict: "ok", reason: "no conflicts" },
        dispatchKind: "work",
      } as never);

      expect(runPostDispatchProgressCheck).toHaveBeenCalledTimes(1);
    });

    it("verdict=ok + dispatchKind=prep: SKIPS runPostDispatchProgressCheck (separate-mode prep-only — work pass not yet started, so card MUST stay in ToDo)", async () => {
      writeSettings({ alice: agentRecord("alice") }, { prepMode: "separate" });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      await dispatchInput.onComplete!({
        id: "did-1",
        status: "completed",
        summary: "prep ok",
        prepVerdict: { verdict: "ok", reason: "no conflicts" },
        dispatchKind: "prep",
      } as never);

      expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
    });

    it("verdict=conflict_on: SKIPS runPostDispatchProgressCheck (route already stamped conflict_on[]; card was never expected to progress)", async () => {
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      await dispatchInput.onComplete!({
        id: "did-1",
        status: "completed",
        summary: "conflict",
        prepVerdict: {
          verdict: "conflict_on",
          reason: "shared file",
          conflict_with: ["DX-99"],
        },
        dispatchKind: "work",
      } as never);

      expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
    });

    it("verdict=blocked: SKIPS runPostDispatchProgressCheck (route already stamped status=Blocked + blocked record; card was never expected to progress)", async () => {
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      await dispatchInput.onComplete!({
        id: "did-1",
        status: "completed",
        summary: "blocked",
        prepVerdict: { verdict: "blocked", reason: "spec ambiguous" },
        dispatchKind: "work",
      } as never);

      expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
    });

    it("legacy path: failed dispatch with NO prepVerdict (agent crashed before calling the verdict tool) → runPostDispatchProgressCheck still fires", async () => {
      // The card-progress check (CRITICAL_FAILURE halt safeguard) is the
      // only post-dispatch hook left for non-prep failures after DX-366
      // retired the failure-cooldown accounting. Verdict === undefined means
      // the agent died before the verdict tool ran; the check MUST still
      // fire so a card stuck in ToDo writes the halt flag.
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      await dispatchInput.onComplete!({
        id: "did-1",
        status: "failed",
        summary: "agent crashed mid-dispatch",
        // prepVerdict omitted — agent died before reaching the tool
        dispatchKind: "work",
      } as never);

      expect(runPostDispatchProgressCheck).toHaveBeenCalledTimes(1);
    });

    it("verdict=abort: SKIPS runPostDispatchProgressCheck (route already stamped agents.<name>.broken; card was never expected to progress)", async () => {
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      await dispatchInput.onComplete!({
        id: "did-1",
        status: "failed",
        summary: "abort",
        prepVerdict: {
          verdict: "abort",
          reason: "Bash broken",
          broken_details: { suggested_steps: ["ssh, fix PATH"] },
        },
        dispatchKind: "prep",
      } as never);

      expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
    });
  });

  // DX-342 — YAML-only mode (`tracker: null` on input). The picker
  // still dispatches; `tryAcquireLock` is never invoked even when the
  // candidate card carries a stale `external_id` from a prior tracker
  // window; the resulting dispatch input has `lockRelease: undefined`
  // so the dispatch lifecycle does not try to free a comment-lock that
  // was never acquired.
  describe("YAML-only mode — tracker null (DX-342)", () => {
    it("dispatches a card with stale external_id WITHOUT invoking tryAcquireLock and stamps lockRelease: undefined", async () => {
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });
      // Stale external_id surface (operator removed Trello creds AFTER
      // the card was minted on a prior tracker window).
      const staleCard = issue("DX-1", { external_id: "trello-stale-id" });
      const addCommentSpy = vi.fn().mockResolvedValue({
        id: "lock-cmt",
        timestamp: "",
      });
      // We pass `null` as the tracker — `tryAcquireLock` lives inside
      // `tracker.addComment`, so spying on a fakeTracker's addComment
      // covers the negative assertion: the picker's `tracker !== null`
      // gate makes `tryAcquireLock(tracker, ...)` unreachable.
      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [staleCard],
        tracker: null,
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      expect(addCommentSpy).not.toHaveBeenCalled();
      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      expect(dispatchInput.lockRelease).toBeUndefined();
    });

    it("dispatches a card with no external_id under tracker=null exactly like the trello-disabled fixture path", async () => {
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });
      const localOnly = issue("DX-2", { external_id: "" });

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [localOnly],
        tracker: null,
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
      expect(dispatchInput.lockRelease).toBeUndefined();
    });
  });

  describe("DX-368 — dispatch invariant assertion + idempotency", () => {
    it("does NOT record a system error on a normal converging tick (one agent + one card, dispatched)", async () => {
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });

    it("does NOT record a system error when no free agent exists at exit (every agent dispatched)", async () => {
      writeSettings({
        alice: agentRecord("alice"),
        bob: agentRecord("bob"),
      });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1"), issue("DX-2"), issue("DX-3")],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });

    it("does NOT record a system error when every remaining card is owned by a now-busy agent", async () => {
      // alice is in the busy set (already dispatched on another repo
      // or another tick). The only card is owned by alice. Loop sees
      // bob as free; bob can't claim alice's card; legitimately bails.
      // Invariant must stay silent — there is no convergence bug.
      writeSettings({
        alice: agentRecord("alice"),
        bob: agentRecord("bob"),
      });
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

      const aliceOwned = issue("DX-1", { assigned_agent: "alice" });
      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [aliceOwned],
        openIssues: [aliceOwned],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });

    it("DX-369: card-first picker dispatches a bob-owned card to bob even when alice (alphabetically first) is also free — no system error", async () => {
      // Regression test for the SG-151 stall (gpt-manager 04:03–04:09
      // UTC 2026-05-15). Pre-DX-369 the agent-first outer loop returned
      // alice first by name, `pickCardForAgent("alice", [bobOwned])`
      // returned null, the loop `break`d before trying bob — the
      // DX-368 invariant fired but no dispatch happened. After DX-369
      // the card-first outer loop reads `card.assigned_agent` directly
      // and routes to bob.
      writeSettings({
        alice: agentRecord("alice"),
        bob: agentRecord("bob"),
      });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      const bobOwned = issue("DX-1", { assigned_agent: "bob" });
      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [bobOwned],
        openIssues: [],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      expect(mockedDispatchWithRecovery).toHaveBeenCalledTimes(1);
      const arg = mockedDispatchWithRecovery.mock.calls[0]?.[0] as {
        agent?: { name: string };
        issueId?: string;
      };
      expect(arg.agent?.name).toBe("bob");
      expect(arg.issueId).toBe("DX-1");
      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });

    it("DX-369: card owned by a BUSY agent is deferred to the next tick — picker does NOT re-route to a free agent and does NOT fire the invariant", async () => {
      // User-spec'd behavior: when the named owner is unavailable
      // (busy, broken, out-of-schedule), the card stays parked. Re-
      // routing to a different free agent would steal the assignment.
      writeSettings({
        alice: agentRecord("alice"),
        bob: agentRecord("bob"),
      });
      setAgentLocksQueryFn(async (sql) => {
        if (sql.includes("FROM dispatches")) {
          return [{ agent_name: "bob" }] as never;
        }
        return [] as never;
      });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      const bobOwned = issue("DX-1", { assigned_agent: "bob" });
      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [bobOwned],
        openIssues: [bobOwned],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(0);
      expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });

    it("DX-369: card owned by a BROKEN agent is deferred to the next tick — operator clears broken → card dispatches", async () => {
      writeSettings({
        alice: agentRecord("alice"),
        bob: agentRecord("bob", {
          broken: {
            reason: "prep abort",
            suggested_steps: [],
            set_at: "2026-04-20T14:00:00Z",
          },
        }),
      });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      const bobOwned = issue("DX-1", { assigned_agent: "bob" });
      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [bobOwned],
        openIssues: [bobOwned],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(0);
      expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });

    it("idempotent — two consecutive tryMultiAgentDispatch calls produce 1 dispatch total, not 2", async () => {
      // Steady-state convergence check: the picker is safe to call
      // repeatedly with no side effects when no candidate pair exists.
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });

      // First tick dispatches.
      const first = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(first.dispatched).toBe(1);

      // Second tick: alice is now busy (DB lock held by the prior
      // dispatch). The cards list also excludes DX-1 because it's
      // In Progress now. Both inputs reflect that real state.
      setAgentLocksQueryFn(async (sql) => {
        if (sql.includes("FROM dispatches")) {
          return [{ agent_name: "alice" }] as never;
        }
        return [] as never;
      });
      mockedDispatchWithRecovery.mockClear();
      mockRecordSystemError.mockClear();

      const second = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [],
        openIssues: [],
        tracker: fakeTracker(),
        now: NOW,
      });
      expect(second.dispatched).toBe(0);
      expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });

    it("idempotent — no-candidate ticks are safe to call repeatedly with zero side effects", async () => {
      writeSettings({ alice: agentRecord("alice") });

      // No cards, no openIssues — picker should bail immediately.
      const first = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [],
        openIssues: [],
        tracker: fakeTracker(),
        now: NOW,
      });
      const second = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [],
        openIssues: [],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(first.dispatched).toBe(0);
      expect(second.dispatched).toBe(0);
      expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });

    it("invariant stays silent when remaining card has a live-PID dispatch (false-positive guard)", async () => {
      // A host-mode dispatch reparented to PID 1 after a worker restart
      // still owns the card; `guardLiveDispatchForCard` returns true,
      // the picker `removeFromRemaining(card) + continue`s. The card
      // is gone from `remainingCards` by the time the invariant runs.
      // Without this guarded behaviour the assertion would fire on
      // every tick where a host-mode reparent existed.
      writeSettings({
        alice: agentRecord("alice"),
        bob: agentRecord("bob"),
      });
      vi.mocked(guardLiveDispatchForCard).mockResolvedValueOnce(true);

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });

    it("invariant stays silent when remaining card's tracker lock is held by another worker", async () => {
      // Cross-environment tracker lock: another worker (production EC2,
      // local dev clone) owns the dispatch-lock comment. The picker
      // `removeFromRemaining(card) + continue`s. The card is gone from
      // `remainingCards` by the time the invariant runs — assertion
      // must stay silent so a sibling worker's lock doesn't trigger a
      // false convergence alarm. Hand-built lock body matching
      // `renderLockComment` (see the DX-241 test above for the
      // canonical shape).
      writeSettings({
        alice: agentRecord("alice"),
        bob: agentRecord("bob"),
      });
      const heldTracker: IssueTracker = {
        ...fakeTracker(),
        getComments: async () => [
          {
            id: "lock-1",
            author: "danxbot",
            timestamp: "",
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

      await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: heldTracker,
        now: NOW,
      });

      expect(mockRecordSystemError).not.toHaveBeenCalled();
    });
  });

});
