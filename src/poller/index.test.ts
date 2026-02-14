import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lockFile = resolve(projectRoot, ".poller-running");

function createFakeSpawnResult() {
  return { unref: vi.fn() };
}

describe("poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
  });

  afterEach(() => {
    // Clean up lock file if tests created one
    try {
      if (existsSync(lockFile)) unlinkSync(lockFile);
    } catch { /* ignore */ }
  });

  it("skips when teamRunning is true", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
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

  it("spawns wt.exe to open new terminal tab", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll();

    expect(mockSpawn).toHaveBeenCalledWith(
      "wt.exe",
      expect.arrayContaining(["new-tab", "--title", "Flytebot Team", "bash", expect.stringContaining("run-team.sh")]),
      expect.objectContaining({
        detached: true,
      }),
    );
  });

  it("creates lock file when spawning", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll();

    expect(existsSync(lockFile)).toBe(true);
  });

  it("handles fetchTodoCards failure gracefully", async () => {
    mockFetchTodoCards.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(poll()).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("strips CLAUDECODE env vars from spawned process", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    process.env.CLAUDECODE_TEST = "should-be-removed";

    await poll();

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv).not.toHaveProperty("CLAUDECODE_TEST");

    delete process.env.CLAUDECODE_TEST;
  });
});
