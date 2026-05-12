import { describe, expect, it, vi } from "vitest";
import type { QueryVerdict } from "./aggregate.js";
import {
  HARD_MAX_ITERATIONS,
  IterateError,
  iterate,
  type IterateDeps,
  type IterateArgs,
  type IterationEvalSummary,
} from "./iterate.js";

function verdict(query: string, shouldTrigger: boolean, correct: boolean): QueryVerdict {
  return {
    query: { query, shouldTrigger },
    runs: [],
    triggered: correct ? shouldTrigger : !shouldTrigger,
    correct,
    triggerCount: correct === shouldTrigger ? (shouldTrigger ? 3 : 0) : (shouldTrigger ? 0 : 3),
    totalRuns: 3,
    totalInputTokens: 10,
    totalOutputTokens: 5,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
  };
}

function buildSummary(
  trainAcc: number,
  testAcc: number,
  cost = 0.5,
): IterationEvalSummary {
  // Build verdict arrays whose accuracy ratios match trainAcc / testAcc.
  // 10 entries on each side. e.g. trainAcc=0.6 → 6 correct + 4 wrong.
  function build(side: "train" | "test", acc: number): QueryVerdict[] {
    const total = 10;
    const correct = Math.round(acc * total);
    const verdicts: QueryVerdict[] = [];
    for (let i = 0; i < total; i++) {
      const isCorrect = i < correct;
      const shouldTrigger = i % 2 === 0;
      verdicts.push(verdict(`${side} q${i}`, shouldTrigger, isCorrect));
    }
    return verdicts;
  }
  return {
    trainAccuracy: trainAcc,
    testAccuracy: testAcc,
    trainVerdicts: build("train", trainAcc),
    testVerdicts: build("test", testAcc),
    totalCostUsd: cost,
    reportMarkdown: "",
  };
}

function makeDeps(
  overrides: Partial<IterateDeps> = {},
  state: { sourceText: string; cacheText: string } = {
    sourceText:
      "---\nname: x\ndescription: 'INITIAL'\n---\nbody",
    cacheText:
      "---\nname: x\ndescription: 'INITIAL'\n---\nbody",
  },
): IterateDeps {
  let proposalCounter = 0;
  return {
    readFile: vi.fn((path: string) =>
      path.includes("cache") ? state.cacheText : state.sourceText,
    ),
    writeFile: vi.fn((path: string, content: string) => {
      if (path.includes("cache")) state.cacheText = content;
      else state.sourceText = content;
    }),
    runEvalSet: vi.fn(async () => buildSummary(1.0, 1.0)),
    proposer: vi.fn(async () => ({
      newDescription: `tighter description #${proposalCounter++}`,
    })),
    gitCommitPush: vi.fn(async () => ({ sha: "abcdef0" })),
    reloadAndVerify: vi.fn(async (args) => {
      // Simulate marketplace pull bringing cache in sync with source.
      state.cacheText = state.sourceText;
      return { cacheDescription: args.expectedDescription };
    }),
    gitExec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      cmd: "git",
      args: [],
    })),
    ...overrides,
  };
}

const baseArgs: IterateArgs = {
  pluginSkill: "dev:debugging",
  sourceSkillPath: "/src/dev/skills/debugging/SKILL.md",
  cacheSkillPath: "/cache/dev/skills/debugging/SKILL.md",
  sourceRepoRoot: "/plugins",
  cacheRepoRoot: "/marketplace",
  relativeSkillPath: "dev/skills/debugging/SKILL.md",
  maxIterations: 5,
  // Set very high so cost-cap does not accidentally trip in tests that
  // are not exercising the cost cap explicitly.
  costCapUsd: 100,
};

describe("iterate", () => {
  it("returns 'green' immediately when initial run already passes", async () => {
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.95, 0.95)),
    });
    const r = await iterate(baseArgs, deps);
    expect(r.status).toBe("green");
    expect(r.iterations.length).toBe(1);
    expect(deps.proposer).not.toHaveBeenCalled();
    expect(deps.gitCommitPush).not.toHaveBeenCalled();
  });

  it("performs propose -> commit -> reload -> re-eval until green", async () => {
    let runCount = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => {
        runCount++;
        return runCount < 3
          ? buildSummary(0.7, 0.6)
          : buildSummary(0.95, 0.95);
      }),
    });
    const r = await iterate(baseArgs, deps);
    expect(r.status).toBe("green");
    expect(r.iterations.length).toBe(3);
    expect(deps.proposer).toHaveBeenCalledTimes(2);
    expect(deps.gitCommitPush).toHaveBeenCalledTimes(2);
    expect(deps.reloadAndVerify).toHaveBeenCalledTimes(2);
  });

  it("hits max-iterations and reports the best iteration", async () => {
    const accs = [0.5, 0.6, 0.65, 0.7, 0.62, 0.55];
    let i = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, accs[i++] ?? 0.5)),
    });
    const r = await iterate({ ...baseArgs, maxIterations: 5 }, deps);
    expect(r.status).toBe("max-iterations");
    expect(r.iterations.length).toBe(6);   // initial + 5 proposals
    expect(r.bestIteration).toBe(3);       // 0:0.5 1:0.6 2:0.65 3:0.7 4:0.62 5:0.55
    expect(r.bestTestAccuracy).toBeCloseTo(0.7, 5);
  });

  it("rolls back to best description when final iteration regressed", async () => {
    const accs = [0.5, 0.8, 0.6];
    let i = 0;
    const proposalDescriptions = ["DESC_A", "DESC_B"];
    let proposalIdx = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, accs[i++] ?? 0.5)),
      proposer: vi.fn(async () => ({
        newDescription: proposalDescriptions[proposalIdx++],
      })),
    });
    const r = await iterate({ ...baseArgs, maxIterations: 2 }, deps);
    expect(r.status).toBe("max-iterations");
    expect(r.bestTestAccuracy).toBeCloseTo(0.8, 5);
    // Iteration 1 (DESC_A) hit 0.8 — best. Iteration 2 (DESC_B) regressed to 0.6.
    // Final state must reflect DESC_A having been restored.
    expect(r.finalDescription).toBe("DESC_A");
    expect(r.rolledBackTo).toBe(1);
    // Rollback adds an extra commit (one final commit_push).
    expect(deps.gitCommitPush).toHaveBeenCalledTimes(3);
  });

  it("does NOT roll back when the final iteration is the best", async () => {
    const accs = [0.5, 0.6, 0.7];
    let i = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, accs[i++] ?? 0.5)),
    });
    const r = await iterate({ ...baseArgs, maxIterations: 2 }, deps);
    expect(r.status).toBe("max-iterations");
    expect(r.rolledBackTo).toBeUndefined();
  });

  it("bails on cost cap before next iteration", async () => {
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, 0.5, 1.5)),
    });
    const r = await iterate({ ...baseArgs, costCapUsd: 2.0, maxIterations: 5 }, deps);
    expect(r.status).toBe("cost-cap");
    expect(r.iterations.length).toBeGreaterThanOrEqual(1);
    expect(r.totalCostUsd).toBeGreaterThan(0);
    expect(r.totalCostUsd).toBeLessThan(2.0 + 1.5 + 0.001);
  });

  it("rejects maxIterations above HARD_MAX_ITERATIONS", async () => {
    await expect(
      iterate(
        { ...baseArgs, maxIterations: HARD_MAX_ITERATIONS + 1 },
        makeDeps(),
      ),
    ).rejects.toThrow(IterateError);
  });

  it("rejects maxIterations < 1", async () => {
    await expect(
      iterate({ ...baseArgs, maxIterations: 0 }, makeDeps()),
    ).rejects.toThrow(/maxIterations/);
  });

  it("classifies a proposer error and stops with 'fatal-error'", async () => {
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, 0.5)),
      proposer: vi.fn(async () => {
        throw new Error("haiku timed out");
      }),
    });
    const r = await iterate(baseArgs, deps);
    expect(r.status).toBe("fatal-error");
    expect(r.iterations.length).toBeGreaterThanOrEqual(1);
    const last = r.iterations[r.iterations.length - 1];
    expect(last.proposerError).toContain("haiku");
  });

  it("classifies a reload-propagation error and stops with 'fatal-error'", async () => {
    let i = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, accFor(i++))),
      reloadAndVerify: vi.fn(async () => {
        throw new Error("propagation drift");
      }),
    });
    const r = await iterate(baseArgs, deps);
    expect(r.status).toBe("fatal-error");
    const last = r.iterations[r.iterations.length - 1];
    expect(last.reloadError).toContain("propagation");
  });

  it("validates that the proposed description differs from current before committing", async () => {
    let runs = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => {
        runs++;
        return buildSummary(0.5, runs === 1 ? 0.5 : 0.95);
      }),
      // Proposer returns the SAME description as current — orchestrator must
      // detect "no change" and stop (no point re-running the same eval).
      proposer: vi.fn(async () => ({ newDescription: "INITIAL" })),
    });
    const r = await iterate(baseArgs, deps);
    expect(r.status).toBe("fatal-error");
    const last = r.iterations[r.iterations.length - 1];
    expect(last.proposerError).toMatch(/identical|same|no change/i);
  });

  it("threads only train failures (not test) into the proposer", async () => {
    let captured: unknown = null;
    let runs = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => {
        runs++;
        return runs === 1 ? buildSummary(0.5, 0.5) : buildSummary(0.95, 0.95);
      }),
      proposer: vi.fn(async (input) => {
        captured = input;
        return { newDescription: "tighter" };
      }),
    });
    await iterate(baseArgs, deps);
    expect(captured).not.toBeNull();
    const inp = captured as { trainFailures: { query: string }[] };
    expect(inp.trainFailures.length).toBeGreaterThan(0);
    // Train queries are prefixed "train q…" in the test summary builder.
    for (const f of inp.trainFailures) {
      expect(f.query).toMatch(/^train q/);
    }
  });

  it("attaches every commit sha to its iteration record", async () => {
    let runs = 0;
    let shaCounter = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => {
        runs++;
        return runs >= 3 ? buildSummary(0.95, 0.95) : buildSummary(0.5, 0.5);
      }),
      gitCommitPush: vi.fn(async () => ({
        sha: `sha${shaCounter++}`,
      })),
    });
    const r = await iterate(baseArgs, deps);
    // Iteration 0 = initial (no proposal, no commit).
    // Iterations 1+ = each carries a commit sha.
    const withSha = r.iterations.filter((it) => it.commitSha);
    expect(withSha.length).toBe(2);
    expect(withSha[0].commitSha).toBe("sha0");
    expect(withSha[1].commitSha).toBe("sha1");
  });
});

function accFor(i: number): number {
  // Helper for the reload-error test — return decreasing accuracies so we
  // don't hit green by accident.
  const seq = [0.5, 0.55, 0.6];
  return seq[i] ?? 0.5;
}

describe("iterate — rollback edge cases", () => {
  it("rolls back to the INITIAL description when best == iteration 0", async () => {
    // Initial scores 0.9 (above every proposal). All proposals
    // regress. After max-iterations, finalize must restore the original
    // unmodified source.
    const accs = [0.9, 0.5, 0.4, 0.3];
    let i = 0;
    const initialSource =
      "---\nname: x\ndescription: 'INITIAL'\n---\nbody";
    const state = { sourceText: initialSource, cacheText: initialSource };
    const deps = makeDeps(
      {
        runEvalSet: vi.fn(async () => buildSummary(0.5, accs[i++] ?? 0.5)),
      },
      state,
    );
    const r = await iterate({ ...baseArgs, maxIterations: 3 }, deps);
    expect(r.bestIteration).toBe(0);
    expect(r.bestTestAccuracy).toBeCloseTo(0.9, 5);
    expect(r.rolledBackTo).toBe(0);
    expect(r.finalDescription).toBe("INITIAL");
    // Source on disk must be the original after rollback.
    expect(state.sourceText).toBe(initialSource);
  });

  it("captures rollbackError + still returns the result if the rollback push fails", async () => {
    const accs = [0.5, 0.8, 0.6];
    let i = 0;
    let pushCount = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, accs[i++] ?? 0.5)),
      gitCommitPush: vi.fn(async () => {
        pushCount++;
        if (pushCount === 3) throw new Error("rollback push rejected");
        return { sha: `sha${pushCount}` };
      }),
    });
    const r = await iterate({ ...baseArgs, maxIterations: 2 }, deps);
    expect(r.status).toBe("max-iterations");
    expect(r.rolledBackTo).toBeUndefined();        // rollback failed
    expect(r.rollbackError).toContain("rollback push rejected");
  });

  it("captures rollbackError when the marketplace pull fails during rollback", async () => {
    const accs = [0.5, 0.8, 0.6];
    let i = 0;
    let reloadCount = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, accs[i++] ?? 0.5)),
      reloadAndVerify: vi.fn(async () => {
        reloadCount++;
        if (reloadCount === 3)
          throw new Error("marketplace pull conflict during rollback");
        return { cacheDescription: "ok" };
      }),
    });
    const r = await iterate({ ...baseArgs, maxIterations: 2 }, deps);
    expect(r.rollbackError).toContain("marketplace pull conflict");
  });

  it("does NOT trip cost-cap when all observed costs are zero", async () => {
    // Stub eval-set returning cost=0 every iteration → loop runs to
    // maxIterations regardless of cost cap.
    const accs = [0.5, 0.55, 0.6];
    let i = 0;
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, accs[i++] ?? 0.5, 0)),
    });
    const r = await iterate(
      { ...baseArgs, maxIterations: 2, costCapUsd: 0.01 },
      deps,
    );
    expect(r.status).toBe("max-iterations");
    expect(r.totalCostUsd).toBe(0);
  });

  it("rolls back via gitCommitPush with rollbackToIteration set (not iteration: -1)", async () => {
    const accs = [0.5, 0.8, 0.6];
    let i = 0;
    const commitArgsCaptured: unknown[] = [];
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(0.5, accs[i++] ?? 0.5)),
      gitCommitPush: vi.fn(async (args) => {
        commitArgsCaptured.push(args);
        return { sha: `sha${commitArgsCaptured.length}` };
      }),
    });
    const r = await iterate({ ...baseArgs, maxIterations: 2 }, deps);
    expect(r.rolledBackTo).toBe(1);
    // 3 commit calls total: iter 1, iter 2, rollback.
    expect(commitArgsCaptured.length).toBe(3);
    const rollback = commitArgsCaptured[2] as {
      iteration: number;
      rollbackToIteration?: number;
    };
    expect(rollback.iteration).toBeGreaterThanOrEqual(0); // not -1
    expect(rollback.rollbackToIteration).toBe(1);
  });
});

describe("iterate — green initial assertions", () => {
  it("on green-initial, rolledBackTo is undefined and bestIteration is 0", async () => {
    const deps = makeDeps({
      runEvalSet: vi.fn(async () => buildSummary(1.0, 1.0)),
    });
    const r = await iterate(baseArgs, deps);
    expect(r.status).toBe("green");
    expect(r.bestIteration).toBe(0);
    expect(r.rolledBackTo).toBeUndefined();
    expect(r.rollbackError).toBeUndefined();
  });
});
