import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createReattachHandle } from "./reattach-handle.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createReattachHandle", () => {
  it("exposes the supplied PID via the .pid getter", () => {
    const handle = createReattachHandle(12345, { pollIntervalMs: 1_000 });
    try {
      expect(handle.pid).toBe(12345);
    } finally {
      handle.dispose();
    }
  });

  it("isAlive() reports false for a long-dead PID", () => {
    // PID 999_999_999 is far above any realistic OS-assigned value, so
    // `process.kill(pid, 0)` raises ESRCH and the handle reports dead.
    const handle = createReattachHandle(999_999_999, { pollIntervalMs: 1_000 });
    try {
      expect(handle.isAlive()).toBe(false);
    } finally {
      handle.dispose();
    }
  });

  it("isAlive() reports true for the current process and kill(0) does not crash it", () => {
    const handle = createReattachHandle(process.pid, { pollIntervalMs: 1_000 });
    try {
      expect(handle.isAlive()).toBe(true);
      // `process.kill(pid, 0)` performs a permission check only — no signal
      // is delivered. Verify by asserting process is still alive after.
      handle.kill(0 as unknown as NodeJS.Signals);
      expect(handle.isAlive()).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it("kill() forwards a real signal to the wrapped PID (verified via a sleep child that traps SIGTERM)", async () => {
    vi.useRealTimers();
    // Spawn a real child we can SIGTERM so we observe the handle's
    // forwarding without colliding with the test runner's own process.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    expect(typeof child.pid).toBe("number");
    const pid = child.pid as number;

    const exited = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });

    const handle = createReattachHandle(pid, { pollIntervalMs: 50 });
    try {
      expect(handle.isAlive()).toBe(true);
      handle.kill("SIGTERM");
      await exited;
      // Give the handle's poll a tick to observe death.
      await new Promise((r) => setTimeout(r, 100));
      expect(handle.isAlive()).toBe(false);
    } finally {
      handle.dispose();
    }
  });

  it("onExit fires exactly once when the wrapped PID dies", async () => {
    vi.useRealTimers();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid as number;

    const handle = createReattachHandle(pid, { pollIntervalMs: 50 });
    try {
      const callbackFires: number[] = [];
      handle.onExit(() => callbackFires.push(Date.now()));

      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
      // Allow the watcher's poll to fire.
      await new Promise((r) => setTimeout(r, 200));

      expect(callbackFires.length).toBe(1);
    } finally {
      handle.dispose();
    }
  });

  it("dispose() stops the underlying watcher (idempotent — safe to call twice)", () => {
    const handle = createReattachHandle(process.pid, { pollIntervalMs: 100 });
    handle.dispose();
    // Second call must not throw. The watcher's stop() is idempotent;
    // the shim layers nothing on top.
    expect(() => handle.dispose()).not.toThrow();
  });
});
