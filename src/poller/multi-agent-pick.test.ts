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
      // assigned_agent stays — production preserves the stamp as
      // durable audit + as the "self-claim" marker the picker reads
      // on the next tick (see yaml-lifecycle.ts#clearDispatchAndWrite).
    })),
    loadLocal: vi.fn(async () => null),
    loadLocalFromDisk: vi.fn(() => null),
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
import { _resetQuarantine } from "../dispatch/quarantine.js";
import {
  clearDispatchAndWrite,
  loadLocalFromDisk,
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
  // DX-221 — quarantine state is in-memory + module-scoped; reset
  // between tests so a failed dispatch in one test does not skip the
  // agent + card in the next.
  _resetQuarantine();
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
     * just-stamped `dispatch:` block on the YAML.
     */
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockRejectedValueOnce(
      new Error("dispatch failed post-stamp"),
    );
    const lifecycle = await import("./yaml-lifecycle.js");
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
    expect(vi.mocked(runPostDispatchProgressCheck).mock.calls[0][0].cardId).toBe(
      "ext-DX-1",
    );
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

  // Co-ownership retired: with `assigned_agent` as durable audit,
  // multiple ToDo cards can legitimately name the same agent (re-bounced
  // cards, multi-phase work).
  it("does NOT clear duplicate assigned_agent across open cards (durable audit allows multi-claim)", async () => {
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
      tracker: fakeTracker(),
      now: NOW,
    });

    expect(clearDispatchAndWrite).not.toHaveBeenCalled();
    // First card dispatches; second is left untouched.
    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.issueId).toBe("DX-1");
  });

  it("AC #1: dispatch() throw post-stamp → end-state YAML has dispatch=null; assigned_agent stays as durable audit so the next tick self-claim path works", async () => {
    writeSettings({ alice: agentRecord("alice") });
    mockedDispatchWithRecovery.mockRejectedValueOnce(
      new Error("dispatch failed post-stamp"),
    );
    const lifecycle = await import("./yaml-lifecycle.js");
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
        tracker,
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
      expect(calls).toEqual(["ext-DX-1", "ext-DX-2"]);
    });
  });

  /**
   * DX-221 AC #2 — per-agent + per-card quarantine.
   */
  describe("DX-221: quarantine gates", () => {
    it("a quarantined agent is skipped — dispatch does NOT fire", async () => {
      const { quarantineAgent } = await import("../dispatch/quarantine.js");
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });
      quarantineAgent({
        repoName: "danxbot",
        agentName: "alice",
        reason: "test fixture",
        durationMs: 60_000,
        now: NOW.getTime(),
      });

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(0);
      expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
    });

    it("a quarantined card is skipped — dispatch does NOT fire", async () => {
      const { quarantineCard } = await import("../dispatch/quarantine.js");
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });
      quarantineCard({
        repoName: "danxbot",
        cardId: "DX-1",
        reason: "test fixture",
        durationMs: 60_000,
        now: NOW.getTime(),
      });

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(0);
      expect(mockedDispatchWithRecovery).not.toHaveBeenCalled();
    });

    it("an expired quarantine does NOT skip — picker proceeds normally", async () => {
      const { quarantineAgent } = await import("../dispatch/quarantine.js");
      writeSettings({ alice: agentRecord("alice") });
      mockedDispatchWithRecovery.mockResolvedValue({
        dispatchId: "did",
        job: {} as never,
      });
      quarantineAgent({
        repoName: "danxbot",
        agentName: "alice",
        reason: "ancient",
        durationMs: 1_000,
        now: NOW.getTime() - 60_000,
      });

      const result = await tryMultiAgentDispatch({
        repo: fakeRepo(),
        cards: [issue("DX-1")],
        tracker: fakeTracker(),
        now: NOW,
      });

      expect(result.dispatched).toBe(1);
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
      expect(dispatchInput.task).toBe("/danx-prep DX-1\n\n/danx-next DX-1");
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
      expect(dispatchInput.task).toBe("/danx-prep DX-1");
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
      expect(dispatchInput.task).toBe("/danx-prep DX-1\n\n/danx-next DX-1");
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
        "/danx-prep DX-1",
      );
      expect(mockedDispatchWithRecovery.mock.calls[0][0].dispatchKind).toBe(
        "prep",
      );
      expect(mockedDispatchWithRecovery.mock.calls[1][0].task).toBe(
        "/danx-prep DX-2",
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
      expect(tick1Dispatch.task).toBe("/danx-prep DX-1");
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
      expect(tick2Dispatch.task).toBe("/danx-prep DX-1\n\n/danx-next DX-1");
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

    it("legacy path: failed dispatch with NO prepVerdict (agent crashed before calling the verdict tool) → BOTH runPostDispatchProgressCheck AND quarantine accounting fire", async () => {
      // The DX-296 onComplete branching adds an `isPrepAbort` short-
      // circuit that skips quarantine accounting on `verdict=abort`.
      // It MUST NOT also short-circuit the legacy "agent crashed
      // mid-dispatch" path — those failures still need quarantine
      // (card + agent) so the picker doesn't hot-loop. Verdict ===
      // undefined is the discriminator.
      const { isAgentQuarantined, isCardQuarantined } = await import(
        "../dispatch/quarantine.js"
      );
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
      expect(
        isCardQuarantined({
          repoName: "danxbot",
          cardId: "DX-1",
          now: NOW.getTime() + 1_000,
        }),
      ).toBe(true);
      expect(
        isAgentQuarantined({
          repoName: "danxbot",
          agentName: "alice",
          now: NOW.getTime() + 1_000,
        }),
      ).toBe(true);
    });

    it("verdict=abort: SKIPS runPostDispatchProgressCheck AND skips card quarantine (env failure on agent's worktree, NOT card failure — quarantining the card would punish a future healthy agent)", async () => {
      const { isCardQuarantined, isAgentQuarantined } = await import(
        "../dispatch/quarantine.js"
      );
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
      // Neither the card nor the agent should be quarantined by the
      // failure-accounting branch — the route's broken stamp already
      // gates the agent at picker time.
      expect(
        isCardQuarantined({
          repoName: "danxbot",
          cardId: "DX-1",
          now: NOW.getTime() + 1_000,
        }),
      ).toBe(false);
      expect(
        isAgentQuarantined({
          repoName: "danxbot",
          agentName: "alice",
          now: NOW.getTime() + 1_000,
        }),
      ).toBe(false);
    });
  });
});
