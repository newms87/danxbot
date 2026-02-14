import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
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

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { poll, shutdown, start, _resetForTesting } from "./index.js";

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

  it("refuses to spawn if lock file already exists (pre-spawn safety check)", async () => {
    // Create lock file before poll — simulates another team already running
    writeFileSync(lockFile, "99999");
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll();

    // Should not spawn because lock file already exists
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("start", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    mockFetchTodoCards.mockResolvedValue([]);
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    vi.useRealTimers();
    _resetForTesting();
    try {
      if (existsSync(lockFile)) unlinkSync(lockFile);
    } catch { /* ignore */ }
  });

  it("enters watching mode if lock file exists on startup", async () => {
    // Create lock file before start — simulates a previous team still running
    writeFileSync(lockFile, "99999");

    start();
    // Let the initial poll() resolve
    await vi.advanceTimersByTimeAsync(0);

    // Even with cards available, should not spawn because lock file was detected
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    await vi.advanceTimersByTimeAsync(60000);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("resumes polling after lock file is removed during watching mode", async () => {
    writeFileSync(lockFile, "99999");

    start();
    await vi.advanceTimersByTimeAsync(0);

    // Remove the lock file — simulating team completion
    unlinkSync(lockFile);

    // Advance past lock check interval (5s)
    await vi.advanceTimersByTimeAsync(5000);

    // Now poll should work — provide cards
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    await vi.advanceTimersByTimeAsync(60000);

    expect(mockSpawn).toHaveBeenCalled();
  });
});

describe("shutdown", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    try {
      if (existsSync(lockFile)) unlinkSync(lockFile);
    } catch { /* ignore */ }
  });

  it("removes lock file when no team is running", () => {
    writeFileSync(lockFile, "99999");

    shutdown();

    expect(existsSync(lockFile)).toBe(false);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("preserves lock file when a team is actively running", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    // Spawn a team so teamRunning becomes true
    await poll();
    expect(existsSync(lockFile)).toBe(true);

    // Now shut down — lock file should be preserved
    shutdown();

    expect(existsSync(lockFile)).toBe(true);
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});
