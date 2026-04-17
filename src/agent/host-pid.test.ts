import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPidFileWithTimeout,
  isPidAlive,
  createHostExitWatcher,
  killHostPid,
} from "./host-pid.js";

describe("readPidFileWithTimeout", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-pid-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the PID when the file already exists", async () => {
    const pidFile = join(dir, "claude.pid");
    writeFileSync(pidFile, "12345\n", "utf-8");

    const pid = await readPidFileWithTimeout(pidFile, 2000, 50);
    expect(pid).toBe(12345);
  });

  it("polls until the file appears", async () => {
    const pidFile = join(dir, "claude.pid");
    // Write the file after a short delay
    setTimeout(() => writeFileSync(pidFile, "99999", "utf-8"), 30);

    const pid = await readPidFileWithTimeout(pidFile, 2000, 10);
    expect(pid).toBe(99999);
  });

  it("throws when the timeout expires before the file appears", async () => {
    const pidFile = join(dir, "never-written.pid");
    await expect(readPidFileWithTimeout(pidFile, 120, 30)).rejects.toThrow(
      /Timed out after 120ms/,
    );
  });

  it("throws when the file contains a non-numeric value", async () => {
    const pidFile = join(dir, "claude.pid");
    writeFileSync(pidFile, "not-a-pid\n", "utf-8");

    await expect(readPidFileWithTimeout(pidFile, 500, 20)).rejects.toThrow(
      /Invalid PID file contents/,
    );
  });

  it("throws when the file contains a non-positive number", async () => {
    const pidFile = join(dir, "claude.pid");
    writeFileSync(pidFile, "0\n", "utf-8");

    await expect(readPidFileWithTimeout(pidFile, 500, 20)).rejects.toThrow(
      /Invalid PID file contents/,
    );
  });

  it("ignores an empty file and keeps polling until it is populated", async () => {
    const pidFile = join(dir, "claude.pid");
    writeFileSync(pidFile, "", "utf-8");
    setTimeout(() => writeFileSync(pidFile, "4242", "utf-8"), 30);

    const pid = await readPidFileWithTimeout(pidFile, 2000, 10);
    expect(pid).toBe(4242);
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for an obviously dead PID", () => {
    // PID 1 is init/systemd on most systems — using a very large number that
    // is extremely unlikely to exist for this test.
    expect(isPidAlive(2_147_483_646)).toBe(false);
  });

  it("treats EPERM as alive — the kernel confirmed the process exists", () => {
    // On Linux, sending signal 0 to a PID you lack permission to signal yields
    // EPERM, which means the PID *does* exist. `isPidAlive` must report true.
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    try {
      expect(isPidAlive(54321)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createHostExitWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onExit when the PID becomes unreachable", async () => {
    const watcher = createHostExitWatcher(2_147_483_646, 10);
    const cb = vi.fn();
    watcher.onExit(cb);

    await vi.advanceTimersByTimeAsync(30);

    expect(cb).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("fires each registered callback exactly once", async () => {
    const watcher = createHostExitWatcher(2_147_483_646, 5);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    watcher.onExit(cb1);
    watcher.onExit(cb2);

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("fires onExit immediately when the callback is registered after the PID is already dead", async () => {
    const watcher = createHostExitWatcher(2_147_483_646, 5);
    await vi.advanceTimersByTimeAsync(15);

    const cb = vi.fn();
    watcher.onExit(cb);

    expect(cb).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("stop() cancels further polling and drops callbacks", async () => {
    const watcher = createHostExitWatcher(process.pid, 10);
    const cb = vi.fn();
    watcher.onExit(cb);

    watcher.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(cb).not.toHaveBeenCalled();
  });

  it("does not fire onExit while the PID is still alive", async () => {
    const watcher = createHostExitWatcher(process.pid, 10);
    const cb = vi.fn();
    watcher.onExit(cb);

    await vi.advanceTimersByTimeAsync(50);

    expect(cb).not.toHaveBeenCalled();
    watcher.stop();
  });
});

describe("killHostPid", () => {
  it("swallows ESRCH when the process is already gone", () => {
    // PID that almost certainly does not exist — this should not throw
    expect(() => killHostPid(2_147_483_646, "SIGTERM")).not.toThrow();
  });

  it("propagates non-ESRCH errors", () => {
    const originalKill = process.kill;
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("boom") as NodeJS.ErrnoException;
      err.code = "EINVAL";
      throw err;
    });
    try {
      expect(() => killHostPid(1234, "SIGTERM")).toThrow("boom");
    } finally {
      spy.mockRestore();
      // Sanity: ensure we restored process.kill
      expect(process.kill).toBe(originalKill);
    }
  });
});
