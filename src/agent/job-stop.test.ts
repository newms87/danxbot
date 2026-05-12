import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventEmitter } from "node:events";

// Hoisted mock for node:child_process — the helper's `spawn` call must
// resolve to the test double so we can pin its argv + drive its lifecycle.
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { stopAgentTree } from "./job-stop.js";
import type { AgentJob } from "./agent-types.js";
import type { AgentHandle } from "./agent-handle.js";

interface FakeSystemctlChild {
  on(event: "exit" | "error", cb: (...args: unknown[]) => void): void;
  once(event: "exit" | "error", cb: (...args: unknown[]) => void): void;
  emit(event: "exit" | "error", ...args: unknown[]): void;
}

function makeFakeChild(): FakeSystemctlChild {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
    },
    once(event, cb) {
      const wrapped = (...args: unknown[]): void => {
        const slot = listeners[event] ?? [];
        const idx = slot.indexOf(wrapped);
        if (idx >= 0) slot.splice(idx, 1);
        cb(...args);
      };
      (listeners[event] ??= []).push(wrapped);
    },
    emit(event, ...args) {
      for (const cb of (listeners[event] ?? []).slice()) cb(...args);
    },
  };
}

function makeAgentJob(
  overrides?: Partial<AgentJob>,
  handleOverrides?: Partial<AgentHandle>,
): AgentJob {
  const handle: AgentHandle = {
    pid: 12345,
    kill: vi.fn(),
    isAlive: vi.fn().mockReturnValue(true),
    onExit: vi.fn(),
    dispose: vi.fn(),
    ...handleOverrides,
  };
  return {
    id: "test-job-id",
    status: "running",
    summary: "",
    startedAt: new Date(),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    recoverCount: 0,
    handle,
    stop: async () => {
      throw new Error("not wired");
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockSpawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stopAgentTree — host path (scopeName set)", () => {
  it("invokes `systemctl --user stop <scope>.scope` and resolves on exit 0", async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as EventEmitter);

    const job = makeAgentJob();
    const promise = stopAgentTree({
      job,
      scopeName: "danxbot-dispatch-abc123",
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "stop", "danxbot-dispatch-abc123.scope"],
      { stdio: "ignore" },
    );

    // Drive the fake child to exit 0 — the helper should resolve.
    child.emit("exit", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("does NOT call job.handle.kill on the host path — no kill(pid, signal) survives", async () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as EventEmitter);

    const handleKill = vi.fn();
    const job = makeAgentJob({}, { kill: handleKill });

    const promise = stopAgentTree({
      job,
      scopeName: "danxbot-dispatch-abc123",
    });

    child.emit("exit", 0);
    await promise;

    expect(handleKill).not.toHaveBeenCalled();
  });

  it("treats exit code 5 (unit not found) as success — idempotent on missing scope", async () => {
    // systemctl returns 5 when the unit doesn't exist. With --collect on
    // the scope wrap, an already-stopped + auto-collected unit is the
    // success case — the dispatch's process tree is gone, which is what
    // we wanted. Failing here would force callers to mask the error.
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as EventEmitter);

    const job = makeAgentJob();
    const promise = stopAgentTree({
      job,
      scopeName: "danxbot-dispatch-already-gone",
    });

    child.emit("exit", 5);
    await expect(promise).resolves.toBeUndefined();
  });

  it("treats a non-zero / non-5 exit as a warning but resolves — no fallback to kill(pid)", async () => {
    // Anti-goal: "No fallback to `kill <pid>` if `systemctl --user stop`
    // fails." The boot preflight (systemd-preflight.ts) proves the binary
    // works before we accept dispatches, so a runtime failure is a
    // contract violation worth surfacing in the log — but cleanup must
    // still run so the dispatch row converges. The promise resolves
    // either way; the caller cannot tell scope-stop succeeded vs failed
    // because the next steps (cleanup, putStatus) are identical.
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as EventEmitter);

    const handleKill = vi.fn();
    const job = makeAgentJob({}, { kill: handleKill });

    const promise = stopAgentTree({
      job,
      scopeName: "danxbot-dispatch-broken",
    });

    child.emit("exit", 1);
    await expect(promise).resolves.toBeUndefined();
    expect(handleKill).not.toHaveBeenCalled();
  });

  it("resolves when the systemctl spawn itself errors — no fallback to handle.kill", async () => {
    // spawn() emits "error" when the binary cannot be found (ENOENT).
    // The preflight check should have caught this at boot; if we reach
    // this branch at stop time, the env regressed under us. Log + move
    // on — cleanup still runs.
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child as unknown as EventEmitter);

    const handleKill = vi.fn();
    const job = makeAgentJob({}, { kill: handleKill });

    const promise = stopAgentTree({
      job,
      scopeName: "danxbot-dispatch-x",
    });

    child.emit("error", new Error("ENOENT: systemctl not found"));
    await expect(promise).resolves.toBeUndefined();
    expect(handleKill).not.toHaveBeenCalled();
  });
});

describe("stopAgentTree — docker path (scopeName unset)", () => {
  it("delegates to terminateWithGrace: SIGTERM then SIGKILL after 5s when still alive", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const isAlive = vi.fn().mockReturnValue(true);
    const job = makeAgentJob({}, { kill, isAlive });

    const promise = stopAgentTree({ job });

    expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(kill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("skips the SIGKILL when the handle reports dead within the grace window", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const isAlive = vi.fn().mockReturnValue(false);
    const job = makeAgentJob({}, { kill, isAlive });

    const promise = stopAgentTree({ job });
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("skips the SIGKILL when handle.onExit fires DURING the grace window, even if isAlive() still reports true", async () => {
    // Some mock harnesses don't auto-flip exitCode on close — the
    // explicit onExit signal is the load-bearing check.
    vi.useFakeTimers();
    const kill = vi.fn();
    const isAlive = vi.fn().mockReturnValue(true);
    const onExitCallbacks: Array<() => void> = [];
    const onExit = vi.fn((cb: () => void) => {
      onExitCallbacks.push(cb);
    });
    const job = makeAgentJob({}, { kill, isAlive, onExit });

    const promise = stopAgentTree({ job });

    for (const cb of onExitCallbacks) cb();

    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does NOT spawn systemctl on the docker path", async () => {
    vi.useFakeTimers();
    const job = makeAgentJob({}, { isAlive: () => false });

    const promise = stopAgentTree({ job });
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("no-ops when the job has no handle (e.g. after cleanup)", async () => {
    const job = makeAgentJob({ handle: undefined });
    await expect(stopAgentTree({ job })).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
