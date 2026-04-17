import { describe, it, expect, beforeEach, vi } from "vitest";

const mockDeleteOldDispatches = vi.fn();
vi.mock("./dispatches-db.js", () => ({
  deleteOldDispatches: (...args: unknown[]) => mockDeleteOldDispatches(...args),
}));

const mockUnlink = vi.fn();
vi.mock("node:fs/promises", () => ({
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  runRetentionOnce,
  startRetentionCron,
  stopRetentionCron,
  RETENTION_MAX_AGE_MS,
} from "./retention.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteOldDispatches.mockResolvedValue([]);
  mockUnlink.mockResolvedValue(undefined);
});

describe("runRetentionOnce", () => {
  it("delegates to deleteOldDispatches with the default 30d max age", async () => {
    await runRetentionOnce();
    expect(mockDeleteOldDispatches).toHaveBeenCalledWith(RETENTION_MAX_AGE_MS);
  });

  it("honors a custom maxAgeMs argument", async () => {
    await runRetentionOnce(60 * 1000);
    expect(mockDeleteOldDispatches).toHaveBeenCalledWith(60 * 1000);
  });

  it("unlinks JSONL files for each deleted row", async () => {
    mockDeleteOldDispatches.mockResolvedValueOnce([
      { id: "a", jsonlPath: "/tmp/a.jsonl" },
      { id: "b", jsonlPath: "/tmp/b.jsonl" },
    ]);
    await runRetentionOnce();
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/a.jsonl");
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/b.jsonl");
  });

  it("skips unlink when jsonlPath is null", async () => {
    mockDeleteOldDispatches.mockResolvedValueOnce([
      { id: "a", jsonlPath: null },
    ]);
    await runRetentionOnce();
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("ignores ENOENT from unlink", async () => {
    mockDeleteOldDispatches.mockResolvedValueOnce([
      { id: "a", jsonlPath: "/tmp/a.jsonl" },
    ]);
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    mockUnlink.mockRejectedValueOnce(enoent);
    const count = await runRetentionOnce();
    expect(count).toBe(1);
  });

  it("returns 0 on DB failure without throwing", async () => {
    mockDeleteOldDispatches.mockRejectedValueOnce(new Error("db down"));
    const count = await runRetentionOnce();
    expect(count).toBe(0);
  });

  it("returns the number of deleted rows", async () => {
    mockDeleteOldDispatches.mockResolvedValueOnce([
      { id: "a", jsonlPath: null },
      { id: "b", jsonlPath: null },
      { id: "c", jsonlPath: null },
    ]);
    const count = await runRetentionOnce();
    expect(count).toBe(3);
  });
});

describe("startRetentionCron / stopRetentionCron", () => {
  it("runs on startup and on the configured interval, stops cleanly", async () => {
    vi.useFakeTimers();
    const intervalMs = 10_000;
    const interval = startRetentionCron(intervalMs);

    // Flush the fire-and-forget initial run
    await Promise.resolve();
    await Promise.resolve();

    const callsBeforeInterval = mockDeleteOldDispatches.mock.calls.length;
    expect(callsBeforeInterval).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(mockDeleteOldDispatches.mock.calls.length).toBe(
      callsBeforeInterval + 1,
    );

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(mockDeleteOldDispatches.mock.calls.length).toBe(
      callsBeforeInterval + 2,
    );

    stopRetentionCron(interval);
    await vi.advanceTimersByTimeAsync(intervalMs * 2);
    // No further calls after stop
    expect(mockDeleteOldDispatches.mock.calls.length).toBe(
      callsBeforeInterval + 2,
    );
    vi.useRealTimers();
  });
});
