/**
 * Per-query majority-vote aggregation + per-side accuracy + overall pass
 * decision for the skill-eval harness.
 *
 * Pure module. All math is folded over already-completed `QueryRunRecord`s;
 * IO (dispatch, JSONL parsing, file reads) lives in `probe.ts` and the
 * orchestrator (`run-eval-set.ts`).
 *
 * Majority rule: a query is "triggered" iff a STRICT majority of its runs
 * fired the expected skill — `triggerCount * 2 > totalRuns`. For the
 * default 3 runs that's the conventional `≥ 2 / 3` from the eval-set
 * description. For 4 runs we require `≥ 3` (2/4 is a tie, not a majority).
 * Strict majority avoids the ambiguity of a half-and-half result counting
 * as a flip-of-a-coin "yes".
 *
 * Pass threshold: 0.95 on BOTH train AND test sides per the AC. Falls
 * below 0.95 OR either side is empty → overall FAIL.
 */

import type { EvalQuery } from "./eval-set.js";

export const PASS_THRESHOLD = 0.95;

export interface QueryRunRecord {
  readonly runIndex: number;
  readonly triggered: boolean;
  readonly jobId: string;
  readonly jsonlPath: string | null;
  readonly reason: string;
  readonly skillCalls: readonly string[];
  readonly firstAssistantText?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface QueryVerdict {
  readonly query: EvalQuery;
  readonly runs: readonly QueryRunRecord[];
  readonly triggered: boolean;
  readonly correct: boolean;
  readonly triggerCount: number;
  readonly totalRuns: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
}

export interface SideAccuracy {
  readonly label: string;
  readonly total: number;
  readonly correct: number;
  readonly accuracy: number;
}

export function aggregateQueryRuns(
  query: EvalQuery,
  runs: readonly QueryRunRecord[],
): QueryVerdict {
  if (runs.length === 0) {
    throw new Error(
      `aggregateQueryRuns: must have at least one run for query "${query.query.slice(0, 40)}…"`,
    );
  }
  const triggerCount = runs.filter((r) => r.triggered).length;
  // Strict majority — 2/3 PASS, 2/4 FAIL. See module header.
  const triggered = triggerCount * 2 > runs.length;
  return {
    query,
    runs,
    triggered,
    correct: triggered === query.shouldTrigger,
    triggerCount,
    totalRuns: runs.length,
    totalInputTokens: runs.reduce((acc, r) => acc + r.inputTokens, 0),
    totalOutputTokens: runs.reduce((acc, r) => acc + r.outputTokens, 0),
    totalCacheReadTokens: runs.reduce((acc, r) => acc + r.cacheReadTokens, 0),
    totalCacheCreationTokens: runs.reduce(
      (acc, r) => acc + r.cacheCreationTokens,
      0,
    ),
  };
}

export function aggregateSide(
  label: string,
  verdicts: readonly QueryVerdict[],
): SideAccuracy {
  const total = verdicts.length;
  const correct = verdicts.filter((v) => v.correct).length;
  // accuracy=0 on empty avoids NaN (correct / 0). The overall pass
  // decision treats `total === 0` as a fail, so the side reads zero
  // correctly downstream.
  const accuracy = total === 0 ? 0 : correct / total;
  return { label, total, correct, accuracy };
}

export function decideOverallPass(
  train: SideAccuracy,
  test: SideAccuracy,
): boolean {
  if (train.total === 0 || test.total === 0) return false;
  return train.accuracy >= PASS_THRESHOLD && test.accuracy >= PASS_THRESHOLD;
}
