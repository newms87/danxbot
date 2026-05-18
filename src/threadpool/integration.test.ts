/**
 * DX-635 integration test — 100-YAML threadpool burst must keep main-
 * loop p99 event-loop delay under 100ms while the parse + canonical-
 * hash work runs in workers.
 *
 * The failure mode this guards against: pre-Phase-2, a 100-card boot
 * scan called `parseYamlText` + `canonicalize` + `sha256` synchronously
 * on the main thread per file; the burst sat on the loop long enough
 * to starve pg-pool's 15s `connectionTimeoutMillis` timer (DX-633 root
 * cause). The pool moves that work off-thread; with the macrotask
 * queue free to pump pg-pool's timers, the loop's p99 delay stays
 * under any reasonable threshold.
 *
 * Threshold: 100ms p99 per the parent epic's Tier-3 metric
 * (`DANXBOT_LOOP_STALL_THRESHOLD_MS` default is 500ms; the AC is more
 * ambitious because the test scenario has zero competing IO load).
 */

import { describe, it, expect, afterAll } from "vitest";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  runCanonicalHash,
  runParseYamlBatch,
  destroyPool,
} from "./pool.js";

function makeYamlText(i: number): string {
  return [
    `schema_version: 10`,
    `id: DX-${i}`,
    `title: Card ${i}`,
    `description: |`,
    `  Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
    `  ${"x".repeat(200)}`,
    `ac:`,
    `  - check_item_id: ""`,
    `    title: criterion ${i}`,
    `    checked: false`,
    `comments: []`,
    `priority: 3`,
    "",
  ].join("\n");
}

describe("threadpool integration — 100-YAML burst", () => {
  afterAll(async () => {
    await destroyPool();
  });

  it("100 parses + hashes through pool keep main-loop p99 < 100ms", async () => {
    // Pre-warm — the first task spawn pays a one-time worker boot cost
    // (~30-100ms includes JIT + module imports inside the worker). Pre-
    // warming before `histogram.enable()` keeps the spawn cost out of
    // the measured window so the threshold reflects steady-state pool
    // behavior, not cold-start.
    await runCanonicalHash({ warmup: true });
    await runParseYamlBatch(["warmup: true"]);

    const histogram = monitorEventLoopDelay({ resolution: 5 });
    histogram.enable();
    try {
      const texts = Array.from({ length: 100 }, (_, i) => makeYamlText(i));

      // Parse the batch in a worker — one cross-thread call covers all 100.
      const parsed = await runParseYamlBatch(texts);
      expect(parsed.every((entry) => entry.ok)).toBe(true);

      // Hash each parsed object through the pool. concurrentTasksPerWorker:1
      // + maxThreads:2 → at most 2 hashes in flight, the rest queue. The
      // main loop pumps the macrotask queue between awaits.
      const hashes = await Promise.all(
        parsed.map((entry) => {
          if (!entry.ok) throw new Error(`unreachable: ${entry.error}`);
          return runCanonicalHash(entry.data);
        }),
      );
      expect(hashes).toHaveLength(100);
      expect(new Set(hashes.map((h) => h.hash)).size).toBe(100);
    } finally {
      histogram.disable();
    }

    const p99Ns = histogram.percentile(99);
    const p99Ms = p99Ns / 1_000_000;
    // Log so a regression captures the actual measurement in CI output.
    // eslint-disable-next-line no-console
    console.log(`[threadpool burst] p99 event-loop delay = ${p99Ms.toFixed(2)}ms`);
    expect(p99Ms).toBeLessThan(100);
  }, 30_000);
});
