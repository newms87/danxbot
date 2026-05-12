import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  armTtlTimer,
  clearTtlTimer,
  rearmTtlTimer,
  scanAndArmTtlTimers,
  _clearAllTtlTimers,
  _isTtlTimerArmed,
  _getTtlTimerArgs,
  type TtlTimerDeps,
} from "./ttl-timer.js";
import type { Dispatch } from "../dashboard/dispatches.js";
import { createEmptyIssue } from "../issue-tracker/yaml.js";
import type { ReconcileRepoContext } from "../issue/reconcile.js";
import type { ReconcileResult } from "../issue/reconcile-types.js";
import type { Issue } from "../issue-tracker/interface.js";

function emptyResult(): ReconcileResult {
  return {
    changed: false,
    prevHash: null,
    nextHash: "",
    errors: [],
    fanout: {
      parentId: null,
      dependents: [],
      dispatchableChanged: false,
    },
  };
}

function makeRepo(): ReconcileRepoContext {
  return { name: "danxbot", localPath: "/tmp/danxbot", issuePrefix: "DX" };
}

function makeIssue(): Issue {
  return {
    ...createEmptyIssue({ id: "DX-1", status: "In Progress", title: "Card" }),
    dispatch: {
      id: "dispatch-1",
      pid: 1234,
      host: "host-a",
      kind: "work",
      started_at: "2026-05-01T00:00:00Z",
      ttl_seconds: 7200,
    },
  };
}

describe("ttl-timer", () => {
  let deps: TtlTimerDeps;
  let repo: ReconcileRepoContext;

  beforeEach(() => {
    vi.useFakeTimers();
    repo = makeRepo();
    deps = {
      isPidAlive: vi.fn<TtlTimerDeps["isPidAlive"]>().mockReturnValue(true),
      reconcile: vi
        .fn<TtlTimerDeps["reconcile"]>()
        .mockResolvedValue(emptyResult()),
      clearDispatch: vi
        .fn<TtlTimerDeps["clearDispatch"]>()
        .mockImplementation(async (_path, issue) => ({
          ...issue,
          dispatch: null,
        })),
      loadIssue: vi
        .fn<TtlTimerDeps["loadIssue"]>()
        .mockResolvedValue(makeIssue()),
    };
    _clearAllTtlTimers();
  });

  afterEach(() => {
    _clearAllTtlTimers();
    vi.useRealTimers();
  });

  describe("armTtlTimer", () => {
    it("arms a timer that fires after ttlMs", async () => {
      // pid=0 sentinel re-arms instead of clearing — use a real PID to
      // exercise the dead-PID path on expiry.
      (deps.isPidAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 5000,
        deps,
      });

      expect(_isTtlTimerArmed("dispatch-1")).toBe(true);
      vi.advanceTimersByTime(4999);
      expect(deps.isPidAlive).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      // Flush microtasks for the async cleanup chain.
      await vi.runAllTimersAsync();
      expect(deps.isPidAlive).toHaveBeenCalledWith(1234);
      expect(deps.loadIssue).toHaveBeenCalled();
      expect(deps.clearDispatch).toHaveBeenCalled();
      expect(deps.reconcile).toHaveBeenCalledWith(repo, "DX-1", "audit");
      expect(_isTtlTimerArmed("dispatch-1")).toBe(false);
    });

    it("clears the prior timer when re-armed for the same dispatch", () => {
      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 5000,
        deps,
      });
      const firstArgs = _getTtlTimerArgs("dispatch-1");
      expect(firstArgs?.ttlMs).toBe(5000);

      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 10_000,
        deps,
      });
      expect(_getTtlTimerArgs("dispatch-1")?.ttlMs).toBe(10_000);

      // The first timer never fires.
      vi.advanceTimersByTime(6000);
      expect(deps.isPidAlive).not.toHaveBeenCalled();
    });

    it("pid===0 (pre-spawn sentinel) re-arms instead of clearing", async () => {
      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 0,
        ttlMs: 1000,
        deps,
      });

      vi.advanceTimersByTime(1001);
      await Promise.resolve();

      expect(deps.isPidAlive).not.toHaveBeenCalled();
      expect(deps.clearDispatch).not.toHaveBeenCalled();
      expect(_isTtlTimerArmed("dispatch-1")).toBe(true);
    });
  });

  describe("rearmTtlTimer (heartbeat hook)", () => {
    it("clears + re-arms with a fresh ttlMs window", () => {
      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 5000,
        deps,
      });

      // 4s in, heartbeat fires re-arm with a fresh 5s window.
      vi.advanceTimersByTime(4000);
      rearmTtlTimer("dispatch-1", 5000);
      expect(_getTtlTimerArgs("dispatch-1")?.ttlMs).toBe(5000);

      // Advance another 4s — would have fired without the re-arm.
      vi.advanceTimersByTime(4000);
      expect(deps.isPidAlive).not.toHaveBeenCalled();

      // Now advance past the new window.
      (deps.isPidAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      vi.advanceTimersByTime(2000);
      expect(deps.isPidAlive).toHaveBeenCalledWith(1234);
    });

    it("silent no-op when no timer is armed for the dispatch", () => {
      expect(() => rearmTtlTimer("nonexistent", 5000)).not.toThrow();
      expect(_isTtlTimerArmed("nonexistent")).toBe(false);
    });

    it("preserves the original repo + cardId + pid + deps from the prior arm", () => {
      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-7",
        pid: 999,
        ttlMs: 5000,
        deps,
      });
      rearmTtlTimer("dispatch-1", 1000);
      const args = _getTtlTimerArgs("dispatch-1");
      expect(args?.cardId).toBe("DX-7");
      expect(args?.pid).toBe(999);
      expect(args?.repo).toBe(repo);
    });
  });

  describe("clearTtlTimer", () => {
    it("clears an armed timer so expiry never fires", () => {
      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 5000,
        deps,
      });
      expect(_isTtlTimerArmed("dispatch-1")).toBe(true);

      clearTtlTimer("dispatch-1");
      expect(_isTtlTimerArmed("dispatch-1")).toBe(false);

      vi.advanceTimersByTime(10_000);
      expect(deps.isPidAlive).not.toHaveBeenCalled();
    });

    it("is idempotent — clearing a non-armed dispatch does not throw", () => {
      expect(() => clearTtlTimer("nonexistent")).not.toThrow();
    });
  });

  describe("expiry behavior", () => {
    it("live PID re-arms with the same ttlMs window", async () => {
      (deps.isPidAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 5000,
        deps,
      });

      vi.advanceTimersByTime(5001);
      await Promise.resolve();

      expect(deps.isPidAlive).toHaveBeenCalledWith(1234);
      expect(deps.clearDispatch).not.toHaveBeenCalled();
      expect(deps.reconcile).not.toHaveBeenCalled();
      // Re-armed for a fresh window.
      expect(_isTtlTimerArmed("dispatch-1")).toBe(true);
      expect(_getTtlTimerArgs("dispatch-1")?.ttlMs).toBe(5000);
    });

    it("dead PID clears YAML dispatch + audit reconciles", async () => {
      (deps.isPidAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 1000,
        deps,
      });

      vi.advanceTimersByTime(1001);
      await vi.runAllTimersAsync();

      expect(deps.isPidAlive).toHaveBeenCalledWith(1234);
      expect(deps.loadIssue).toHaveBeenCalledWith(
        repo.localPath,
        "DX-1",
        "DX",
      );
      expect(deps.clearDispatch).toHaveBeenCalled();
      expect(deps.reconcile).toHaveBeenCalledWith(repo, "DX-1", "audit");
      expect(_isTtlTimerArmed("dispatch-1")).toBe(false);
    });

    it("dead PID + missing YAML logs and exits without throwing", async () => {
      (deps.isPidAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (deps.loadIssue as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 1000,
        deps,
      });

      vi.advanceTimersByTime(1001);
      await vi.runAllTimersAsync();

      expect(deps.clearDispatch).not.toHaveBeenCalled();
      expect(deps.reconcile).not.toHaveBeenCalled();
    });

    it("clearDispatch failure logs but does not propagate", async () => {
      (deps.isPidAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (deps.clearDispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("write boom"),
      );

      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 1000,
        deps,
      });

      vi.advanceTimersByTime(1001);
      await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
      expect(deps.reconcile).not.toHaveBeenCalled();
    });

    it("reconcile failure logs but does not propagate", async () => {
      (deps.isPidAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (deps.reconcile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("reconcile boom"),
      );

      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 1000,
        deps,
      });

      vi.advanceTimersByTime(1001);
      await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
    });
  });

  describe("_clearAllTtlTimers (test seam)", () => {
    it("drains every armed timer", () => {
      armTtlTimer({
        dispatchId: "dispatch-1",
        repo,
        cardId: "DX-1",
        pid: 1234,
        ttlMs: 1000,
        deps,
      });
      armTtlTimer({
        dispatchId: "dispatch-2",
        repo,
        cardId: "DX-2",
        pid: 5678,
        ttlMs: 1000,
        deps,
      });

      _clearAllTtlTimers();

      expect(_isTtlTimerArmed("dispatch-1")).toBe(false);
      expect(_isTtlTimerArmed("dispatch-2")).toBe(false);
    });
  });
});

describe("scanAndArmTtlTimers (DX-220 boot-rehydrate)", () => {
  beforeEach(() => {
    _clearAllTtlTimers();
  });

  it("arms TTL timer for alive non-terminal dispatch with issueId", async () => {
    const dispatches: Dispatch[] = [
      {
        id: "dispatch-1",
        issueId: "DX-1",
        hostPid: 100,
      } as Dispatch,
    ];
    const result = await scanAndArmTtlTimers({
      repo: { name: "test-repo", localPath: "/tmp", issuePrefix: "DX" },
      ttlMs: 7_200_000,
      deps: {
        isPidAlive: vi.fn().mockReturnValue(true),
        reconcile: vi.fn(),
        clearDispatch: vi.fn(),
        loadIssue: vi.fn(),
      },
      findNonTerminalDispatches: vi.fn().mockResolvedValue(dispatches),
    });
    expect(result.armed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(_isTtlTimerArmed("dispatch-1")).toBe(true);
    _clearAllTtlTimers();
  });

  it("skips rows with null issueId, hostPid <= 0, or dead PID", async () => {
    const dispatches: Dispatch[] = [
      { id: "dispatch-a", issueId: null, hostPid: 100 } as Dispatch,
      { id: "dispatch-b", issueId: "DX-1", hostPid: null } as Dispatch,
      { id: "dispatch-c", issueId: "DX-2", hostPid: 0 } as Dispatch,
      { id: "dispatch-d", issueId: "DX-3", hostPid: 999 } as Dispatch,
    ];
    const result = await scanAndArmTtlTimers({
      repo: { name: "test-repo", localPath: "/tmp", issuePrefix: "DX" },
      ttlMs: 7_200_000,
      deps: {
        isPidAlive: vi.fn().mockReturnValue(false),
        reconcile: vi.fn(),
        clearDispatch: vi.fn(),
        loadIssue: vi.fn(),
      },
      findNonTerminalDispatches: vi.fn().mockResolvedValue(dispatches),
    });
    expect(result.armed).toBe(0);
    expect(result.skipped).toBe(4);
  });

  it("returns {armed:0, skipped:0} when findNonTerminalDispatches rejects (best-effort)", async () => {
    const result = await scanAndArmTtlTimers({
      repo: { name: "test-repo", localPath: "/tmp", issuePrefix: "DX" },
      ttlMs: 7_200_000,
      deps: {
        isPidAlive: vi.fn(),
        reconcile: vi.fn(),
        clearDispatch: vi.fn(),
        loadIssue: vi.fn(),
      },
      findNonTerminalDispatches: vi.fn().mockRejectedValue(new Error("db down")),
    });
    expect(result).toEqual({ armed: 0, skipped: 0 });
  });
});
