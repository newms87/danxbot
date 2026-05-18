/**
 * Bounded-concurrency async map with periodic event-loop yields (DX-634).
 *
 * Replaces `for (const x of items) await fn(x)` patterns over arrays
 * large enough to monopolize the Node event loop. The Anthropic
 * pg-pool client uses a 15s `connectionTimeoutMillis` timer to fail
 * stale-idle checkouts — when an async loop drains only microtasks
 * (`await Promise.resolve()`) between items, the macrotask queue
 * never gets a turn and that timer fires spuriously: "Connection
 * terminated due to connection timeout" against an otherwise-healthy
 * pool. DX-633 root-caused this in production; this helper is the
 * Tier-1 mitigation.
 *
 * The helper interleaves two mitigations:
 *
 *   1. **Bounded concurrency** — at most `concurrency` `fn(item)`
 *      promises in flight. Picks the lower of (a) the explicit option,
 *      (b) the `DANXBOT_LOOP_CONCURRENCY` env var, (c) the
 *      `DEFAULT_LOOP_CONCURRENCY` constant. Default 4.
 *   2. **`setImmediate` yields** — after every `yieldEveryN` completed
 *      items, the loop schedules a `setImmediate` boundary so the
 *      macrotask queue gets a turn. This is what `await Promise.resolve()`
 *      does NOT do: microtask awaits keep draining BEFORE macrotasks
 *      fire, so pg-pool's timer never runs until the synchronous burst
 *      finishes. `setImmediate` is the one primitive that pumps the
 *      macrotask queue mid-loop.
 *
 * Per-item errors are captured via a settled-result shape — callers
 * receive `{status: "fulfilled", value}` / `{status: "rejected",
 * reason}` per input and decide their own error handling. The loop
 * never aborts on a single failure (a bad YAML in `runAuditPass`
 * must not stop the rest of the audit pass).
 *
 * Out of scope: per-item heavy synchronous work (canonical hash on
 * 50KB YAML, JSON.stringify of large audit payloads). Those move to
 * worker_threads in DX-635 (Phase 2). This helper only addresses the
 * "loop hogs the event loop" axis.
 */

export const DEFAULT_LOOP_CONCURRENCY = 4;

/**
 * Resolve the effective concurrency cap. Reads `DANXBOT_LOOP_CONCURRENCY`
 * from the environment; falls back to `DEFAULT_LOOP_CONCURRENCY` when
 * unset, non-numeric, or non-positive.
 */
export function getLoopConcurrency(): number {
  const raw = process.env.DANXBOT_LOOP_CONCURRENCY;
  if (raw === undefined || raw === "") return DEFAULT_LOOP_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOOP_CONCURRENCY;
  return n;
}

export interface YieldLoopOptions {
  /** Max in-flight `fn(item)` promises. Defaults to `getLoopConcurrency()`. */
  concurrency?: number;
  /**
   * Schedule a `setImmediate` boundary after this many completed items.
   * Defaults to the effective concurrency — one yield per batch.
   */
  yieldEveryN?: number;
}

export type YieldLoopResult<T, R> =
  | { item: T; status: "fulfilled"; value: R }
  | { item: T; status: "rejected"; reason: unknown };

/**
 * Run `fn(item)` over `items` with bounded concurrency and periodic
 * event-loop yields. Results are returned in the original index order.
 */
export async function runWithYields<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  options: YieldLoopOptions = {},
): Promise<Array<YieldLoopResult<T, R>>> {
  if (items.length === 0) return [];

  // `concurrency` and `yieldEveryN` defaults are decoupled. The yield
  // cadence tracks `getLoopConcurrency()` (env-driven, defaults to 4)
  // independent of what the caller requests for concurrency. A caller
  // that explicitly passes `concurrency: 1` (sequential walk over a
  // race-sensitive table) still gets the env-tuned yield cadence, NOT
  // one setImmediate per item — which would (a) hammer the macrotask
  // queue pointlessly and (b) hang `vi.useFakeTimers()` suites that
  // mock setImmediate.
  const requestedConcurrency = options.concurrency ?? getLoopConcurrency();
  const concurrency = Math.max(1, Math.min(items.length, requestedConcurrency));
  const yieldEveryN = Math.max(
    1,
    options.yieldEveryN ?? getLoopConcurrency(),
  );

  const results: Array<YieldLoopResult<T, R>> = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      const item = items[i];
      try {
        const value = await fn(item);
        results[i] = { item, status: "fulfilled", value };
      } catch (reason) {
        results[i] = { item, status: "rejected", reason };
      }
      completed += 1;
      if (completed % yieldEveryN === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
