import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// Mock dependencies before importing module under test
vi.mock("./config.js", () => ({
  config: { pollerIntervalMs: 60000 },
}));

const mockFetchTodoCards = vi.fn();
vi.mock("./trello-client.js", () => ({
  fetchTodoCards: (...args: unknown[]) => mockFetchTodoCards(...args),
}));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { poll, _resetForTesting } from "./index.js";

// Silence log output during tests
vi.spyOn(console, "log").mockImplementation(() => {});

function createFakeChildProcess(): {
  process: ChildProcess;
  listeners: Record<string, (...args: unknown[]) => void>;
} {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const fakeProcess = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
      return fakeProcess;
    }),
    kill: vi.fn(),
  } as unknown as ChildProcess;
  return { process: fakeProcess, listeners };
}

describe("poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it("skips when teamRunning is true", async () => {
    // First call: spawn a process to set teamRunning = true
    const { process: fakeProc } = createFakeChildProcess();
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    mockSpawn.mockReturnValue(fakeProc);
    await poll();

    // Second call: should skip because teamRunning is true
    mockFetchTodoCards.mockClear();
    mockSpawn.mockClear();
    await poll();

    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does nothing when no cards in ToDo", async () => {
    mockFetchTodoCards.mockResolvedValue([]);

    await poll();

    expect(mockFetchTodoCards).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns claude process when cards exist", async () => {
    const { process: fakeProc } = createFakeChildProcess();
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    mockSpawn.mockReturnValue(fakeProc);

    await poll();

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "/start-team", "--dangerously-skip-permissions"],
      expect.objectContaining({
        stdio: "inherit",
      }),
    );
  });

  it("handles fetchTodoCards failure gracefully", async () => {
    mockFetchTodoCards.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(poll()).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("resets teamRunning on child process exit", async () => {
    const { process: fakeProc, listeners } = createFakeChildProcess();
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    mockSpawn.mockReturnValue(fakeProc);

    await poll();

    // Simulate child exit
    listeners["exit"](0);

    // Now poll() should work again (teamRunning is false)
    mockFetchTodoCards.mockResolvedValue([]);
    await poll();

    expect(mockFetchTodoCards).toHaveBeenCalledTimes(2);
  });

  it("resets teamRunning on child process error", async () => {
    const { process: fakeProc, listeners } = createFakeChildProcess();
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    mockSpawn.mockReturnValue(fakeProc);

    await poll();

    // Simulate child error
    listeners["error"](new Error("spawn failed"));

    // Now poll() should work again (teamRunning is false)
    mockFetchTodoCards.mockResolvedValue([]);
    await poll();

    expect(mockFetchTodoCards).toHaveBeenCalledTimes(2);
  });

  it("strips CLAUDECODE env vars from spawned process", async () => {
    const { process: fakeProc } = createFakeChildProcess();
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    mockSpawn.mockReturnValue(fakeProc);

    // Set a CLAUDECODE env var
    process.env.CLAUDECODE_TEST = "should-be-removed";

    await poll();

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv).not.toHaveProperty("CLAUDECODE_TEST");

    // Cleanup
    delete process.env.CLAUDECODE_TEST;
  });
});
