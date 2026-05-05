import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Dispatch } from "../dashboard/dispatches.js";

const mockFindNonTerminalDispatches = vi.fn();
const mockUpdateDispatch = vi.fn();
const mockIsPidAlive = vi.fn();

vi.mock("../dashboard/dispatches-db.js", () => ({
  findNonTerminalDispatches: (...args: unknown[]) =>
    mockFindNonTerminalDispatches(...args),
  updateDispatch: (...args: unknown[]) => mockUpdateDispatch(...args),
}));

vi.mock("../agent/host-pid.js", () => ({
  isPidAlive: (...args: unknown[]) => mockIsPidAlive(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { reconcileOrphanedDispatches } from "./reconcile.js";

function makeRow(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "job-id",
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {
      cardId: "card-1",
      cardName: "Card",
      cardUrl: "https://trello.com/c/card-1",
      listId: "list-1",
      listName: "ToDo",
    },
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    status: "running",
    startedAt: 1000,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "host",
    hostPid: 12345,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindNonTerminalDispatches.mockResolvedValue([]);
  mockUpdateDispatch.mockResolvedValue(undefined);
  mockIsPidAlive.mockReturnValue(false);
});

describe("reconcileOrphanedDispatches", () => {
  it("marks rows with a dead host_pid as failed", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "dead-1", hostPid: 999_999 }),
    ]);
    mockIsPidAlive.mockReturnValue(false);

    const result = await reconcileOrphanedDispatches("danxbot");

    expect(mockIsPidAlive).toHaveBeenCalledWith(999_999);
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    const [id, fields] = mockUpdateDispatch.mock.calls[0];
    expect(id).toBe("dead-1");
    expect(fields.status).toBe("failed");
    expect(fields.summary).toMatch(/orphaned/i);
    expect(typeof fields.completedAt).toBe("number");
    expect(result.orphaned).toEqual(["dead-1"]);
    expect(result.alive).toEqual([]);
    expect(result.scanned).toBe(1);
  });

  it("marks pre-migration legacy rows (host_pid null) as failed", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "legacy-1", hostPid: null }),
    ]);

    await reconcileOrphanedDispatches("danxbot");

    // Null PID shouldn't even ask the kernel — it's an explicit orphan signal.
    expect(mockIsPidAlive).not.toHaveBeenCalled();
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch.mock.calls[0][0]).toBe("legacy-1");
    expect(mockUpdateDispatch.mock.calls[0][1].status).toBe("failed");
  });

  it("treats non-positive host_pid (0, negative) as orphaned without probing the kernel", async () => {
    // Belt-and-suspenders — `process.kill(0, 0)` would target the current
    // process group and falsely report alive. The shared
    // `isDispatchOrphaned` helper short-circuits before calling
    // isPidAlive; this test locks that contract end-to-end through the
    // reconcile path.
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "zero-pid", hostPid: 0 }),
    ]);
    await reconcileOrphanedDispatches("danxbot");
    expect(mockIsPidAlive).not.toHaveBeenCalled();
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch.mock.calls[0][0]).toBe("zero-pid");
  });

  it("leaves rows with a live host_pid running", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "alive-1", hostPid: process.pid }),
    ]);
    mockIsPidAlive.mockReturnValue(true);

    const result = await reconcileOrphanedDispatches("danxbot");

    expect(mockIsPidAlive).toHaveBeenCalledWith(process.pid);
    expect(mockUpdateDispatch).not.toHaveBeenCalled();
    expect(result.alive).toEqual(["alive-1"]);
    expect(result.orphaned).toEqual([]);
  });

  it("returns scanned=0 with no work when there are no non-terminal rows", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([]);
    const result = await reconcileOrphanedDispatches("danxbot");
    expect(mockUpdateDispatch).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, orphaned: [], alive: [] });
  });

  it("partitions a mixed batch into alive vs orphaned without aborting on a single update failure", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "alive-1", hostPid: 7777 }),
      makeRow({ id: "dead-1", hostPid: 999_991 }),
      makeRow({ id: "dead-2", hostPid: null }),
    ]);
    mockIsPidAlive.mockImplementation((pid: number) => pid === 7777);
    mockUpdateDispatch.mockImplementationOnce(async () => {
      throw new Error("transient db");
    });

    const result = await reconcileOrphanedDispatches("danxbot");

    // dead-1 update threw — but dead-2 must still be attempted.
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(2);
    expect(mockUpdateDispatch.mock.calls.map((c) => c[0])).toEqual([
      "dead-1",
      "dead-2",
    ]);
    // Only successfully reconciled rows show up in `orphaned`.
    expect(result.orphaned).toEqual(["dead-2"]);
    expect(result.alive).toEqual(["alive-1"]);
    expect(result.scanned).toBe(3);
  });
});
