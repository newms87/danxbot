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
    worktreePath: vi.fn(),
    bootstrap: vi.fn(),
    teardown: vi.fn(),
    validate: vi.fn().mockResolvedValue({ state: "clean" }),
    resetClean: vi.fn(),
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
    })),
    loadLocal: vi.fn(async () => null),
    writeIssue: vi.fn(async () => undefined),
  };
});

import { tryMultiAgentDispatch } from "./multi-agent-pick.js";
import { runConflictCheck } from "../dispatch/conflict-check.js";
import { dispatchWithRecovery } from "../dispatch/recovery-mode.js";
import {
  guardLiveDispatchForCard,
  runPostDispatchProgressCheck,
} from "../dispatch/scheduler.js";
import { clearDispatchAndWrite, loadLocal } from "./yaml-lifecycle.js";
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
    schema_version: 6,
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
    mockedDispatchWithRecovery.mockResolvedValue({
      dispatchId: "did",
      job: {} as never,
    });
    mockedRunConflictCheck.mockResolvedValue({ ok: true, reason: "no overlap" });

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
      ok: false,
      reason: "overlaps with launcher.ts",
      blocked_by: ["DX-141"],
    });

    const yl = await import("./yaml-lifecycle.js");
    vi.mocked(yl.loadLocal).mockResolvedValue(issue("DX-1"));

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
    // The blocked card was written via writeIssue with status="Blocked".
    expect(yl.writeIssue).toHaveBeenCalled();
    const writeCall = vi.mocked(yl.writeIssue).mock.calls[0];
    expect(writeCall[1].status).toBe("Blocked");
    expect(writeCall[1].blocked).toMatchObject({
      reason: expect.stringContaining("Conflict-check rejection"),
    });
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
    // Make loadLocal return a fresh issue carrying a stale dispatch
    // block so the cleanup branch actually runs (the default mock
    // returns null → cleanup short-circuits).
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
});
