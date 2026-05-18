import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runWithYields,
  getLoopConcurrency,
  DEFAULT_LOOP_CONCURRENCY,
} from "./yield-loop.js";

describe("getLoopConcurrency", () => {
  const original = process.env.DANXBOT_LOOP_CONCURRENCY;
  afterEach(() => {
    if (original === undefined) delete process.env.DANXBOT_LOOP_CONCURRENCY;
    else process.env.DANXBOT_LOOP_CONCURRENCY = original;
  });

  it("returns DEFAULT_LOOP_CONCURRENCY when env var unset", () => {
    delete process.env.DANXBOT_LOOP_CONCURRENCY;
    expect(getLoopConcurrency()).toBe(DEFAULT_LOOP_CONCURRENCY);
  });

  it("parses positive integers from env", () => {
    process.env.DANXBOT_LOOP_CONCURRENCY = "8";
    expect(getLoopConcurrency()).toBe(8);
  });

  it("falls back to default on non-numeric values", () => {
    process.env.DANXBOT_LOOP_CONCURRENCY = "banana";
    expect(getLoopConcurrency()).toBe(DEFAULT_LOOP_CONCURRENCY);
  });

  it("falls back to default on zero or negative values", () => {
    process.env.DANXBOT_LOOP_CONCURRENCY = "0";
    expect(getLoopConcurrency()).toBe(DEFAULT_LOOP_CONCURRENCY);
    process.env.DANXBOT_LOOP_CONCURRENCY = "-3";
    expect(getLoopConcurrency()).toBe(DEFAULT_LOOP_CONCURRENCY);
  });
});

describe("runWithYields", () => {
  beforeEach(() => {
    delete process.env.DANXBOT_LOOP_CONCURRENCY;
  });

  it("returns empty results for empty input without invoking fn", async () => {
    const fn = vi.fn(async (x: number) => x);
    const results = await runWithYields([], fn);
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("processes every item and returns settled results in order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithYields(items, async (x) => x * 10);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([10, 20, 30, 40, 50]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("captures per-item errors via rejected status without aborting the run", async () => {
    const results = await runWithYields([1, 2, 3], async (x) => {
      if (x === 2) throw new Error("boom-2");
      return x;
    });
    expect(results[0]).toMatchObject({ status: "fulfilled", value: 1 });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toMatchObject({ status: "fulfilled", value: 3 });
  });

  it("respects the concurrency cap (in-flight count never exceeds it)", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runWithYields(
      items,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
      { concurrency: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it("invokes setImmediate at least floor(items / yieldEveryN) times", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    let setImmediateCalls = 0;
    const originalSetImmediate = global.setImmediate;
    const spy = vi
      .spyOn(global, "setImmediate")
      .mockImplementation(((cb: (...args: unknown[]) => void, ...args: unknown[]) => {
        setImmediateCalls++;
        return originalSetImmediate(cb as never, ...(args as never[]));
      }) as typeof setImmediate);
    try {
      await runWithYields(items, async (x) => x, {
        concurrency: 4,
        yieldEveryN: 4,
      });
    } finally {
      spy.mockRestore();
    }
    expect(setImmediateCalls).toBeGreaterThanOrEqual(Math.floor(100 / 4));
  });

  it("uses DANXBOT_LOOP_CONCURRENCY env when concurrency option is unset", async () => {
    process.env.DANXBOT_LOOP_CONCURRENCY = "2";
    let inFlight = 0;
    let peak = 0;
    await runWithYields(
      Array.from({ length: 12 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("preserves index-ordered results when concurrent workers complete out of order", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    // Earlier-indexed items take LONGER — without index-aware result
    // placement, the helper would produce results in completion order
    // (high index first) instead of input order. Pin the invariant.
    const results = await runWithYields(
      items,
      async (x) => {
        await new Promise((r) => setTimeout(r, items.length - x));
        return x * 100;
      },
      { concurrency: 4 },
    );
    expect(
      results.map((r) => (r.status === "fulfilled" ? r.value : null)),
    ).toEqual(items.map((x) => x * 100));
  });

  it("decouples yieldEveryN from concurrency (yields at user-specified cadence)", async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    let setImmediateCalls = 0;
    const originalSetImmediate = global.setImmediate;
    const spy = vi
      .spyOn(global, "setImmediate")
      .mockImplementation(((cb: (...args: unknown[]) => void, ...args: unknown[]) => {
        setImmediateCalls++;
        return originalSetImmediate(cb as never, ...(args as never[]));
      }) as typeof setImmediate);
    try {
      // concurrency=4 but yieldEveryN=10 — exactly 40/10 = 4 yields.
      await runWithYields(items, async (x) => x, {
        concurrency: 4,
        yieldEveryN: 10,
      });
    } finally {
      spy.mockRestore();
    }
    expect(setImmediateCalls).toBeGreaterThanOrEqual(4);
    expect(setImmediateCalls).toBeLessThan(10);
  });

  it("runs strictly sequentially when concurrency=1 (matches pre-DX-634 for-await shape)", async () => {
    const completionOrder: number[] = [];
    let inFlight = 0;
    let peak = 0;
    await runWithYields(
      Array.from({ length: 10 }, (_, i) => i),
      async (x) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        completionOrder.push(x);
        inFlight--;
      },
      { concurrency: 1 },
    );
    expect(peak).toBe(1);
    expect(completionOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("lets a previously-scheduled setImmediate callback fire mid-loop", async () => {
    // Without the yield primitive, an async loop that only `await`s
    // resolved promises drains microtasks and never enters the macrotask
    // queue — every setImmediate callback scheduled before the loop
    // would wait until after the loop completes. With the yield, the
    // macrotask queue gets a turn between batches, so a previously-armed
    // setImmediate callback fires while the loop is still in flight.
    let immediateFiredDuring = false;
    let loopComplete = false;
    setImmediate(() => {
      // If this fires only AFTER the loop completes, the yields aren't
      // doing their job — the callback runs deferred to the next tick
      // after `runWithYields` returns.
      if (!loopComplete) immediateFiredDuring = true;
    });
    await runWithYields(
      Array.from({ length: 16 }, (_, i) => i),
      async (x) => {
        // Microtask-only await — no setImmediate inside the work fn.
        await Promise.resolve();
        return x;
      },
      { concurrency: 4, yieldEveryN: 4 },
    );
    loopComplete = true;
    expect(immediateFiredDuring).toBe(true);
  });
});
