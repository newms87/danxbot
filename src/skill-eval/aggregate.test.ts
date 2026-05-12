import { describe, expect, it } from "vitest";
import {
  aggregateQueryRuns,
  aggregateSide,
  decideOverallPass,
  type QueryRunRecord,
} from "./aggregate.js";

function records(triggered: boolean[]): QueryRunRecord[] {
  return triggered.map((t, i) => ({
    runIndex: i,
    triggered: t,
    jobId: `job-${i}`,
    jsonlPath: `/tmp/${i}.jsonl`,
    reason: t ? "PASS reason" : "FAIL reason",
    skillCalls: [],
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }));
}

describe("aggregateQueryRuns (per-query majority vote)", () => {
  it("3/3 triggered → triggered=true (unanimous PASS)", () => {
    const v = aggregateQueryRuns(
      { query: "q", shouldTrigger: true },
      records([true, true, true]),
    );
    expect(v.triggered).toBe(true);
    expect(v.correct).toBe(true);
    expect(v.triggerCount).toBe(3);
  });

  it("0/3 triggered → triggered=false (unanimous FAIL)", () => {
    const v = aggregateQueryRuns(
      { query: "q", shouldTrigger: true },
      records([false, false, false]),
    );
    expect(v.triggered).toBe(false);
    expect(v.correct).toBe(false);
    expect(v.triggerCount).toBe(0);
  });

  it("2/3 triggered → triggered=true (majority threshold)", () => {
    const v = aggregateQueryRuns(
      { query: "q", shouldTrigger: true },
      records([true, false, true]),
    );
    expect(v.triggered).toBe(true);
    expect(v.correct).toBe(true);
    expect(v.triggerCount).toBe(2);
  });

  it("1/3 triggered → triggered=false (below majority threshold)", () => {
    const v = aggregateQueryRuns(
      { query: "q", shouldTrigger: true },
      records([true, false, false]),
    );
    expect(v.triggered).toBe(false);
    expect(v.correct).toBe(false);
    expect(v.triggerCount).toBe(1);
  });

  it("correct=false when triggered=true but should_trigger=false (negative regression)", () => {
    const v = aggregateQueryRuns(
      { query: "q", shouldTrigger: false },
      records([true, true, false]),
    );
    expect(v.triggered).toBe(true);
    expect(v.correct).toBe(false); // false-positive
  });

  it("correct=true when neither trigger fires AND should_trigger=false", () => {
    const v = aggregateQueryRuns(
      { query: "q", shouldTrigger: false },
      records([false, false, false]),
    );
    expect(v.triggered).toBe(false);
    expect(v.correct).toBe(true);
  });

  it("handles a single-run majority (1/1 triggered → triggered=true)", () => {
    const v = aggregateQueryRuns(
      { query: "q", shouldTrigger: true },
      records([true]),
    );
    expect(v.triggered).toBe(true);
  });

  it("rejects zero runs (no data to vote on)", () => {
    expect(() =>
      aggregateQueryRuns({ query: "q", shouldTrigger: true }, []),
    ).toThrow(/at least one run/i);
  });

  it("rounds the threshold up for even run counts (2/4 is NOT a majority)", () => {
    // 2/4 = 0.5 is NOT a strict majority (> 0.5 required). 3/4 IS.
    const v2 = aggregateQueryRuns(
      { query: "q", shouldTrigger: true },
      records([true, true, false, false]),
    );
    expect(v2.triggered).toBe(false);
    const v3 = aggregateQueryRuns(
      { query: "q", shouldTrigger: true },
      records([true, true, true, false]),
    );
    expect(v3.triggered).toBe(true);
  });

  it("sums tokens across runs into per-query totals", () => {
    const runs = records([true, true, true]);
    const v = aggregateQueryRuns({ query: "q", shouldTrigger: true }, runs);
    expect(v.totalInputTokens).toBe(300);
    expect(v.totalOutputTokens).toBe(150);
  });

  it("sums cacheRead + cacheCreation tokens across runs (cache discounts flow into cost)", () => {
    const runs: QueryRunRecord[] = [
      {
        runIndex: 0,
        triggered: true,
        jobId: "j0",
        jsonlPath: "/tmp/0.jsonl",
        reason: "ok",
        skillCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 100,
        cacheCreationTokens: 50,
      },
      {
        runIndex: 1,
        triggered: true,
        jobId: "j1",
        jsonlPath: "/tmp/1.jsonl",
        reason: "ok",
        skillCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 200,
        cacheCreationTokens: 25,
      },
    ];
    const v = aggregateQueryRuns({ query: "q", shouldTrigger: true }, runs);
    expect(v.totalCacheReadTokens).toBe(300);
    expect(v.totalCacheCreationTokens).toBe(75);
  });
});

describe("aggregateSide (per-side accuracy)", () => {
  function makeVerdict(triggered: boolean, shouldTrigger: boolean) {
    return {
      query: { query: "q", shouldTrigger },
      runs: records([triggered]),
      triggered,
      correct: triggered === shouldTrigger,
      triggerCount: triggered ? 1 : 0,
      totalRuns: 1,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    };
  }

  it("computes accuracy = correct/total", () => {
    const verdicts = [
      makeVerdict(true, true),
      makeVerdict(true, true),
      makeVerdict(false, true),
      makeVerdict(false, true),
    ];
    const side = aggregateSide("train", verdicts);
    expect(side.label).toBe("train");
    expect(side.total).toBe(4);
    expect(side.correct).toBe(2);
    expect(side.accuracy).toBeCloseTo(0.5);
  });

  it("accuracy = 1 when every verdict is correct", () => {
    const verdicts = [makeVerdict(true, true), makeVerdict(false, false)];
    expect(aggregateSide("test", verdicts).accuracy).toBe(1);
  });

  it("accuracy = 0 when every verdict is wrong", () => {
    const verdicts = [makeVerdict(false, true), makeVerdict(true, false)];
    expect(aggregateSide("test", verdicts).accuracy).toBe(0);
  });

  it("accuracy = 0 on an empty side (avoids NaN; tested side has no samples)", () => {
    expect(aggregateSide("test", []).accuracy).toBe(0);
    expect(aggregateSide("test", []).total).toBe(0);
  });
});

describe("decideOverallPass", () => {
  it("PASS when both train and test accuracy ≥ 0.95", () => {
    expect(
      decideOverallPass(
        { label: "train", total: 12, correct: 12, accuracy: 1 },
        { label: "test", total: 8, correct: 8, accuracy: 1 },
      ),
    ).toBe(true);
  });

  it("FAIL when train < 0.95", () => {
    expect(
      decideOverallPass(
        { label: "train", total: 12, correct: 11, accuracy: 11 / 12 },
        { label: "test", total: 8, correct: 8, accuracy: 1 },
      ),
    ).toBe(false);
  });

  it("FAIL when test < 0.95", () => {
    expect(
      decideOverallPass(
        { label: "train", total: 12, correct: 12, accuracy: 1 },
        { label: "test", total: 8, correct: 7, accuracy: 7 / 8 },
      ),
    ).toBe(false);
  });

  it("FAIL when both sides < 0.95", () => {
    expect(
      decideOverallPass(
        { label: "train", total: 12, correct: 8, accuracy: 8 / 12 },
        { label: "test", total: 8, correct: 5, accuracy: 5 / 8 },
      ),
    ).toBe(false);
  });

  it("FAIL when either side has zero samples (avoids vacuous PASS on empty)", () => {
    expect(
      decideOverallPass(
        { label: "train", total: 0, correct: 0, accuracy: 0 },
        { label: "test", total: 8, correct: 8, accuracy: 1 },
      ),
    ).toBe(false);
  });
});
