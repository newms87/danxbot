import { describe, expect, it } from "vitest";
import { HARD_MAX_ITERATIONS } from "./iterate.js";
import {
  RunIterateArgsError,
  formatIterateReport,
  parseIterateArgs,
} from "./run-iterate.js";

const env = { DANXBOT_WORKER_PORT: "5567", DANXBOT_REPO_ROOT: "/repo" };

describe("parseIterateArgs", () => {
  it("parses positional plugin:skill", () => {
    const a = parseIterateArgs(["dev:debugging"], env);
    expect(a.pluginSkill).toBe("dev:debugging");
    expect(a.maxIterations).toBe(5);
    expect(a.costCapUsd).toBeCloseTo(2.55, 5);
  });

  it("requires a plugin:skill argument", () => {
    expect(() => parseIterateArgs([], env)).toThrow(RunIterateArgsError);
  });

  it("requires DANXBOT_WORKER_PORT (env or flag)", () => {
    expect(() =>
      parseIterateArgs(["dev:debugging"], {
        DANXBOT_REPO_ROOT: "/repo",
      }),
    ).toThrow(/worker-port/);
  });

  it("requires DANXBOT_REPO_ROOT (env or flag)", () => {
    expect(() =>
      parseIterateArgs(["dev:debugging"], {
        DANXBOT_WORKER_PORT: "5567",
      }),
    ).toThrow(/repo-root/);
  });

  it("--max-iterations overrides default", () => {
    const a = parseIterateArgs(
      ["dev:debugging", "--max-iterations", "3"],
      env,
    );
    expect(a.maxIterations).toBe(3);
  });

  it("rejects --max-iterations above HARD_MAX_ITERATIONS", () => {
    expect(() =>
      parseIterateArgs(
        ["dev:debugging", "--max-iterations", `${HARD_MAX_ITERATIONS + 1}`],
        env,
      ),
    ).toThrow(/HARD_MAX|hard-max|cap/i);
  });

  it("rejects --max-iterations below 1", () => {
    expect(() =>
      parseIterateArgs(["dev:debugging", "--max-iterations", "0"], env),
    ).toThrow();
  });

  it("--cost-cap-usd overrides default", () => {
    const a = parseIterateArgs(
      ["dev:debugging", "--cost-cap-usd", "10.5"],
      env,
    );
    expect(a.costCapUsd).toBeCloseTo(10.5, 5);
  });

  it("rejects negative cost cap", () => {
    expect(() =>
      parseIterateArgs(["dev:debugging", "--cost-cap-usd", "-1"], env),
    ).toThrow();
  });

  it("--source-root and --cache-root override defaults", () => {
    const a = parseIterateArgs(
      [
        "dev:debugging",
        "--source-root",
        "/custom/source",
        "--cache-root",
        "/custom/cache",
      ],
      env,
    );
    expect(a.sourceRoot).toBe("/custom/source");
    expect(a.cacheRoot).toBe("/custom/cache");
  });
});

describe("formatIterateReport", () => {
  function record(i: number, train: number, test: number, sha?: string) {
    return {
      iteration: i,
      trainAccuracy: train,
      testAccuracy: test,
      costUsd: 0.5,
      description: `desc ${i}`,
      status: "propose-applied" as const,
      commitSha: sha,
    };
  }

  it("renders a markdown header naming the plugin:skill", () => {
    const md = formatIterateReport({
      pluginSkill: "dev:debugging",
      result: {
        status: "green",
        iterations: [record(0, 0.95, 0.95)],
        bestIteration: 0,
        bestTestAccuracy: 0.95,
        finalDescription: "done",
        totalCostUsd: 0.5,
      },
    });
    expect(md).toContain("# Skill-eval iterate report: dev:debugging");
  });

  it("emits a row per iteration with train/test accuracy + sha", () => {
    const md = formatIterateReport({
      pluginSkill: "dev:debugging",
      result: {
        status: "max-iterations",
        iterations: [
          record(0, 0.5, 0.5),
          record(1, 0.7, 0.7, "abc1234"),
          record(2, 0.8, 0.8, "def5678"),
        ],
        bestIteration: 2,
        bestTestAccuracy: 0.8,
        finalDescription: "desc 2",
        totalCostUsd: 1.5,
      },
    });
    expect(md).toContain("| 0 |");
    expect(md).toContain("abc1234");
    expect(md).toContain("def5678");
  });

  it("surfaces rollback info when finalize restored a prior best", () => {
    const md = formatIterateReport({
      pluginSkill: "dev:debugging",
      result: {
        status: "max-iterations",
        iterations: [
          record(0, 0.5, 0.5),
          record(1, 0.8, 0.8, "abc"),
          record(2, 0.6, 0.6, "def"),
        ],
        bestIteration: 1,
        bestTestAccuracy: 0.8,
        finalDescription: "desc 1",
        totalCostUsd: 1.5,
        rolledBackTo: 1,
      },
    });
    expect(md).toMatch(/rolled back|rollback|restored/i);
    expect(md).toContain("iteration 1");
  });

  it("declares the final verdict prominently", () => {
    expect(
      formatIterateReport({
        pluginSkill: "dev:debugging",
        result: {
          status: "green",
          iterations: [],
          bestIteration: 0,
          bestTestAccuracy: 1.0,
          finalDescription: "x",
          totalCostUsd: 0,
        },
      }),
    ).toMatch(/\*\*GREEN\*\*|\*\*Status: green\*\*/);
  });

  it("renders cost as estimated (~$X) per the existing report convention", () => {
    const md = formatIterateReport({
      pluginSkill: "dev:debugging",
      result: {
        status: "max-iterations",
        iterations: [record(0, 0.5, 0.5)],
        bestIteration: 0,
        bestTestAccuracy: 0.5,
        finalDescription: "x",
        totalCostUsd: 1.5,
      },
    });
    expect(md).toMatch(/~\$1\.50/);
  });

  it("includes proposer / reload / edit error fields when present", () => {
    const md = formatIterateReport({
      pluginSkill: "dev:debugging",
      result: {
        status: "fatal-error",
        iterations: [
          record(0, 0.5, 0.5),
          {
            iteration: 1,
            trainAccuracy: 0.5,
            testAccuracy: 0.5,
            costUsd: 0,
            description: "desc",
            status: "stop-fatal" as const,
            proposerError: "haiku 500",
          },
        ],
        bestIteration: 0,
        bestTestAccuracy: 0.5,
        finalDescription: "desc",
        totalCostUsd: 0.5,
      },
    });
    expect(md).toContain("haiku 500");
  });
});
