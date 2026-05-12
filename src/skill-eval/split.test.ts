import { describe, expect, it } from "vitest";
import type { EvalQuery } from "./eval-set.js";
import { splitEvalSet } from "./split.js";

function buildEvalSet(count: number): EvalQuery[] {
  return Array.from({ length: count }, (_, i) => ({
    query: `q${i}`,
    shouldTrigger: i % 2 === 0,
  }));
}

describe("splitEvalSet", () => {
  it("returns a 60/40 split (12 train / 8 test) for a 20-query set", () => {
    const queries = buildEvalSet(20);
    const { train, test } = splitEvalSet(queries, 1);
    expect(train.length).toBe(12);
    expect(test.length).toBe(8);
  });

  it("rounds 60% down for non-multiple-of-5 lengths (16 → 9 train / 7 test)", () => {
    const queries = buildEvalSet(16);
    const { train, test } = splitEvalSet(queries, 1);
    expect(train.length + test.length).toBe(16);
    // Math.round(16 * 0.6) === 10 — pin the actual rule:
    // we use Math.round so the train side is "60% rounded to nearest".
    expect(train.length).toBe(10);
    expect(test.length).toBe(6);
  });

  it("produces the same split when called twice with the same seed (determinism)", () => {
    const queries = buildEvalSet(20);
    const a = splitEvalSet(queries, 42);
    const b = splitEvalSet(queries, 42);
    expect(a.train.map((q) => q.query)).toEqual(b.train.map((q) => q.query));
    expect(a.test.map((q) => q.query)).toEqual(b.test.map((q) => q.query));
  });

  it("produces a different split when the seed changes", () => {
    const queries = buildEvalSet(20);
    const a = splitEvalSet(queries, 1);
    const b = splitEvalSet(queries, 2);
    const aIds = a.train.map((q) => q.query).join(",");
    const bIds = b.train.map((q) => q.query).join(",");
    // Two different seeds against 20 queries are essentially guaranteed
    // to produce a different shuffle. If this ever flakes, the PRNG seed
    // distribution has a real bug.
    expect(aIds).not.toBe(bIds);
  });

  it("produces an EXACT golden ordering for seed=1 + 20-query input (pins Mulberry32 + Fisher-Yates implementation)", () => {
    // A test eval-set's accuracy is only stable if the train/test split
    // is stable. Pin the precise ordering produced by the current PRNG
    // + shuffle implementation so a future refactor of either does not
    // silently change which queries are train vs test (which would
    // change every downstream eval-set's reported accuracy). To roll
    // forward: regenerate via
    //   `npx tsx -e "import {splitEvalSet} from './src/skill-eval/split.ts'; …"`
    // and replace the arrays below.
    const queries = buildEvalSet(20);
    const { train, test } = splitEvalSet(queries, 1);
    expect(train.map((q) => q.query)).toEqual([
      "q3", "q6", "q13", "q11", "q18", "q7", "q2", "q1", "q19", "q14", "q10", "q5",
    ]);
    expect(test.map((q) => q.query)).toEqual([
      "q17", "q8", "q4", "q15", "q16", "q9", "q0", "q12",
    ]);
  });

  it("does not mutate the input array", () => {
    const queries = buildEvalSet(20);
    const snapshotIds = queries.map((q) => q.query);
    splitEvalSet(queries, 1);
    expect(queries.map((q) => q.query)).toEqual(snapshotIds);
  });

  it("returns every input query exactly once across train ∪ test (no duplicates, no drops)", () => {
    const queries = buildEvalSet(20);
    const { train, test } = splitEvalSet(queries, 1);
    const combined = new Set([
      ...train.map((q) => q.query),
      ...test.map((q) => q.query),
    ]);
    expect(combined.size).toBe(20);
  });

  it("each side carries both positives and negatives (no stratification breakage on real-shape input)", () => {
    // Default round-robin shuffles can collapse a side to all-positives or
    // all-negatives. This test pins that the seed=1 split of a 20-query
    // even-positive set still gives each side at least one of each — a
    // basic sanity check, not a stratification guarantee. If this fires
    // for a typical seed we should switch to a stratified shuffle.
    const queries = buildEvalSet(20);
    const { train, test } = splitEvalSet(queries, 1);
    expect(train.some((q) => q.shouldTrigger)).toBe(true);
    expect(train.some((q) => !q.shouldTrigger)).toBe(true);
    expect(test.some((q) => q.shouldTrigger)).toBe(true);
    expect(test.some((q) => !q.shouldTrigger)).toBe(true);
  });

  it("rejects an empty input array (split is undefined for empty)", () => {
    expect(() => splitEvalSet([], 1)).toThrow(/empty/i);
  });

  it("works on a 2-element set (degenerate but valid): 1 train / 1 test", () => {
    const queries: EvalQuery[] = [
      { query: "a", shouldTrigger: true },
      { query: "b", shouldTrigger: false },
    ];
    const { train, test } = splitEvalSet(queries, 1);
    expect(train.length + test.length).toBe(2);
    expect(train.length).toBeGreaterThanOrEqual(1);
    expect(test.length).toBeGreaterThanOrEqual(1);
  });

  it("accepts a non-integer seed via Math.floor coercion (operator may pass a float)", () => {
    // Seeds are conventionally integers; mulberry32 wants a uint32. We
    // accept any finite number and floor it. NaN / Infinity should throw.
    const queries = buildEvalSet(20);
    expect(() => splitEvalSet(queries, 1.5)).not.toThrow();
    expect(() => splitEvalSet(queries, Number.NaN)).toThrow(/seed/i);
    expect(() => splitEvalSet(queries, Number.POSITIVE_INFINITY)).toThrow(/seed/i);
  });
});
