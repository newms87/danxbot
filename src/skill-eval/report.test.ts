import { describe, expect, it } from "vitest";
import type { EvalQuery } from "./eval-set.js";
import type { QueryRunRecord, QueryVerdict, SideAccuracy } from "./aggregate.js";
import { renderReport, type ReportInput } from "./report.js";

function run(triggered: boolean, idx = 0): QueryRunRecord {
  return {
    runIndex: idx,
    triggered,
    jobId: `job-${idx}`,
    jsonlPath: `/tmp/${idx}.jsonl`,
    reason: triggered ? "skill triggered" : "no skill loaded",
    skillCalls: triggered ? ["dev:debugging"] : [],
    firstAssistantText: triggered ? undefined : "I'll start by reading...",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function verdict(
  q: EvalQuery,
  triggered: boolean,
  triggerCount = triggered ? 3 : 0,
): QueryVerdict {
  return {
    query: q,
    runs: [run(true, 0), run(true, 1), run(triggered, 2)],
    triggered,
    correct: triggered === q.shouldTrigger,
    triggerCount,
    totalRuns: 3,
    totalInputTokens: 300,
    totalOutputTokens: 150,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
  };
}

function side(label: string, total: number, correct: number): SideAccuracy {
  return { label, total, correct, accuracy: total === 0 ? 0 : correct / total };
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  const q1: EvalQuery = { query: "should fire", shouldTrigger: true };
  const q2: EvalQuery = { query: "should not", shouldTrigger: false };
  return {
    pluginSkill: "dev:debugging",
    evalSetPath: "/tmp/eval-set.json",
    seed: 1,
    runsPerQuery: 3,
    trainVerdicts: [verdict(q1, true)],
    testVerdicts: [verdict(q2, false)],
    train: side("train", 1, 1),
    test: side("test", 1, 1),
    overallPass: true,
    totalCostUsd: 0.04,
    pricingModel: "claude-sonnet-4-6",
    elapsedMs: 12_345,
    ...overrides,
  };
}

describe("renderReport — top-level structure", () => {
  it("renders an H1 header with the plugin:skill name", () => {
    const md = renderReport(input());
    expect(md).toMatch(/^# Skill-eval report: dev:debugging/m);
  });

  it("includes the PASS / FAIL verdict prominently", () => {
    const pass = renderReport(input({ overallPass: true }));
    expect(pass).toMatch(/\*\*Overall: PASS\*\*/);
    const fail = renderReport(input({ overallPass: false }));
    expect(fail).toMatch(/\*\*Overall: FAIL\*\*/);
  });

  it("includes a parameters section with seed, runs-per-query, model, elapsed", () => {
    const md = renderReport(input({ seed: 42, runsPerQuery: 5 }));
    expect(md).toContain("Eval-set: `/tmp/eval-set.json`");
    expect(md).toContain("Seed: `42`");
    expect(md).toContain("Runs per query: `5`");
    expect(md).toContain("Pricing model: `claude-sonnet-4-6`");
  });

  it("renders the per-side accuracy matrix as a markdown table", () => {
    const md = renderReport(
      input({
        train: side("train", 12, 11),
        test: side("test", 8, 7),
      }),
    );
    expect(md).toMatch(/\| Side\s+\| Correct/);
    expect(md).toMatch(/train.*11.*12/);
    expect(md).toMatch(/test.*7.*8/);
  });

  it("reports a percentage with two decimals", () => {
    const md = renderReport(
      input({ train: side("train", 100, 95), test: side("test", 100, 99) }),
    );
    expect(md).toContain("95.00%");
    expect(md).toContain("99.00%");
  });

  it("reports total cost as an estimate (`~$X`) at four decimals", () => {
    const md = renderReport(input({ totalCostUsd: 0.0432 }));
    expect(md).toContain("~$0.0432");
    // The `~` prefix is load-bearing: without it, the 4-decimal
    // precision reads as exact when the underlying pricing model is
    // operator-supplied, not pinned per-message.
    expect(md).not.toMatch(/cost: `\$0\.0432`/);
  });

  it("renders a non-default pricingModel verbatim in the parameters block", () => {
    const md = renderReport(
      input({ pricingModel: "claude-opus-4-6" }),
    );
    expect(md).toContain("Pricing model: `claude-opus-4-6`");
  });

  it("reports elapsed time in a human-readable form", () => {
    const md = renderReport(input({ elapsedMs: 65_000 }));
    expect(md).toMatch(/Elapsed: `1m 5s`/);
  });
});

describe("renderReport — per-failure forensics", () => {
  it("emits a per-failure block for every wrong verdict (with prompt + jsonl + first-text + observed skills)", () => {
    const q: EvalQuery = { query: "expected positive", shouldTrigger: true };
    const failed = verdict(q, false, 0);
    const md = renderReport(
      input({
        trainVerdicts: [failed],
        train: side("train", 1, 0),
      }),
    );
    // The per-failure section lives under a heading and lists every wrong verdict.
    expect(md).toMatch(/## Failures/);
    expect(md).toMatch(/expected positive/);
    // Each run is enumerated with its JSONL path.
    expect(md).toContain("/tmp/0.jsonl");
    expect(md).toContain("/tmp/1.jsonl");
    expect(md).toContain("/tmp/2.jsonl");
    // Observed skills + first assistant text surface for diagnostic value.
    expect(md).toMatch(/first_assistant_text/);
  });

  it("omits the failures section entirely when there are no wrong verdicts", () => {
    const md = renderReport(input());
    expect(md).not.toMatch(/## Failures/);
  });

  it("annotates each failure block with side label (train vs test)", () => {
    const q: EvalQuery = { query: "neg fail", shouldTrigger: false };
    const failedTrain = verdict(q, true, 3); // triggered=true but should=false → false-positive on train
    const failedTest = verdict(
      { query: "pos fail", shouldTrigger: true },
      false,
      0,
    ); // triggered=false but should=true → false-negative on test
    const md = renderReport(
      input({
        trainVerdicts: [failedTrain],
        testVerdicts: [failedTest],
        train: side("train", 1, 0),
        test: side("test", 1, 0),
        overallPass: false,
      }),
    );
    expect(md).toMatch(/\(train\).*neg fail/s);
    expect(md).toMatch(/\(test\).*pos fail/s);
  });

  it("renders both false-positive and false-negative classifications in the failure label", () => {
    const fp = verdict({ query: "fp", shouldTrigger: false }, true, 3);
    const fn = verdict({ query: "fn", shouldTrigger: true }, false, 0);
    const md = renderReport(
      input({
        trainVerdicts: [fp, fn],
        train: side("train", 2, 0),
        testVerdicts: [],
        test: side("test", 1, 1),
        overallPass: false,
      }),
    );
    expect(md).toMatch(/false-positive/);
    expect(md).toMatch(/false-negative/);
  });
});

describe("renderReport — query-level vote tallies", () => {
  it("shows the X/Y vote count in each failure section", () => {
    const failed = verdict(
      { query: "q", shouldTrigger: true },
      false,
      1, // 1/3 triggered → not majority, FAIL
    );
    const md = renderReport(
      input({ trainVerdicts: [failed], train: side("train", 1, 0) }),
    );
    expect(md).toMatch(/1\s*\/\s*3/);
  });
});
