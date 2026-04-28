import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const mockIsPidAlive = vi.fn();
const mockKillHostPid = vi.fn();
vi.mock("./host-pid.js", () => ({
  isPidAlive: (...args: unknown[]) => mockIsPidAlive(...args),
  killHostPid: (...args: unknown[]) => mockKillHostPid(...args),
}));

import { createDockerHandle, createHostHandle } from "./agent-handle.js";
import type { ChildProcess } from "node:child_process";
import type { HostExitWatcher } from "./host-pid.js";

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  setExitCode: (code: number | null) => void;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  // exitCode is read by createDockerHandle.isAlive — mutable so tests can
  // simulate exit without going through Node's actual ChildProcess.
  let _exitCode: number | null = null;
  Object.defineProperty(ee, "exitCode", {
    get: () => _exitCode,
    configurable: true,
  });
  ee.setExitCode = (c) => {
    _exitCode = c;
  };
  ee.kill = vi.fn();
  return ee;
}

function asChildProcess(c: FakeChild): ChildProcess {
  return c as unknown as ChildProcess;
}

function makeFakeWatcher(): HostExitWatcher & {
  fire: () => void;
  onExitMock: ReturnType<typeof vi.fn>;
  stopMock: ReturnType<typeof vi.fn>;
} {
  const cbs: Array<() => void> = [];
  const onExitMock = vi.fn((cb: () => void) => {
    cbs.push(cb);
  });
  const stopMock = vi.fn();
  return {
    onExit: onExitMock,
    stop: stopMock,
    onExitMock,
    stopMock,
    fire: () => {
      for (const cb of cbs) cb();
      cbs.length = 0;
    },
  };
}

describe("createDockerHandle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kill delegates to child.kill with the same signal", () => {
    const child = makeFakeChild();
    const handle = createDockerHandle(asChildProcess(child));

    handle.kill("SIGTERM");
    handle.kill("SIGKILL");

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("isAlive returns true while exitCode is null and false after exit", () => {
    const child = makeFakeChild();
    const handle = createDockerHandle(asChildProcess(child));

    expect(handle.isAlive()).toBe(true);
    child.setExitCode(0);
    expect(handle.isAlive()).toBe(false);
  });

  it("onExit fires its callback exactly once when the child closes", () => {
    const child = makeFakeChild();
    const handle = createDockerHandle(asChildProcess(child));
    const cb = vi.fn();

    handle.onExit(cb);
    expect(cb).not.toHaveBeenCalled();

    child.emit("close", 0);
    expect(cb).toHaveBeenCalledTimes(1);

    // Subsequent close emissions never invoke the once-listener again.
    child.emit("close", 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("dispose is a no-op for docker handles (Node manages ChildProcess lifecycle)", () => {
    const child = makeFakeChild();
    const handle = createDockerHandle(asChildProcess(child));

    expect(() => handle.dispose()).not.toThrow();
    // Idempotent.
    expect(() => handle.dispose()).not.toThrow();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("createHostHandle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPidAlive.mockReturnValue(true);
  });

  it("kill delegates to killHostPid with the tracked PID", () => {
    const watcher = makeFakeWatcher();
    const handle = createHostHandle(54321, watcher);

    handle.kill("SIGTERM");
    handle.kill("SIGKILL");

    expect(mockKillHostPid).toHaveBeenNthCalledWith(1, 54321, "SIGTERM");
    expect(mockKillHostPid).toHaveBeenNthCalledWith(2, 54321, "SIGKILL");
  });

  it("isAlive delegates to isPidAlive with the tracked PID", () => {
    const watcher = makeFakeWatcher();
    const handle = createHostHandle(98765, watcher);

    mockIsPidAlive.mockReturnValueOnce(true);
    expect(handle.isAlive()).toBe(true);
    mockIsPidAlive.mockReturnValueOnce(false);
    expect(handle.isAlive()).toBe(false);

    expect(mockIsPidAlive).toHaveBeenNthCalledWith(1, 98765);
    expect(mockIsPidAlive).toHaveBeenNthCalledWith(2, 98765);
  });

  it("onExit registers the callback with the underlying HostExitWatcher", () => {
    const watcher = makeFakeWatcher();
    const handle = createHostHandle(11111, watcher);
    const cb = vi.fn();

    handle.onExit(cb);

    expect(watcher.onExitMock).toHaveBeenCalledTimes(1);
    expect(watcher.onExitMock).toHaveBeenCalledWith(cb);

    // Firing the underlying watcher invokes the callback.
    watcher.fire();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("dispose stops the underlying HostExitWatcher polling", () => {
    const watcher = makeFakeWatcher();
    const handle = createHostHandle(22222, watcher);

    handle.dispose();

    expect(watcher.stopMock).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent — multiple calls do not throw and forward each call to watcher.stop", () => {
    // The HostExitWatcher contract (host-pid.ts) declares stop() idempotent
    // and the AgentHandle contract claims dispose() is idempotent + safe
    // after exit. Forwarding repeats is the simplest correct shape — no
    // local "fired" flag needed in the handle.
    const watcher = makeFakeWatcher();
    const handle = createHostHandle(33333, watcher);

    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();

    expect(watcher.stopMock).toHaveBeenCalledTimes(2);
  });

  it("kill after exit still forwards to killHostPid (per-runtime ESRCH handling lives in killHostPid)", () => {
    // The handle is a thin delegate; the ESRCH-on-already-dead race is
    // swallowed inside killHostPid (host-pid.ts), not the handle. Pin that
    // contract so a future "skip kill if !isAlive" optimization in the
    // handle can't silently regress it.
    const watcher = makeFakeWatcher();
    const handle = createHostHandle(44444, watcher);
    mockIsPidAlive.mockReturnValue(false);

    handle.kill("SIGKILL");

    expect(mockKillHostPid).toHaveBeenCalledWith(44444, "SIGKILL");
  });
});
