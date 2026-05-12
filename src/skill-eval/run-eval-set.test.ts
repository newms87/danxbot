import { describe, expect, it, vi } from "vitest";
import { aggregateSide } from "./aggregate.js";
import type { EvalQuery } from "./eval-set.js";
import type { ProbeArgs, ProbeResult } from "./probe.js";
import { ProbeError } from "./probe.js";
import {
  RunEvalSetArgsError,
  parseEvalSetArgs,
  runEvalSetCore,
} from "./run-eval-set.js";

function makeProbeResult(opts: {
  pass: boolean;
  jobId?: string;
  inputTokens?: number;
  outputTokens?: number;
}): ProbeResult {
  const jobId = opts.jobId ?? "probe-1";
  return {
    jobId,
    dispatchTag: `<!-- danxbot-dispatch:${jobId} -->`,
    exitCode: 0,
    jsonlPath: `/tmp/${jobId}.jsonl`,
    discovery: {
      reason: "found",
      path: `/tmp/${jobId}.jsonl`,
      dir: "/tmp",
      scannedFiles: 1,
      unreadableFiles: [],
    },
    verdict: {
      pass: opts.pass,
      reason: opts.pass ? "triggered" : "did not trigger",
      skillCalls: opts.pass ? ["dev:debugging"] : [],
      firstAssistantText: opts.pass ? undefined : "answered directly",
      tagFound: true,
      droppedLines: 0,
    },
    usage: {
      inputTokens: opts.inputTokens ?? 1000,
      outputTokens: opts.outputTokens ?? 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    elapsedMs: 100,
  };
}

describe("parseEvalSetArgs", () => {
  const baseEnv = {
    DANXBOT_REPO_ROOT: "/tmp/repo",
  };

  it("happy path: positional plugin:skill argument", () => {
    const args = parseEvalSetArgs(["dev:debugging"], baseEnv);
    expect(args.pluginSkill).toBe("dev:debugging");
    expect(args.parallel).toBe(3);
    expect(args.runsPerQuery).toBe(3);
    expect(args.seed).toBe(1);
    expect(args.workspace).toBe("skill-eval");
    expect(args.workspaceCwd).toBe("/tmp/repo/.danxbot/workspaces/skill-eval");
  });

  it("accepts --plugin-skill flag form too", () => {
    const args = parseEvalSetArgs(
      ["--plugin-skill", "base:tool-discipline"],
      baseEnv,
    );
    expect(args.pluginSkill).toBe("base:tool-discipline");
  });

  it("--parallel / --seed / --runs-per-query overrides", () => {
    const args = parseEvalSetArgs(
      [
        "dev:debugging",
        "--parallel=5",
        "--seed=42",
        "--runs-per-query=5",
      ],
      baseEnv,
    );
    expect(args.parallel).toBe(5);
    expect(args.seed).toBe(42);
    expect(args.runsPerQuery).toBe(5);
  });

  it("throws on missing plugin:skill", () => {
    expect(() => parseEvalSetArgs([], baseEnv)).toThrow(RunEvalSetArgsError);
  });

  it("throws on missing DANXBOT_REPO_ROOT", () => {
    expect(() => parseEvalSetArgs(["dev:debugging"], {})).toThrow(/repo-root/);
  });

  it("rejects --parallel=0 (must be ≥ 1)", () => {
    expect(() =>
      parseEvalSetArgs(["dev:debugging", "--parallel=0"], baseEnv),
    ).toThrow(/parallel/);
  });

  it("rejects --runs-per-query=0 (must be ≥ 1)", () => {
    expect(() =>
      parseEvalSetArgs(["dev:debugging", "--runs-per-query=0"], baseEnv),
    ).toThrow(/runs-per-query/);
  });

  it("--pricing-model defaults to claude-sonnet-4-6", () => {
    expect(parseEvalSetArgs(["dev:debugging"], baseEnv).pricingModel).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("--pricing-model override", () => {
    expect(
      parseEvalSetArgs(
        ["dev:debugging", "--pricing-model=claude-opus-4-6"],
        baseEnv,
      ).pricingModel,
    ).toBe("claude-opus-4-6");
  });
});

describe("runEvalSetCore (with injected probe)", () => {
  function buildEvalSet(positives: number, negatives: number): EvalQuery[] {
    return [
      ...Array.from({ length: positives }, (_, i) => ({
        query: `pos-${i}`,
        shouldTrigger: true,
      })),
      ...Array.from({ length: negatives }, (_, i) => ({
        query: `neg-${i}`,
        shouldTrigger: false,
      })),
    ];
  }

  function baseArgs() {
    return {
      pluginSkill: "dev:debugging",
      evalSetPath: "/tmp/eval-set.json",
      workspace: "skill-eval",
      workspaceCwd: "/tmp/repo/.danxbot/workspaces/skill-eval",
      timeoutMs: 60_000,
      parallel: 3,
      seed: 1,
      runsPerQuery: 3,
      pricingModel: "claude-sonnet-4-6",
    };
  }

  it("returns exit 0 + overallPass=true when every query majority-votes correctly", async () => {
    const evalSet = buildEvalSet(10, 10);
    const probe = vi.fn(
      async (probeArgs: ProbeArgs): Promise<ProbeResult> => {
        // Query is a positive iff the queried text starts with "pos-".
        const isPos = probeArgs.query.startsWith("pos-");
        return makeProbeResult({ pass: isPos });
      },
    );
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    expect(result.overallPass).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.markdown).toMatch(/Overall: PASS/);
    // 20 queries × 3 runs = 60 probe invocations.
    expect(probe).toHaveBeenCalledTimes(60);
  });

  it("exposes trainVerdicts + testVerdicts shaped per the 60/40 split", async () => {
    // 20 queries → train=12, test=8 (Math.round(0.6 * 20)=12). Verdicts
    // must be populated, lengths must match the split, and per-verdict
    // shape (correct flag, query reference, run records) must round-trip
    // through aggregateSide for the iteration loop's failure extraction.
    const evalSet = buildEvalSet(10, 10);
    const probe = vi.fn(async (probeArgs: ProbeArgs) => {
      // Half of positives miss → false negatives feed train failures.
      const isPos = probeArgs.query.startsWith("pos-");
      const fakeMiss = isPos && /[02468]$/.test(probeArgs.query);
      return makeProbeResult({ pass: isPos && !fakeMiss });
    });
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    expect(result.trainVerdicts.length).toBe(12);
    expect(result.testVerdicts.length).toBe(8);
    // No overlap: every query appears in exactly one half.
    const trainQueries = new Set(result.trainVerdicts.map((v) => v.query.query));
    const testQueries = new Set(result.testVerdicts.map((v) => v.query.query));
    for (const q of trainQueries) expect(testQueries.has(q)).toBe(false);
    // Aggregator must compute non-trivial accuracy from the verdicts.
    const trainAcc = aggregateSide("train", result.trainVerdicts).accuracy;
    expect(trainAcc).toBeGreaterThanOrEqual(0);
    expect(trainAcc).toBeLessThanOrEqual(1);
    // At least one false-negative on the train side (the iteration
    // loop's failure-extraction needs to find these).
    const trainFailures = result.trainVerdicts.filter((v) => !v.correct);
    expect(trainFailures.length).toBeGreaterThan(0);
  });

  it("returns exit 1 when accuracy is below the 95% threshold", async () => {
    const evalSet = buildEvalSet(10, 10);
    let callIdx = 0;
    const probe = vi.fn(async (probeArgs: ProbeArgs) => {
      // Flip half the positive queries to never-fire so accuracy drops
      // below 95% on at least one side.
      const isPos = probeArgs.query.startsWith("pos-");
      const fakeMiss = isPos && probeArgs.query.endsWith("0");
      callIdx++;
      return makeProbeResult({ pass: isPos && !fakeMiss });
    });
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    expect(result.overallPass).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.markdown).toMatch(/Overall: FAIL/);
  });

  it("respects bounded parallelism: never has more than N in-flight at once", async () => {
    const evalSet = buildEvalSet(8, 8); // 16 × 3 = 48 probes
    let inFlight = 0;
    let maxInFlight = 0;
    const probe = vi.fn(async (probeArgs: ProbeArgs) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return makeProbeResult({
        pass: probeArgs.query.startsWith("pos-"),
      });
    });
    await runEvalSetCore({ ...baseArgs(), parallel: 4 }, evalSet, probe);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("runs each query exactly runsPerQuery times", async () => {
    const evalSet = buildEvalSet(4, 4); // 8 × runs probes
    const calls = new Map<string, number>();
    const probe = vi.fn(async (probeArgs: ProbeArgs) => {
      calls.set(probeArgs.query, (calls.get(probeArgs.query) ?? 0) + 1);
      return makeProbeResult({
        pass: probeArgs.query.startsWith("pos-"),
      });
    });
    await runEvalSetCore({ ...baseArgs(), runsPerQuery: 5 }, evalSet, probe);
    for (const q of evalSet) {
      expect(calls.get(q.query)).toBe(5);
    }
  });

  it("treats a ProbeError as a did-not-trigger run (does NOT crash the sweep)", async () => {
    const evalSet = buildEvalSet(4, 4);
    let counter = 0;
    const probe = vi.fn(async (probeArgs: ProbeArgs) => {
      counter++;
      // Inject one probe error early on; the rest succeed.
      if (counter === 2) {
        throw new ProbeError("simulated timeout", "timeout");
      }
      return makeProbeResult({
        pass: probeArgs.query.startsWith("pos-"),
      });
    });
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    expect(result.markdown).toBeTruthy();
    expect(probe).toHaveBeenCalledTimes(8 * 3);
  });

  it("also records non-ProbeError exceptions as did-not-trigger runs (orphan-protection)", async () => {
    // The orchestrator catches ANY thrown error in the lane and emits
    // a no-fire record. The previous design rethrew non-ProbeError
    // exceptions, which short-circuited Promise.all and left other
    // lanes' in-flight probes orphaned on the worker. Pin the
    // catch-all contract so a TypeError / RangeError / network shape
    // bug doesn't melt the sweep.
    //
    // Throw on EVERY call for one specific positive query — all 3 runs
    // error, the majority vote becomes "did-not-trigger", and the
    // verdict is incorrect (positive that didn't trigger). The
    // resulting Failures section carries the unexpected-runner-error
    // message for the operator.
    const evalSet = buildEvalSet(4, 4);
    const probe = vi.fn(async (probeArgs: ProbeArgs) => {
      if (probeArgs.query === "pos-0") {
        throw new TypeError("boom from a non-probe error");
      }
      return makeProbeResult({
        pass: probeArgs.query.startsWith("pos-"),
      });
    });
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    expect(result.markdown).toBeTruthy();
    expect(probe).toHaveBeenCalledTimes(8 * 3);
    expect(result.markdown).toMatch(/unexpected runner error.*TypeError/);
  });

  it("aggregation is order-stable: probes resolving out of order still attribute runs to the correct query", async () => {
    // Make probes resolve in REVERSE order — the last item dispatched
    // resolves first, the first dispatched resolves last. The
    // orchestrator must still aggregate by queryIdx (not by resolution
    // order) so each query gets its 3 runs.
    const evalSet = buildEvalSet(3, 3);
    let counter = 0;
    const probe = vi.fn(async (probeArgs: ProbeArgs) => {
      const myCall = counter++;
      await new Promise((r) => setTimeout(r, 5 * (20 - myCall)));
      return makeProbeResult({
        pass: probeArgs.query.startsWith("pos-"),
      });
    });
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    // Every query that should trigger triggered; the markdown should
    // NOT contain a Failures section because everything is correct.
    expect(result.markdown).not.toMatch(/## Failures/);
    expect(result.overallPass).toBe(true);
  });

  it("includes cache token cost in totalCostUsd (cache discounts flow through)", async () => {
    const evalSet = buildEvalSet(4, 4);
    const probe = vi.fn(async (probeArgs: ProbeArgs): Promise<ProbeResult> => {
      return {
        jobId: "j",
        dispatchTag: "<!-- danxbot-dispatch:j -->",
        exitCode: 0,
        jsonlPath: "/tmp/j.jsonl",
        discovery: {
          reason: "found",
          path: "/tmp/j.jsonl",
          dir: "/tmp",
          scannedFiles: 1,
          unreadableFiles: [],
        },
        verdict: {
          pass: probeArgs.query.startsWith("pos-"),
          reason: "x",
          skillCalls: [],
          tagFound: true,
          droppedLines: 0,
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 5_000,
        },
        elapsedMs: 1,
      };
    });
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    // 8 queries × 3 runs × (10000 cacheRead @ $0.30/M + 5000 cacheWrite
    // @ $3.75/M for Sonnet-4-6):
    //   cacheRead = 8*3*10000 * 0.30 / 1e6 = $0.072
    //   cacheWrite = 8*3*5000 * 3.75 / 1e6 = $0.450
    //   total ≈ $0.522
    expect(result.totalCostUsd).toBeGreaterThan(0.5);
    expect(result.totalCostUsd).toBeLessThan(0.55);
  });

  it("aggregates total cost across all probes using the pricing model", async () => {
    const evalSet = buildEvalSet(4, 4);
    const probe = vi.fn(async (probeArgs: ProbeArgs) => {
      return makeProbeResult({
        pass: probeArgs.query.startsWith("pos-"),
        inputTokens: 1000,
        outputTokens: 500,
      });
    });
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    // 8 queries × 3 runs × (1000 input + 500 output) Sonnet pricing:
    //   input  = 8*3*1000 * $3.00 / 1e6 = $0.072
    //   output = 8*3* 500 * $15.00 / 1e6 = $0.18
    //   total ≈ $0.252
    expect(result.totalCostUsd).toBeGreaterThan(0.2);
    expect(result.totalCostUsd).toBeLessThan(0.3);
  });

  it("splits the queries 60/40 deterministically and renders both sides in the report", async () => {
    const evalSet = buildEvalSet(10, 10); // 20 → 12 train / 8 test
    const probe = vi.fn(async (probeArgs: ProbeArgs) =>
      makeProbeResult({ pass: probeArgs.query.startsWith("pos-") }),
    );
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    // The accuracy section shows both train (12 total) and test (8 total).
    expect(result.markdown).toMatch(/train.*12/);
    expect(result.markdown).toMatch(/test.*8/);
  });

  it("threads ProbeArgs (workspace, workspaceCwd, expectSkill, timeoutMs) into every probe call", async () => {
    const evalSet = buildEvalSet(4, 4);
    const probe = vi.fn(async (probeArgs: ProbeArgs) => {
      expect(probeArgs.workspace).toBe("custom-ws");
      expect(probeArgs.workspaceCwd).toBe("/srv/custom");
      expect(probeArgs.expectSkill).toBe("dev:debugging");
      expect(probeArgs.timeoutMs).toBe(60_000);
      return makeProbeResult({ pass: probeArgs.query.startsWith("pos-") });
    });
    await runEvalSetCore(
      {
        ...baseArgs(),
        workspace: "custom-ws",
        workspaceCwd: "/srv/custom",
      },
      evalSet,
      probe,
    );
    expect(probe).toHaveBeenCalled();
  });

  it("emits per-failure forensics in the report for every wrong verdict", async () => {
    const evalSet = buildEvalSet(2, 2);
    // Force ALL queries to fail (positives don't trigger, negatives trigger).
    const probe = vi.fn(async (probeArgs: ProbeArgs) =>
      makeProbeResult({ pass: !probeArgs.query.startsWith("pos-") }),
    );
    const result = await runEvalSetCore(baseArgs(), evalSet, probe);
    expect(result.markdown).toMatch(/## Failures/);
    // Every query should appear in the failures section since none of them is correct.
    for (const q of evalSet) {
      expect(result.markdown).toContain(q.query);
    }
  });
});
