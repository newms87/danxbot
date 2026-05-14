import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCompleteRestart = vi.fn();
vi.mock("./worker-restarts-db.js", () => ({
  completeRestart: (...args: unknown[]) => mockCompleteRestart(...args),
}));

const mockPollHealth = vi.fn();
vi.mock("./restart.js", () => ({
  pollHealth: (...args: unknown[]) => mockPollHealth(...args),
}));

vi.mock("../db/connection.js", () => ({
  closePool: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { parseArgs, main } from "./restart-finalize.js";

describe("parseArgs", () => {
  it("parses every required flag", () => {
    const out = parseArgs([
      "--restart-id",
      "42",
      "--repo",
      "danxbot",
      "--port",
      "5562",
      "--timeout-ms",
      "60000",
      "--reserved-respawn-ms",
      "5000",
      "--started-at",
      "1700000000000",
    ]);
    expect(out).toEqual({
      restartId: 42,
      repo: "danxbot",
      port: 5562,
      timeoutMs: 60_000,
      reservedRespawnMs: 5_000,
      startedAt: 1_700_000_000_000,
    });
  });

  it("throws on missing flag", () => {
    expect(() => parseArgs(["--repo", "x"])).toThrow(/Missing/);
  });
});

describe("main", () => {
  beforeEach(() => {
    mockCompleteRestart.mockReset().mockResolvedValue(undefined);
    mockPollHealth.mockReset();
  });

  const baseArgv = [
    "--restart-id",
    "42",
    "--repo",
    "danxbot",
    "--port",
    "5562",
    "--timeout-ms",
    "60000",
    "--reserved-respawn-ms",
    "5000",
    "--started-at",
    "1700000000000",
  ];

  it("writes outcome=success when /health returns 200", async () => {
    mockPollHealth.mockResolvedValueOnce(true);
    await main(baseArgv, {
      resolveNewPid: () => 9999,
      fetch: vi.fn(),
      now: () => 1_700_000_005_000,
      sleep: vi.fn(),
    });
    expect(mockCompleteRestart).toHaveBeenCalledTimes(1);
    expect(mockCompleteRestart.mock.calls[0][0]).toMatchObject({
      id: 42,
      outcome: "success",
      newPid: 9999,
      completedAt: 1_700_000_005_000,
    });
  });

  it("forwards lsof-resolved new PID into completeRestart", async () => {
    mockPollHealth.mockResolvedValueOnce(true);
    await main(baseArgv, {
      resolveNewPid: () => 12345,
      fetch: vi.fn(),
      now: () => 0,
      sleep: vi.fn(),
    });
    expect(mockCompleteRestart.mock.calls[0][0].newPid).toBe(12345);
  });

  it("writes outcome=health_timeout when poll returns false", async () => {
    mockPollHealth.mockResolvedValueOnce(false);
    await main(baseArgv);
    expect(mockCompleteRestart.mock.calls[0][0]).toMatchObject({
      id: 42,
      outcome: "health_timeout",
      newPid: null,
    });
  });

  it("uses (timeoutMs - reservedRespawnMs) as the deadline budget", async () => {
    mockPollHealth.mockResolvedValueOnce(true);
    await main(baseArgv);
    // pollHealth signature: (port, deadlineMs, deps)
    const [port, deadlineMs] = mockPollHealth.mock.calls[0];
    expect(port).toBe(5562);
    expect(typeof deadlineMs).toBe("number");
    // deadline must be ~55s in the future at call time
    const expectedBudget = 60_000 - 5_000;
    // Tolerance window accommodates event-loop latency under the full
    // vitest sweep — parallel workers + ts-node JIT can stall the main
    // loop ~400–500ms between `Date.now()` inside `main()` and the
    // assertion's `Date.now()`. The 100ms ceiling caused a load-induced
    // flake (DX-502 verification surfaced it). Widened to 2_000ms; the
    // window still catches order-of-magnitude bugs (e.g. `60_000` vs
    // `55_000` budget computation) without flaking on a slow CI tick.
    expect(deadlineMs - Date.now()).toBeGreaterThan(expectedBudget - 2_000);
    expect(deadlineMs - Date.now()).toBeLessThanOrEqual(expectedBudget + 2_000);
  });
});
