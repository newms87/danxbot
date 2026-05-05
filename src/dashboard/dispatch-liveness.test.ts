import { describe, it, expect, vi } from "vitest";
import { isDispatchOrphaned } from "./dispatch-liveness.js";

describe("isDispatchOrphaned", () => {
  it("returns true when host_pid is null (legacy / pre-migration row)", () => {
    const isAlive = vi.fn().mockReturnValue(true);
    expect(isDispatchOrphaned({ hostPid: null }, isAlive)).toBe(true);
    // Null PID is an explicit orphan signal — never asks the kernel.
    expect(isAlive).not.toHaveBeenCalled();
  });

  it("returns true for non-positive PIDs without consulting the kernel", () => {
    // PID 0 in `process.kill(0, 0)` targets the current process group —
    // would falsely return true for every reader. Routed here as orphan.
    const isAlive = vi.fn().mockReturnValue(true);
    expect(isDispatchOrphaned({ hostPid: 0 }, isAlive)).toBe(true);
    expect(isDispatchOrphaned({ hostPid: -1 }, isAlive)).toBe(true);
    expect(isAlive).not.toHaveBeenCalled();
  });

  it("returns true when isPidAlive reports the PID is gone", () => {
    const isAlive = vi.fn().mockReturnValue(false);
    expect(isDispatchOrphaned({ hostPid: 999_991 }, isAlive)).toBe(true);
    expect(isAlive).toHaveBeenCalledWith(999_991);
  });

  it("returns false when isPidAlive reports the PID is alive", () => {
    const isAlive = vi.fn().mockReturnValue(true);
    expect(isDispatchOrphaned({ hostPid: process.pid }, isAlive)).toBe(false);
    expect(isAlive).toHaveBeenCalledWith(process.pid);
  });
});
