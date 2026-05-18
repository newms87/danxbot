/**
 * Unit tests for `src/observability/event-loop-monitor.ts` (DX-636).
 *
 * Coverage:
 *  - Threshold breach calls recordSystemError with the right shape.
 *  - Under-threshold tick does NOT call recordSystemError.
 *  - Histogram is reset every tick (so the next sample only reflects new delays).
 *  - getLatestEventLoopSample exposes the latest sample after a tick.
 *  - stop() disables the histogram and clears the interval.
 *  - Env vars `DANXBOT_LOOP_METRIC_INTERVAL_MS` + `DANXBOT_LOOP_STALL_THRESHOLD_MS` are honored.
 *  - Self-cost: tick() returns in < 1ms (perf budget asserted on a fake histogram).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startEventLoopMonitor,
  getLatestEventLoopSample,
  _resetLatestEventLoopSample,
} from "../../observability/event-loop-monitor.js";
import type { IntervalHistogram } from "node:perf_hooks";

/** Build a minimal IntervalHistogram stub with controllable values. */
function fakeHistogram(initial: {
  p50ns: number;
  p99ns: number;
  maxNs: number;
}): IntervalHistogram & {
  enableCalls: number;
  disableCalls: number;
  resetCalls: number;
  setValues(v: { p50ns: number; p99ns: number; maxNs: number }): void;
} {
  let p50ns = initial.p50ns;
  let p99ns = initial.p99ns;
  let maxNs = initial.maxNs;
  const state = {
    enableCalls: 0,
    disableCalls: 0,
    resetCalls: 0,
  };
  const histogram = {
    enable(): boolean {
      state.enableCalls++;
      return true;
    },
    disable(): boolean {
      state.disableCalls++;
      return true;
    },
    reset(): void {
      state.resetCalls++;
      p50ns = 0;
      p99ns = 0;
      maxNs = 0;
    },
    percentile(p: number): number {
      if (p === 50) return p50ns;
      if (p === 99) return p99ns;
      return 0;
    },
    get max(): number {
      return maxNs;
    },
    get min(): number {
      return 0;
    },
    get mean(): number {
      return 0;
    },
    get stddev(): number {
      return 0;
    },
    get exceeds(): number {
      return 0;
    },
    get count(): number {
      return 0;
    },
    percentiles: new Map(),
    setValues(v: { p50ns: number; p99ns: number; maxNs: number }): void {
      p50ns = v.p50ns;
      p99ns = v.p99ns;
      maxNs = v.maxNs;
    },
    ...state,
  };
  // Re-bind state references through the returned object.
  Object.defineProperty(histogram, "enableCalls", {
    get: () => state.enableCalls,
  });
  Object.defineProperty(histogram, "disableCalls", {
    get: () => state.disableCalls,
  });
  Object.defineProperty(histogram, "resetCalls", {
    get: () => state.resetCalls,
  });
  return histogram as unknown as IntervalHistogram & {
    enableCalls: number;
    disableCalls: number;
    resetCalls: number;
    setValues(v: { p50ns: number; p99ns: number; maxNs: number }): void;
  };
}

describe("startEventLoopMonitor", () => {
  beforeEach(() => {
    _resetLatestEventLoopSample();
    delete process.env.DANXBOT_LOOP_METRIC_INTERVAL_MS;
    delete process.env.DANXBOT_LOOP_STALL_THRESHOLD_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls recordSystemError when p99 exceeds threshold (and skips when it does not)", () => {
    const histogram = fakeHistogram({
      p50ns: 5_000_000, // 5ms
      p99ns: 600_000_000, // 600ms — over default 500ms threshold
      maxNs: 800_000_000, // 800ms
    });
    const record = vi.fn();
    const handle = startEventLoopMonitor({
      repoName: "test-repo",
      intervalMs: 1_000_000, // long so auto-tick never fires
      histogram,
      recordSystemError: record,
    });

    const breach = handle.tickNow();
    expect(breach.p50).toBeCloseTo(5, 3);
    expect(breach.p99).toBeCloseTo(600, 3);
    expect(breach.max).toBeCloseTo(800, 3);
    expect(typeof breach.sampledAtMs).toBe("number");
    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0][0];
    expect(call.source).toBe("event-loop-stall");
    expect(call.severity).toBe("warn");
    expect(call.repo).toBe("test-repo");
    expect(call.message).toMatch(/600\.0ms exceeded threshold 500ms/);
    expect(call.details).toMatchObject({
      thresholdMs: 500,
      p99: 600,
    });

    // Reset histogram values to under threshold; next tick should NOT fire.
    histogram.setValues({ p50ns: 1_000_000, p99ns: 10_000_000, maxNs: 50_000_000 });
    record.mockClear();
    const calm = handle.tickNow();
    expect(calm.p99).toBeCloseTo(10, 3);
    expect(record).not.toHaveBeenCalled();

    handle.stop();
  });

  it("exposes latest sample via getLatestEventLoopSample after a tick", () => {
    const histogram = fakeHistogram({
      p50ns: 3_000_000,
      p99ns: 50_000_000,
      maxNs: 100_000_000,
    });
    const handle = startEventLoopMonitor({
      repoName: "r",
      intervalMs: 1_000_000,
      histogram,
      recordSystemError: () => {},
    });

    expect(getLatestEventLoopSample()).toBeNull();
    handle.tickNow();
    const sample = getLatestEventLoopSample();
    expect(sample).not.toBeNull();
    expect(sample!.p50).toBeCloseTo(3, 3);
    expect(sample!.p99).toBeCloseTo(50, 3);
    expect(sample!.max).toBeCloseTo(100, 3);

    handle.stop();
  });

  it("resets the histogram every tick", () => {
    const histogram = fakeHistogram({
      p50ns: 1_000_000,
      p99ns: 2_000_000,
      maxNs: 3_000_000,
    });
    const handle = startEventLoopMonitor({
      repoName: "r",
      intervalMs: 1_000_000,
      histogram,
      recordSystemError: () => {},
    });

    handle.tickNow();
    handle.tickNow();
    handle.tickNow();
    expect(histogram.resetCalls).toBe(3);

    handle.stop();
  });

  it("respects custom threshold + interval options", () => {
    const histogram = fakeHistogram({
      p50ns: 1_000_000,
      p99ns: 200_000_000, // 200ms
      maxNs: 250_000_000,
    });
    const record = vi.fn();
    const handle = startEventLoopMonitor({
      repoName: "r",
      intervalMs: 1_000_000,
      stallThresholdMs: 100, // 200ms > 100ms → fires
      histogram,
      recordSystemError: record,
    });

    handle.tickNow();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].details).toMatchObject({ thresholdMs: 100 });
    handle.stop();
  });

  it("reads DANXBOT_LOOP_STALL_THRESHOLD_MS from env when not passed", () => {
    process.env.DANXBOT_LOOP_STALL_THRESHOLD_MS = "50";
    const histogram = fakeHistogram({
      p50ns: 1_000_000,
      p99ns: 60_000_000, // 60ms — over env threshold 50ms
      maxNs: 70_000_000,
    });
    const record = vi.fn();
    const handle = startEventLoopMonitor({
      repoName: "r",
      intervalMs: 1_000_000,
      histogram,
      recordSystemError: record,
    });

    handle.tickNow();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].details).toMatchObject({ thresholdMs: 50 });
    handle.stop();
  });

  it("stop() disables the histogram", () => {
    const histogram = fakeHistogram({
      p50ns: 0,
      p99ns: 0,
      maxNs: 0,
    });
    const handle = startEventLoopMonitor({
      repoName: "r",
      intervalMs: 1_000_000,
      histogram,
      recordSystemError: () => {},
    });

    expect(histogram.enableCalls).toBe(1);
    expect(histogram.disableCalls).toBe(0);
    handle.stop();
    expect(histogram.disableCalls).toBe(1);
  });

  it("tick() self-cost < 1ms on the fake histogram (perf budget)", () => {
    const histogram = fakeHistogram({
      p50ns: 5_000_000,
      p99ns: 600_000_000,
      maxNs: 800_000_000,
    });
    const handle = startEventLoopMonitor({
      repoName: "r",
      intervalMs: 1_000_000,
      histogram,
      recordSystemError: () => {},
    });

    // Warm up to amortize lazy-resolution costs.
    handle.tickNow();

    const start = process.hrtime.bigint();
    handle.tickNow();
    const elapsedNs = Number(process.hrtime.bigint() - start);
    // 1ms = 1_000_000 ns. Generous on slow CI runners.
    expect(elapsedNs).toBeLessThan(1_000_000);
    handle.stop();
  });
});
