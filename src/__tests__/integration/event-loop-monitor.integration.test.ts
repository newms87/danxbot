/**
 * Integration test for the event-loop monitor (DX-636).
 *
 * Uses the REAL `perf_hooks.monitorEventLoopDelay` histogram, blocks the
 * loop for ~600ms via a sync `while` spin, and asserts the threshold-
 * breach path fires `recordSystemError` with `source: "event-loop-stall"`.
 *
 * This is the body of AC#2 ("Integration test: block loop 600ms, assert
 * system-error fires").
 */

import { describe, it, expect } from "vitest";
import { startEventLoopMonitor } from "../../observability/event-loop-monitor.js";
import type { RecordSystemErrorOptions } from "../../dashboard/system-errors.js";

describe("event-loop monitor — real histogram", () => {
  it("fires event-loop-stall when the loop is blocked > threshold", async () => {
    const calls: RecordSystemErrorOptions[] = [];
    const handle = startEventLoopMonitor({
      repoName: "integration",
      intervalMs: 1_000_000, // no auto-tick; we drive via tickNow()
      stallThresholdMs: 200,
      resolutionMs: 20,
      recordSystemError: (opts) => {
        calls.push(opts as RecordSystemErrorOptions);
      },
    });

    // Let the histogram observe the calm loop briefly.
    await new Promise((r) => setTimeout(r, 60));

    // Sync-block the loop for ~600ms. perf_hooks samples loop-delay at
    // 20ms resolution, so by the end of the spin the histogram has at
    // least one bucket well above 200ms.
    const stallEnd = Date.now() + 600;
    while (Date.now() < stallEnd) {
      // busy spin
    }

    // One micro-await to let the timer/histogram bookkeeping flush.
    await new Promise((r) => setTimeout(r, 30));

    const sample = handle.tickNow();
    expect(sample.p99).toBeGreaterThan(200);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].source).toBe("event-loop-stall");
    expect(calls[0].severity).toBe("warn");
    expect(calls[0].repo).toBe("integration");
    expect(calls[0].message).toMatch(/exceeded threshold 200ms/);

    handle.stop();
  }, 10_000);
});
