/**
 * Tier 4 safety-net wrapper around `retryTransient` for user-facing DB
 * hot paths (DX-637, parent DX-633).
 *
 * **Tier 4 — defense in depth ONLY.** The root-cause fix for the
 * "Connection terminated due to connection timeout" class is the
 * event-loop hardening shipped in DX-634 (yield + bounded concurrency
 * keeps pg-pool's 15s connection timer from starving). The retry helper
 * here is INSURANCE for the residual transient-blip class (genuine pg
 * restart, network glitch, container migration) — a single TCP hiccup
 * never produces a CRITICAL_FAILURE / dropped reconcile / null response.
 *
 * **Anti-pattern.** Do NOT reach for `tier4Retry` as a primary fix for a
 * loop-starvation symptom. If a new DB caller flakes under load, fix the
 * loop-starvation root cause first (Tier 1, DX-634). Adding more retry
 * envelopes around the symptom hides the bug and burns the retry budget
 * on what the loop should have handled. See
 * `.claude/rules/agent-dispatch.md` "Forbidden Patterns".
 *
 * Envelope is intentionally tight — these are USER-FACING hot paths
 * (HTTP request, dispatch INSERT, reconcile timer), not boot-scan. A
 * caller blocking on a 5-minute retry budget would hang the request.
 */

import { retryTransient, type RetryOpts } from "./pg-retry.js";
import { createLogger } from "../logger.js";

const log = createLogger("tier4-retry");

/** Tight budget — user-facing call paths cannot block on long retries. */
export const TIER_4_BUDGET_MS = 2_000;
export const TIER_4_INITIAL_DELAY_MS = 100;
export const TIER_4_MAX_DELAY_MS = 1_000;

/**
 * Run `fn` with Tier 4 safety-net retry envelope. `siteName` is the
 * human-readable label that lands in the `onRetry` warn log so an
 * operator scanning logs can attribute the retry to a specific call
 * site.
 */
export function tier4Retry<T>(
  siteName: string,
  fn: () => Promise<T>,
  extra: Pick<RetryOpts, "sleep" | "now"> = {},
): Promise<T> {
  return retryTransient(fn, {
    budgetMs: TIER_4_BUDGET_MS,
    initialDelayMs: TIER_4_INITIAL_DELAY_MS,
    maxDelayMs: TIER_4_MAX_DELAY_MS,
    onRetry: (err, attempt, delayMs) => {
      log.warn(
        `[tier4:${siteName}] transient pg error — retry ${attempt} after ${delayMs}ms: ${err.message}`,
      );
    },
    ...extra,
  });
}
