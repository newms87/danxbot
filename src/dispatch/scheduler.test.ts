/**
 * Unit tests for the per-repo dispatch scheduler (Phase 4 / DX-219).
 *
 * Covers the four ports from the legacy `_poll` single-card path onto
 * the multi-agent dispatch path:
 *
 *   - AC #1: tracker-comment lock helpers re-exported.
 *   - AC #2: `guardLiveDispatchForCard` delegates to `hasLiveDispatchForCard`.
 *   - AC #3: `bootScheduler` validates TrelloTracker creds + registers
 *     the tracker.
 *   - AC #4: `runPostDispatchProgressCheck` writes the CRITICAL_FAILURE
 *     flag when a tracked card stayed in ToDo, and respects every
 *     skip-branch (no tracker registered, card moved, waiting_on,
 *     tracker error, YAML read error).
 *
 * Test isolation: `_resetSchedulerTrackers()` runs in beforeEach so a
 * stale tracker registration from a prior test does not leak.
 * `writeFlag` is mocked at module-load time so the test never touches
 * the filesystem.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { Dispatch } from "../dashboard/dispatches.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";

vi.mock("../critical-failure.js", () => ({
  writeFlag: vi.fn(),
}));

vi.mock("../dashboard/dispatches-db.js", () => ({
  findNonTerminalDispatches: vi.fn().mockResolvedValue([]),
}));

vi.mock("../agent/host-pid.js", () => ({
  isPidAlive: vi.fn().mockReturnValue(false),
}));

vi.mock("../poller/yaml-lifecycle.js", () => ({
  findByExternalId: vi.fn().mockResolvedValue(null),
}));

import { writeFlag } from "../critical-failure.js";
import { findNonTerminalDispatches } from "../dashboard/dispatches-db.js";
import { isPidAlive } from "../agent/host-pid.js";
import { findByExternalId } from "../poller/yaml-lifecycle.js";
import {
  _resetSchedulerTrackers,
  bootScheduler,
  buildLockHolderInfo,
  getSchedulerTracker,
  guardLiveDispatchForCard,
  onAgentRosterChange,
  onReconcileResult,
  releaseLock,
  runPostDispatchProgressCheck,
  type RunPickerFn,
  tryAcquireLock,
  unwatchSettingsFileForRepo,
} from "./scheduler.js";
import type { ReconcileResult } from "../issue/reconcile-types.js";
import type { ReconcileRepoContext } from "../issue/reconcile.js";
import { TrelloTracker } from "../issue-tracker/trello.js";
import { MemoryTracker } from "../issue-tracker/memory.js";

function makeTrelloConfig(): import("../types.js").TrelloConfig {
  return {
    apiKey: "key-x",
    apiToken: "tok-x",
    boardId: "board-x",
    reviewListId: "review",
    todoListId: "todo",
    inProgressListId: "in-progress",
    needsHelpListId: "needs-help",
    doneListId: "done",
    cancelledListId: "cancelled",
    actionItemsListId: "action-items",
    bugLabelId: "bug",
    featureLabelId: "feature",
    epicLabelId: "epic",
    needsHelpLabelId: "needs-help",
    blockedLabelId: "blocked",
    requiresHumanLabelId: "requires-human",
  };
}

function makeRepo(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    name: "danxbot",
    url: "git@github.com:newms87/danxbot.git",
    localPath: "/tmp/fake-repo",
    hostPath: "/tmp/fake-repo",
    trello: makeTrelloConfig(),
    trelloEnabled: true,
    slack: {
      enabled: false,
      botToken: "",
      appToken: "",
      channelId: "",
    },
    db: {
      host: "localhost",
      port: 5432,
      user: "x",
      password: "x",
      database: "x",
      enabled: false,
    },
    githubToken: "",
    workerPort: 5050,
    issuePrefix: "DX",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "DX-1",
    external_id: "card-x",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Test card",
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
    waiting_on: null,
    requires_human: null,
    assigned_agent: null,
    priority: 3,
    ...overrides,
  } as Issue;
}

function makeMemoryTracker(): IssueTracker {
  const tracker = new MemoryTracker();
  return tracker;
}

function makeFakeTracker(getCardImpl: () => Promise<Issue> | Issue): IssueTracker {
  return {
    fetchOpenCards: async () => [],
    isValidExternalId: () => true,
    getCard: async (id: string) => {
      const result = getCardImpl();
      return result instanceof Promise ? await result : result;
    },
  } as unknown as IssueTracker;
}

function makeTrelloTracker(): TrelloTracker {
  // TrelloTracker constructor requires a full trello config. Pass a
  // populated stub — the scheduler check only inspects RepoContext, not
  // the tracker instance's internal config.
  return new TrelloTracker(makeTrelloConfig());
}

beforeEach(() => {
  _resetSchedulerTrackers();
  (writeFlag as Mock).mockClear();
  (findNonTerminalDispatches as Mock).mockReset().mockResolvedValue([]);
  (isPidAlive as Mock).mockReset().mockReturnValue(false);
  (findByExternalId as Mock).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  _resetSchedulerTrackers();
});

describe("bootScheduler (AC #3)", () => {
  it("registers a MemoryTracker without credential checks", () => {
    const repo = makeRepo({ trello: undefined as unknown as RepoContext["trello"] });
    const tracker = makeMemoryTracker();

    expect(() => bootScheduler({ repo, tracker })).not.toThrow();
    expect(getSchedulerTracker(repo.name)).toBe(tracker);
  });

  it("registers a TrelloTracker when creds are complete", () => {
    const repo = makeRepo();
    const tracker = makeTrelloTracker();

    expect(() => bootScheduler({ repo, tracker })).not.toThrow();
    expect(getSchedulerTracker(repo.name)).toBe(tracker);
  });

  it("throws fail-loud when TrelloTracker has missing apiKey", () => {
    const repo = makeRepo({
      trello: {
        ...makeRepo().trello!,
        apiKey: "",
      },
    });
    const tracker = makeTrelloTracker();

    expect(() => bootScheduler({ repo, tracker })).toThrow(
      /boot validation failed for repo "danxbot"/,
    );
    expect(getSchedulerTracker(repo.name)).toBeUndefined();
  });

  it("throws fail-loud when TrelloTracker has missing apiToken", () => {
    const repo = makeRepo({
      trello: {
        ...makeRepo().trello!,
        apiToken: "",
      },
    });
    const tracker = makeTrelloTracker();

    expect(() => bootScheduler({ repo, tracker })).toThrow(
      /apiToken=false/,
    );
  });

  it("throws fail-loud when TrelloTracker has missing boardId", () => {
    const repo = makeRepo({
      trello: {
        ...makeRepo().trello!,
        boardId: "",
      },
    });
    const tracker = makeTrelloTracker();

    expect(() => bootScheduler({ repo, tracker })).toThrow(
      /boardId=false/,
    );
  });

  it("throws when TrelloTracker is used but RepoContext has no trello block at all", () => {
    const repo = makeRepo({ trello: undefined as unknown as RepoContext["trello"] });
    const tracker = makeTrelloTracker();

    expect(() => bootScheduler({ repo, tracker })).toThrow(
      /boot validation failed/,
    );
  });

  it("is idempotent — re-registering the same repo updates the tracker reference", () => {
    const repo = makeRepo();
    const trackerA = makeMemoryTracker();
    const trackerB = makeMemoryTracker();

    bootScheduler({ repo, tracker: trackerA });
    expect(getSchedulerTracker(repo.name)).toBe(trackerA);

    bootScheduler({ repo, tracker: trackerB });
    expect(getSchedulerTracker(repo.name)).toBe(trackerB);
  });
});

describe("guardLiveDispatchForCard (AC #2)", () => {
  function makeRow(overrides: Partial<Dispatch> = {}): Dispatch {
    return {
      id: "job-id",
      repoName: "danxbot",
      trigger: "trello",
      triggerMetadata: {
        cardId: "card-x",
        cardName: "Card",
        cardUrl: "https://trello.com/c/card-x",
        listId: "list-1",
        listName: "ToDo",
      },
      slackThreadTs: null,
      slackChannelId: null,
      sessionUuid: null,
      jsonlPath: null,
      parentJobId: null,
      issueId: null,
      status: "running",
      startedAt: 1000,
      completedAt: null,
      summary: null,
      error: null,
      runtimeMode: "host",
      hostPid: 4242,
      hostPidAt: null,
      pidTerminatedAt: null,
      tokensTotal: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      toolCallCount: 0,
      subagentCount: 0,
      nudgeCount: 0,
      danxbotCommit: null,
      agentName: null,
      mcpSettingsPath: null,
      recoverCount: 0,
      parentRecoverId: null,
      ...overrides,
    };
  }

  it("returns true when a live PID owns the card — picker must skip", async () => {
    (findNonTerminalDispatches as Mock).mockResolvedValue([
      makeRow({ hostPid: process.pid }),
    ]);
    (isPidAlive as Mock).mockReturnValue(true);

    const live = await guardLiveDispatchForCard({
      repoName: "danxbot",
      cardId: "card-x",
    });

    expect(live).toBe(true);
  });

  it("returns false when no non-terminal dispatch exists for the card", async () => {
    (findNonTerminalDispatches as Mock).mockResolvedValue([]);

    const live = await guardLiveDispatchForCard({
      repoName: "danxbot",
      cardId: "card-x",
    });

    expect(live).toBe(false);
  });

  it("returns false when DB lookup throws — fail-open (defense-in-depth via lock)", async () => {
    (findNonTerminalDispatches as Mock).mockRejectedValue(new Error("db down"));

    const live = await guardLiveDispatchForCard({
      repoName: "danxbot",
      cardId: "card-x",
    });

    expect(live).toBe(false);
  });

  it("forwards internalIssueId so auto-resume children with `trigger:api` are matched", async () => {
    (findNonTerminalDispatches as Mock).mockResolvedValue([
      makeRow({
        trigger: "api",
        triggerMetadata: {} as Dispatch["triggerMetadata"],
        issueId: "DX-219",
        hostPid: process.pid,
      }),
    ]);
    (isPidAlive as Mock).mockReturnValue(true);

    const live = await guardLiveDispatchForCard({
      repoName: "danxbot",
      cardId: "card-x",
      internalIssueId: "DX-219",
    });

    expect(live).toBe(true);
  });
});

describe("runPostDispatchProgressCheck (AC #4)", () => {
  const baseInput = {
    cardId: "card-x",
    jobId: "job-1",
    jobStatus: "completed",
    jobSummary: "ok",
  };

  it("writes the CRITICAL_FAILURE flag when the tracked card stayed in ToDo", async () => {
    const repo = makeRepo();
    const tracker = makeFakeTracker(() =>
      makeIssue({ status: "ToDo", title: "Stuck card" }),
    );
    bootScheduler({ repo, tracker });
    (findByExternalId as Mock).mockResolvedValue(null);

    await runPostDispatchProgressCheck({ repo, ...baseInput });

    expect(writeFlag).toHaveBeenCalledTimes(1);
    const call = (writeFlag as Mock).mock.calls[0];
    expect(call[0]).toBe(repo.localPath);
    expect(call[1].source).toBe("post-dispatch-check");
    expect(call[1].dispatchId).toBe(baseInput.jobId);
    expect(call[1].cardId).toBe(baseInput.cardId);
    expect(call[1].reason).toMatch(/did not move out of ToDo/);
  });

  it("does NOT write the flag when the card moved to In Progress", async () => {
    const repo = makeRepo();
    const tracker = makeFakeTracker(() =>
      makeIssue({ status: "In Progress" }),
    );
    bootScheduler({ repo, tracker });

    await runPostDispatchProgressCheck({ repo, ...baseInput });

    expect(writeFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when the card moved to Done", async () => {
    const repo = makeRepo();
    const tracker = makeFakeTracker(() => makeIssue({ status: "Done" }));
    bootScheduler({ repo, tracker });

    await runPostDispatchProgressCheck({ repo, ...baseInput });

    expect(writeFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when the local YAML has waiting_on (intentional park)", async () => {
    const repo = makeRepo();
    const tracker = makeFakeTracker(() => makeIssue({ status: "ToDo" }));
    bootScheduler({ repo, tracker });
    (findByExternalId as Mock).mockResolvedValue(
      makeIssue({
        status: "ToDo",
        waiting_on: {
          reason: "Waiting on DX-218",
          timestamp: "2026-05-10T00:00:00Z",
          by: ["DX-218"],
        },
      }),
    );

    await runPostDispatchProgressCheck({ repo, ...baseInput });

    expect(writeFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when tracker.getCard throws — false-negative is safer than false-positive", async () => {
    const repo = makeRepo();
    const tracker = makeFakeTracker(() => {
      throw new Error("transient tracker outage");
    });
    bootScheduler({ repo, tracker });

    await expect(
      runPostDispatchProgressCheck({ repo, ...baseInput }),
    ).resolves.toBeUndefined();
    expect(writeFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when findByExternalId throws — same false-negative discipline", async () => {
    const repo = makeRepo();
    const tracker = makeFakeTracker(() => makeIssue({ status: "ToDo" }));
    bootScheduler({ repo, tracker });
    (findByExternalId as Mock).mockRejectedValue(new Error("fs ENOENT"));

    await runPostDispatchProgressCheck({ repo, ...baseInput });

    expect(writeFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when no tracker is registered (bootScheduler not called)", async () => {
    const repo = makeRepo({ name: "unregistered-repo" });

    await runPostDispatchProgressCheck({ repo, ...baseInput });

    expect(writeFlag).not.toHaveBeenCalled();
  });

  it("uses the repo's registered tracker, not a global one", async () => {
    const repoA = makeRepo({ name: "repo-a", localPath: "/tmp/repo-a" });
    const repoB = makeRepo({ name: "repo-b", localPath: "/tmp/repo-b" });

    const trackerA = makeFakeTracker(() =>
      makeIssue({ status: "ToDo", title: "A's card" }),
    );
    const trackerB = makeFakeTracker(() =>
      makeIssue({ status: "Done", title: "B's card" }),
    );

    bootScheduler({ repo: repoA, tracker: trackerA });
    bootScheduler({ repo: repoB, tracker: trackerB });

    await runPostDispatchProgressCheck({ repo: repoA, ...baseInput });
    expect(writeFlag).toHaveBeenCalledTimes(1);
    expect((writeFlag as Mock).mock.calls[0][0]).toBe("/tmp/repo-a");

    await runPostDispatchProgressCheck({ repo: repoB, ...baseInput });
    // Still 1 — repo-b's card was Done, no second flag.
    expect(writeFlag).toHaveBeenCalledTimes(1);
  });
});

describe("AC #1 — lock helpers re-exported from scheduler", () => {
  // Identity tests on `typeof === "function"` add zero coverage —
  // typecheck pins the re-export shape, and every consumer's import
  // site fails at compile time if the helpers are missing. The
  // re-exports' real proof-of-life is `multi-agent-pick.ts` resolving
  // them through `../dispatch/scheduler.js` and the multi-agent dispatch
  // tests passing. Kept as a comment so the next reviewer doesn't
  // resurrect a typeof check.
  //
  // What this describe block exists to document: the scheduler module
  // is the single API surface for AC #1's protection. `tryAcquireLock`,
  // `releaseLock`, and `buildLockHolderInfo` are imported from
  // `../dispatch/scheduler.js` by every dispatch coordinator going
  // forward.
  it("delegates to the real lock helper from ../issue-tracker/lock.js (no shadowing wrapper)", async () => {
    const lock = await import("../issue-tracker/lock.js");
    expect(tryAcquireLock).toBe(lock.tryAcquireLock);
    expect(releaseLock).toBe(lock.releaseLock);
    expect(buildLockHolderInfo).toBe(lock.buildLockHolderInfo);
  });
});

describe("onReconcileResult — Phase 4b.1 (DX-288)", () => {
  function makeReconcileRepo(name = "danxbot"): ReconcileRepoContext {
    return { name, localPath: `/tmp/${name}`, issuePrefix: "DX" };
  }

  function makeResult(dispatchableChanged: boolean): ReconcileResult {
    return {
      changed: false,
      prevHash: null,
      nextHash: "",
      errors: [],
      fanout: {
        parentId: null,
        dependents: [],
        dispatchableChanged,
      },
    };
  }

  function waitMacrotask(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }

  it("invokes the registered picker exactly once when dispatchableChanged is true", async () => {
    const repo = makeReconcileRepo();
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo({ name: repo.name }),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });

    onReconcileResult({ repo, result: makeResult(true) });
    await waitMacrotask();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0]?.[0].now).toBeInstanceOf(Date);
  });

  it("no-op when dispatchableChanged is false", async () => {
    const repo = makeReconcileRepo();
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo({ name: repo.name }),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });

    onReconcileResult({ repo, result: makeResult(false) });
    await waitMacrotask();

    expect(picker).not.toHaveBeenCalled();
  });

  it("no-op when no picker is registered for the repo (does not throw, does not queue work)", async () => {
    const repo = makeReconcileRepo();
    // bootScheduler without runPicker
    bootScheduler({
      repo: makeRepo({ name: repo.name }),
      tracker: makeMemoryTracker(),
    });

    // Must not throw. Subsequent bootScheduler with a picker AND a
    // result must run the new picker — proving the earlier no-poke
    // poke did NOT leave a stale `pendingPokes` entry that would
    // suppress the next legitimate fire.
    expect(() =>
      onReconcileResult({ repo, result: makeResult(true) }),
    ).not.toThrow();
    await waitMacrotask();

    const followupPicker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo({ name: repo.name }),
      tracker: makeMemoryTracker(),
      runPicker: followupPicker,
    });
    onReconcileResult({ repo, result: makeResult(true) });
    await waitMacrotask();
    expect(followupPicker).toHaveBeenCalledTimes(1);
  });

  it("debounces 2+ back-to-back pokes for the same repo into a single picker invocation", async () => {
    const repo = makeReconcileRepo();
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo({ name: repo.name }),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });

    onReconcileResult({ repo, result: makeResult(true) });
    onReconcileResult({ repo, result: makeResult(true) });
    onReconcileResult({ repo, result: makeResult(true) });
    await waitMacrotask();

    expect(picker).toHaveBeenCalledTimes(1);
  });

  it("after a debounced burst fires, a subsequent poke schedules another run", async () => {
    const repo = makeReconcileRepo();
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo({ name: repo.name }),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });

    onReconcileResult({ repo, result: makeResult(true) });
    onReconcileResult({ repo, result: makeResult(true) });
    await waitMacrotask();
    expect(picker).toHaveBeenCalledTimes(1);

    onReconcileResult({ repo, result: makeResult(true) });
    await waitMacrotask();
    expect(picker).toHaveBeenCalledTimes(2);
  });

  it("debouncing is per-repo — concurrent pokes for different repos each fire their own picker", async () => {
    const repoA = makeReconcileRepo("repo-a");
    const repoB = makeReconcileRepo("repo-b");
    const pickerA = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    const pickerB = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo({ name: repoA.name }),
      tracker: makeMemoryTracker(),
      runPicker: pickerA,
    });
    bootScheduler({
      repo: makeRepo({ name: repoB.name }),
      tracker: makeMemoryTracker(),
      runPicker: pickerB,
    });

    onReconcileResult({ repo: repoA, result: makeResult(true) });
    onReconcileResult({ repo: repoB, result: makeResult(true) });
    await waitMacrotask();

    expect(pickerA).toHaveBeenCalledTimes(1);
    expect(pickerB).toHaveBeenCalledTimes(1);
  });

  it("a rejecting picker does not propagate or cause subsequent pokes to fail", async () => {
    const repo = makeReconcileRepo();
    const picker = vi
      .fn<RunPickerFn>()
      .mockRejectedValueOnce(new Error("picker boom"))
      .mockResolvedValueOnce(undefined);
    bootScheduler({
      repo: makeRepo({ name: repo.name }),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });

    onReconcileResult({ repo, result: makeResult(true) });
    await waitMacrotask();
    expect(picker).toHaveBeenCalledTimes(1);

    // Subsequent poke still schedules a fresh run despite the prior rejection.
    onReconcileResult({ repo, result: makeResult(true) });
    await waitMacrotask();
    expect(picker).toHaveBeenCalledTimes(2);
  });

  it("bootScheduler re-boot without a picker clears any prior registration for the repo", async () => {
    const repo = makeReconcileRepo();
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo({ name: repo.name }),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });
    // Re-boot without runPicker — picker should be cleared.
    bootScheduler({
      repo: makeRepo({ name: repo.name }),
      tracker: makeMemoryTracker(),
    });

    onReconcileResult({ repo, result: makeResult(true) });
    await waitMacrotask();

    expect(picker).not.toHaveBeenCalled();
  });
});

describe("runPostDispatchProgressCheck — flag-detail formatting", () => {
  it("substitutes 'none' for an empty job summary and propagates the job status verbatim", async () => {
    const repo = makeRepo();
    const tracker = makeFakeTracker(() => makeIssue({ status: "ToDo" }));
    bootScheduler({ repo, tracker });

    await runPostDispatchProgressCheck({
      repo,
      cardId: "card-x",
      jobId: "job-empty",
      jobStatus: "failed",
      jobSummary: "",
    });

    expect(writeFlag).toHaveBeenCalledTimes(1);
    const detail = (writeFlag as Mock).mock.calls[0][1].detail;
    expect(detail).toContain("status=failed");
    expect(detail).toContain("summary=none");
  });

  it("forwards the original summary text when present (no truncation)", async () => {
    const repo = makeRepo();
    const tracker = makeFakeTracker(() => makeIssue({ status: "ToDo" }));
    bootScheduler({ repo, tracker });

    await runPostDispatchProgressCheck({
      repo,
      cardId: "card-x",
      jobId: "job-summed",
      jobStatus: "completed",
      jobSummary: "Refactored the foo into bar",
    });

    const detail = (writeFlag as Mock).mock.calls[0][1].detail;
    expect(detail).toContain("status=completed");
    expect(detail).toContain("summary=Refactored the foo into bar");
  });
});

describe("onAgentRosterChange — Phase 4b.2 (DX-289)", () => {
  function waitMacrotask(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }

  afterEach(async () => {
    await unwatchSettingsFileForRepo("danxbot");
    await unwatchSettingsFileForRepo("repo-a");
    await unwatchSettingsFileForRepo("repo-b");
  });

  it("invokes the registered picker exactly once when called", async () => {
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo(),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });

    onAgentRosterChange("danxbot");
    await waitMacrotask();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0]?.[0].now).toBeInstanceOf(Date);
  });

  it("no-op when no picker is registered (empty roster scenario)", async () => {
    bootScheduler({
      repo: makeRepo(),
      tracker: makeMemoryTracker(),
    });

    expect(() => onAgentRosterChange("danxbot")).not.toThrow();
    await waitMacrotask();
    // No throws, no work scheduled — verified by reaching this point
    // without a picker mock having been invoked.
  });

  it("debounces 2+ back-to-back pokes for the same repo into a single picker invocation", async () => {
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo(),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });

    onAgentRosterChange("danxbot");
    onAgentRosterChange("danxbot");
    onAgentRosterChange("danxbot");
    await waitMacrotask();

    expect(picker).toHaveBeenCalledTimes(1);
  });

  it("debounce is per-repo — concurrent pokes for different repos each fire their own picker", async () => {
    const pickerA = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    const pickerB = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo({ name: "repo-a" }),
      tracker: makeMemoryTracker(),
      runPicker: pickerA,
    });
    bootScheduler({
      repo: makeRepo({ name: "repo-b" }),
      tracker: makeMemoryTracker(),
      runPicker: pickerB,
    });

    onAgentRosterChange("repo-a");
    onAgentRosterChange("repo-b");
    await waitMacrotask();

    expect(pickerA).toHaveBeenCalledTimes(1);
    expect(pickerB).toHaveBeenCalledTimes(1);
  });

  it("after a debounced burst fires, a subsequent poke schedules another run", async () => {
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    bootScheduler({
      repo: makeRepo(),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });

    onAgentRosterChange("danxbot");
    onAgentRosterChange("danxbot");
    await waitMacrotask();
    expect(picker).toHaveBeenCalledTimes(1);

    onAgentRosterChange("danxbot");
    await waitMacrotask();
    expect(picker).toHaveBeenCalledTimes(2);
  });

  it("a rejecting picker does not propagate or block subsequent pokes", async () => {
    const picker = vi
      .fn<RunPickerFn>()
      .mockRejectedValueOnce(new Error("picker boom"))
      .mockResolvedValueOnce(undefined);
    bootScheduler({
      repo: makeRepo(),
      tracker: makeMemoryTracker(),
      runPicker: picker,
    });

    onAgentRosterChange("danxbot");
    await waitMacrotask();
    expect(picker).toHaveBeenCalledTimes(1);

    onAgentRosterChange("danxbot");
    await waitMacrotask();
    expect(picker).toHaveBeenCalledTimes(2);
  });
});

describe("bootScheduler — settings-watch + onAgentRosterChange end-to-end (DX-289)", () => {
  function waitMacrotask(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }

  let tmpRepoDir: string;
  let repoCtx: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { resolve } = await import("node:path");
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-sched-watch-"));
    mkdirSync(resolve(tmpRepoDir, ".danxbot"), { recursive: true });
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "issues", "open"), {
      recursive: true,
    });
    writeFileSync(
      resolve(tmpRepoDir, ".danxbot", "settings.json"),
      JSON.stringify({
        version: 2,
        overrides: {},
        display: {},
        agents: {},
        agentDefaults: { conflictCheckEnabled: true },
        meta: {
          updatedAt: new Date(0).toISOString(),
          updatedBy: "worker",
        },
      }),
    );
    repoCtx = makeRepo({ name: "danxbot-watch", localPath: tmpRepoDir });
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    await import("./scheduler.js").then((m) =>
      m.unwatchSettingsFileForRepo("danxbot-watch"),
    );
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("settings.json writes flow through watchSettingsFile → onAgentRosterChange → registered picker", async () => {
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    const reconcileSpy = vi.fn().mockResolvedValue({
      changed: false,
      prevHash: null,
      nextHash: "",
      errors: [],
      fanout: {
        parentId: null,
        dependents: [],
        dispatchableChanged: false,
      },
    });
    bootScheduler({
      repo: repoCtx,
      tracker: makeMemoryTracker(),
      runPicker: picker,
      reconcile: reconcileSpy,
    });

    // Chokidar attaches asynchronously; give it a moment.
    await new Promise((r) => setTimeout(r, 250));

    const { writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    writeFileSync(
      resolve(tmpRepoDir, ".danxbot", "settings.json"),
      JSON.stringify({ v: 2, marker: "first" }),
    );

    // Wait for chokidar's awaitWriteFinish (200ms stability) + the
    // setImmediate that schedules the picker.
    await new Promise((r) => setTimeout(r, 500));
    await waitMacrotask();

    expect(picker).toHaveBeenCalledTimes(1);
  });

  it("rapid-fire double settings.json writes coalesce into a single picker invocation (AC #3)", async () => {
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    const reconcileSpy = vi.fn().mockResolvedValue({
      changed: false,
      prevHash: null,
      nextHash: "",
      errors: [],
      fanout: {
        parentId: null,
        dependents: [],
        dispatchableChanged: false,
      },
    });
    bootScheduler({
      repo: repoCtx,
      tracker: makeMemoryTracker(),
      runPicker: picker,
      reconcile: reconcileSpy,
    });
    await new Promise((r) => setTimeout(r, 250));

    const { writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const settingsPath = resolve(tmpRepoDir, ".danxbot", "settings.json");

    writeFileSync(settingsPath, JSON.stringify({ v: 1 }));
    writeFileSync(settingsPath, JSON.stringify({ v: 2 }));
    writeFileSync(settingsPath, JSON.stringify({ v: 3 }));

    // awaitWriteFinish (200ms stability) collapses the burst into a
    // single chokidar emit, and the scheduler's pendingRosterPokes
    // debounce coalesces any remaining edges to a single picker call.
    await new Promise((r) => setTimeout(r, 500));
    await waitMacrotask();

    expect(picker).toHaveBeenCalledTimes(1);
  });

  it("re-boot with reconcile replaces the prior watcher (idempotent over hot-reload)", async () => {
    const picker = vi.fn<RunPickerFn>().mockResolvedValue(undefined);
    const reconcileSpy = vi.fn().mockResolvedValue({
      changed: false,
      prevHash: null,
      nextHash: "",
      errors: [],
      fanout: {
        parentId: null,
        dependents: [],
        dispatchableChanged: false,
      },
    });

    bootScheduler({
      repo: repoCtx,
      tracker: makeMemoryTracker(),
      runPicker: picker,
      reconcile: reconcileSpy,
    });
    await new Promise((r) => setTimeout(r, 250));

    // Re-boot — the prior watcher MUST be drained before the new one
    // is armed; otherwise a single write fires two picker pokes.
    bootScheduler({
      repo: repoCtx,
      tracker: makeMemoryTracker(),
      runPicker: picker,
      reconcile: reconcileSpy,
    });
    await new Promise((r) => setTimeout(r, 250));

    const { writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    writeFileSync(
      resolve(tmpRepoDir, ".danxbot", "settings.json"),
      JSON.stringify({ v: 99 }),
    );

    await new Promise((r) => setTimeout(r, 500));
    await waitMacrotask();

    // Single watcher, single poke — not two pokes from a leaked watcher.
    expect(picker).toHaveBeenCalledTimes(1);
  });
});
