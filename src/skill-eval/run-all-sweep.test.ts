import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SideAccuracy } from "./aggregate.js";
import type { EvalQuery } from "./eval-set.js";
import {
  discoverEvalSets,
  parseSweepArgs,
  renderSweepRollup,
  runAllSweepCore,
  RunAllSweepArgsError,
  type RunAllSweepArgs,
  type SweepEntryResult,
  type SweepRunOneFn,
} from "./run-all-sweep.js";

function makeSideAccuracy(
  label: "train" | "test",
  correct: number,
  total: number,
): SideAccuracy {
  return {
    label,
    correct,
    total,
    accuracy: total === 0 ? 0 : correct / total,
  };
}

function makeFakeEvalSetDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  // Minimal valid 8-query eval-set (3+3 plus extras to satisfy validator).
  const queries: Array<{ query: string; should_trigger: boolean }> =
    Array.from({ length: 8 }, (_, i) => ({
      query: `${name}-q${i}`,
      should_trigger: i < 4,
    }));
  writeFileSync(join(dir, "eval-set.json"), JSON.stringify(queries), "utf8");
  return dir;
}

describe("discoverEvalSets", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-eval-sweep-disco-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns one entry per subdirectory containing eval-set.json, parsed as <plugin>:<skill>", () => {
    makeFakeEvalSetDir(root, "dev-debugging");
    makeFakeEvalSetDir(root, "investigate-investigate");
    const result = discoverEvalSets(root);
    const pluginSkills = result.map((e) => e.pluginSkill).sort();
    expect(pluginSkills).toEqual(["dev:debugging", "investigate:investigate"]);
  });

  it("skips subdirectories that have no eval-set.json", () => {
    makeFakeEvalSetDir(root, "dev-debugging");
    mkdirSync(join(root, "empty-dir"), { recursive: true });
    const result = discoverEvalSets(root);
    expect(result).toHaveLength(1);
    expect(result[0].pluginSkill).toBe("dev:debugging");
  });

  it("skips entries that are not directories (e.g. a stray SWEEP.md)", () => {
    makeFakeEvalSetDir(root, "dev-debugging");
    writeFileSync(join(root, "SWEEP.md"), "# old sweep\n", "utf8");
    const result = discoverEvalSets(root);
    expect(result).toHaveLength(1);
  });

  it("returns entries sorted by directory name for deterministic ordering", () => {
    makeFakeEvalSetDir(root, "dev-debugging");
    makeFakeEvalSetDir(root, "base-process-kill");
    makeFakeEvalSetDir(root, "investigate-investigate");
    const result = discoverEvalSets(root);
    expect(result.map((e) => e.pluginSkill)).toEqual([
      "base:process-kill",
      "dev:debugging",
      "investigate:investigate",
    ]);
  });

  it("parses dir name as <plugin>-<skill> by splitting on the FIRST hyphen (so skill names with hyphens work)", () => {
    makeFakeEvalSetDir(root, "danxbot-issue-card-workflow");
    const result = discoverEvalSets(root);
    expect(result[0].pluginSkill).toBe("danxbot:issue-card-workflow");
  });

  it("skips directories whose name has no hyphen (malformed)", () => {
    makeFakeEvalSetDir(root, "dev-debugging");
    makeFakeEvalSetDir(root, "noseparator");
    const result = discoverEvalSets(root);
    expect(result.map((e) => e.pluginSkill)).toEqual(["dev:debugging"]);
  });

  it("returns absolute path to eval-set.json + the eval-set directory", () => {
    const dir = makeFakeEvalSetDir(root, "dev-debugging");
    const result = discoverEvalSets(root);
    expect(result[0].evalSetDir).toBe(dir);
    expect(result[0].evalSetPath).toBe(join(dir, "eval-set.json"));
  });

  it("returns [] when the eval-sets dir itself does not exist (operator misconfig)", () => {
    // Covers the early-return guard in discoverEvalSets — pointing the
    // sweep at a typo'd `--eval-sets-dir` must NOT throw, just yield zero
    // entries so runAllSweepCore exits 2 with the actionable "_No
    // eval-sets discovered_" footer.
    const missing = join(root, "no-such-dir");
    expect(discoverEvalSets(missing)).toEqual([]);
  });

  it("skips directory names whose plugin or skill segment is empty after splitting", () => {
    // Names like "-leading" (idx=0 → plugin="") and "trailing-" (last
    // char hyphen → skill="") would otherwise produce a malformed
    // ":<skill>" / "<plugin>:" pluginSkill. The guard at
    // discoverEvalSets must reject both.
    makeFakeEvalSetDir(root, "-leading");
    makeFakeEvalSetDir(root, "trailing-");
    makeFakeEvalSetDir(root, "dev-debugging");
    const result = discoverEvalSets(root);
    expect(result.map((e) => e.pluginSkill)).toEqual(["dev:debugging"]);
  });
});

describe("renderSweepRollup", () => {
  it("emits a GFM table with all required columns + summary", () => {
    const entries: readonly SweepEntryResult[] = [
      {
        pluginSkill: "dev:debugging",
        evalSetDir: "/tmp/dev-debugging",
        evalSetPath: "/tmp/dev-debugging/eval-set.json",
        overallPass: true,
        train: makeSideAccuracy("train", 11, 12),
        test: makeSideAccuracy("test", 7, 8),
        runsPerQuery: 3,
        costUsd: 0.5,
        elapsedMs: 60000,
        status: "GREEN",
        reportPath: "/tmp/dev-debugging/REPORT.md",
      },
      {
        pluginSkill: "investigate:investigate",
        evalSetDir: "/tmp/investigate-investigate",
        evalSetPath: "/tmp/investigate-investigate/eval-set.json",
        overallPass: false,
        train: makeSideAccuracy("train", 9, 12),
        test: makeSideAccuracy("test", 6, 8),
        runsPerQuery: 3,
        costUsd: 0.6,
        elapsedMs: 90000,
        status: "FAIL",
        reportPath: "/tmp/investigate-investigate/REPORT.md",
      },
    ];

    const md = renderSweepRollup({
      entries,
      totalCostUsd: 1.1,
      totalElapsedMs: 150000,
      overallPass: false,
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    expect(md).toContain("# Skill-eval --all sweep");
    expect(md).toContain("**Overall: FAIL**");
    // Table header
    expect(md).toMatch(/\| Skill .* Train .* Test .* Runs.*Cost.*Elapsed.*Status \|/);
    // Per-skill rows
    expect(md).toContain("`dev:debugging`");
    expect(md).toContain("91.67%"); // 11/12
    expect(md).toContain("87.50%"); // 7/8
    expect(md).toContain("GREEN");
    expect(md).toContain("`investigate:investigate`");
    expect(md).toContain("FAIL");
    // Summary
    expect(md).toContain("Total cost: `~$1.1000`");
    expect(md).toContain("Total elapsed: `2m 30s`");
  });

  it("truncates very long error messages to 80 chars and strips pipe + newline characters (GFM safety)", () => {
    const longMsg = `${"a".repeat(70)}|with|pipes\nand\nnewlines${"a".repeat(50)}`;
    const entries: readonly SweepEntryResult[] = [
      {
        pluginSkill: "dev:testing",
        evalSetDir: "/tmp/dev-testing",
        evalSetPath: "/tmp/dev-testing/eval-set.json",
        overallPass: false,
        train: makeSideAccuracy("train", 0, 0),
        test: makeSideAccuracy("test", 0, 0),
        runsPerQuery: 0,
        costUsd: 0,
        elapsedMs: 5,
        status: "ERROR",
        errorMessage: longMsg,
      },
    ];

    const md = renderSweepRollup({
      entries,
      totalCostUsd: 0,
      totalElapsedMs: 5,
      overallPass: false,
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    // Find the data row — line index past the GFM table header + separator.
    const tableRows = md
      .split("\n")
      .filter((l) => l.startsWith("| `dev:testing"));
    expect(tableRows.length).toBe(1);
    const row = tableRows[0];
    // Each data row has exactly 8 pipes (7 cells + leading + trailing).
    expect((row.match(/\|/g) ?? []).length).toBe(8);
    // No raw newline / carriage return in the row (would break GFM).
    expect(row).not.toMatch(/[\r\n]/);
    // ERROR cell content stripped of stray pipes — only the cell-boundary pipes remain.
    const statusCell = row.split("|").at(-2)?.trim() ?? "";
    expect(statusCell.startsWith("ERROR (")).toBe(true);
    expect(statusCell).not.toMatch(/[|\r\n]/);
  });

  it("renders mixed PASS + FAIL + ERROR entries in one rollup; overallPass is false; totals aggregate", () => {
    const entries: readonly SweepEntryResult[] = [
      {
        pluginSkill: "dev:debugging",
        evalSetDir: "/tmp/dev-debugging",
        evalSetPath: "/tmp/dev-debugging/eval-set.json",
        overallPass: true,
        train: makeSideAccuracy("train", 12, 12),
        test: makeSideAccuracy("test", 8, 8),
        runsPerQuery: 3,
        costUsd: 0.5,
        elapsedMs: 60000,
        status: "GREEN",
      },
      {
        pluginSkill: "dev:testing",
        evalSetDir: "/tmp/dev-testing",
        evalSetPath: "/tmp/dev-testing/eval-set.json",
        overallPass: false,
        train: makeSideAccuracy("train", 10, 12),
        test: makeSideAccuracy("test", 6, 8),
        runsPerQuery: 3,
        costUsd: 0.4,
        elapsedMs: 70000,
        status: "FAIL",
      },
      {
        pluginSkill: "base:process-kill",
        evalSetDir: "/tmp/base-process-kill",
        evalSetPath: "/tmp/base-process-kill/eval-set.json",
        overallPass: false,
        train: makeSideAccuracy("train", 0, 0),
        test: makeSideAccuracy("test", 0, 0),
        runsPerQuery: 0,
        costUsd: 0,
        elapsedMs: 5,
        status: "ERROR",
        errorMessage: "eval-set parse failed",
      },
    ];

    const md = renderSweepRollup({
      entries,
      totalCostUsd: 0.9,
      totalElapsedMs: 130005,
      overallPass: false,
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    expect(md).toContain("**Overall: FAIL**");
    expect(md).toContain("GREEN");
    expect(md).toContain("FAIL");
    expect(md).toContain("ERROR (eval-set parse failed)");
    expect(md).toContain("Total cost: `~$0.9000`");
  });

  it("renders an ERROR row for entries that failed to load (with the error message)", () => {
    const entries: readonly SweepEntryResult[] = [
      {
        pluginSkill: "dev:testing",
        evalSetDir: "/tmp/dev-testing",
        evalSetPath: "/tmp/dev-testing/eval-set.json",
        overallPass: false,
        train: makeSideAccuracy("train", 0, 0),
        test: makeSideAccuracy("test", 0, 0),
        runsPerQuery: 0,
        costUsd: 0,
        elapsedMs: 5,
        status: "ERROR",
        errorMessage: "eval-set parse failed: unexpected token",
      },
    ];

    const md = renderSweepRollup({
      entries,
      totalCostUsd: 0,
      totalElapsedMs: 5,
      overallPass: false,
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    expect(md).toContain("ERROR");
    expect(md).toContain("eval-set parse failed");
  });

  it("marks overall PASS when every entry is GREEN", () => {
    const entries: readonly SweepEntryResult[] = [
      {
        pluginSkill: "dev:debugging",
        evalSetDir: "/tmp/dev-debugging",
        evalSetPath: "/tmp/dev-debugging/eval-set.json",
        overallPass: true,
        train: makeSideAccuracy("train", 12, 12),
        test: makeSideAccuracy("test", 8, 8),
        runsPerQuery: 3,
        costUsd: 0.5,
        elapsedMs: 60000,
        status: "GREEN",
      },
    ];

    const md = renderSweepRollup({
      entries,
      totalCostUsd: 0.5,
      totalElapsedMs: 60000,
      overallPass: true,
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    expect(md).toContain("**Overall: PASS**");
  });

  it("includes the last-run ISO timestamp", () => {
    const md = renderSweepRollup({
      entries: [],
      totalCostUsd: 0,
      totalElapsedMs: 0,
      overallPass: false,
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });
    expect(md).toContain("2026-05-12T05:45:00.000Z");
  });
});

describe("runAllSweepCore", () => {
  let root: string;
  let evalSetsDir: string;

  function baseArgs(): RunAllSweepArgs {
    return {
      evalSetsDir,
      repoRoot: "/fake/repo",
      workspace: "skill-eval",
      workerPort: 5563,
      repoName: "danxbot",
      workspaceCwd: "/fake/workspace",
      timeoutMs: 60000,
      pollIntervalMs: 1000,
      parallel: 3,
      seed: 1,
      runsPerQuery: 3,
      pricingModel: "claude-sonnet-4-6",
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-eval-sweep-core-"));
    evalSetsDir = join(root, "tests", "skill-evals");
    mkdirSync(evalSetsDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs each entry sequentially (NOT parallel)", async () => {
    makeFakeEvalSetDir(evalSetsDir, "dev-debugging");
    makeFakeEvalSetDir(evalSetsDir, "investigate-investigate");

    const observedStartOrder: string[] = [];
    const inFlight = new Set<string>();
    let maxConcurrent = 0;

    const runOneImpl: SweepRunOneFn = async (args) => {
      observedStartOrder.push(args.pluginSkill);
      inFlight.add(args.pluginSkill);
      maxConcurrent = Math.max(maxConcurrent, inFlight.size);
      await new Promise((r) => setTimeout(r, 5));
      inFlight.delete(args.pluginSkill);
      return {
        overallPass: true,
        exitCode: 0 as const,
        markdown: `# Skill-eval report: ${args.pluginSkill}\n`,
        totalCostUsd: 0.2,
        trainVerdicts: [],
        testVerdicts: [],
      };
    };
    const runOne: SweepRunOneFn = vi.fn(runOneImpl);

    await runAllSweepCore(baseArgs(), {
      runOne,
      writeReport: () => ({ path: "/fake/REPORT.md", bytesWritten: 0 }),
      writeSweepMarkdown: () => "/fake/SWEEP.md",
      now: () => 0,
    });

    expect(maxConcurrent).toBe(1);
    expect(observedStartOrder).toEqual([
      "dev:debugging",
      "investigate:investigate",
    ]);
  });

  it("writes REPORT.md per-skill via the injected writer", async () => {
    makeFakeEvalSetDir(evalSetsDir, "dev-debugging");
    makeFakeEvalSetDir(evalSetsDir, "investigate-investigate");

    const writeReportCalls: Array<{ evalSetPath: string; markdown: string }> = [];
    const runOne: SweepRunOneFn = async (args) => ({
      overallPass: true,
      exitCode: 0,
      markdown: `# Skill-eval report: ${args.pluginSkill}\n`,
      totalCostUsd: 0.1,
      trainVerdicts: [],
      testVerdicts: [],
    });

    await runAllSweepCore(baseArgs(), {
      runOne,
      writeReport: (a) => {
        writeReportCalls.push({ evalSetPath: a.evalSetPath, markdown: a.markdown });
        return { path: `${a.evalSetPath}.REPORT`, bytesWritten: a.markdown.length };
      },
      writeSweepMarkdown: () => "/fake/SWEEP.md",
      now: () => 0,
    });

    expect(writeReportCalls).toHaveLength(2);
    expect(writeReportCalls[0].markdown).toContain("dev:debugging");
    expect(writeReportCalls[1].markdown).toContain("investigate:investigate");
  });

  it("writes SWEEP.md aggregating all entries", async () => {
    makeFakeEvalSetDir(evalSetsDir, "dev-debugging");
    const runOne: SweepRunOneFn = async () => ({
      overallPass: true,
      exitCode: 0,
      markdown: "# x\n",
      totalCostUsd: 0.5,
      trainVerdicts: [],
      testVerdicts: [],
    });

    let sweepMd = "";
    let sweepPath = "";
    await runAllSweepCore(baseArgs(), {
      runOne,
      writeReport: () => ({ path: "/fake/REPORT.md", bytesWritten: 0 }),
      writeSweepMarkdown: (path, md) => {
        sweepPath = path;
        sweepMd = md;
        return path;
      },
      now: () => 0,
    });

    expect(sweepPath).toBe(join(evalSetsDir, "SWEEP.md"));
    expect(sweepMd).toContain("# Skill-eval --all sweep");
    expect(sweepMd).toContain("dev:debugging");
  });

  it("returns exit code 0 when every entry passed", async () => {
    makeFakeEvalSetDir(evalSetsDir, "dev-debugging");
    const runOne: SweepRunOneFn = async () => ({
      overallPass: true,
      exitCode: 0,
      markdown: "# x\n",
      totalCostUsd: 0.5,
      trainVerdicts: [],
      testVerdicts: [],
    });

    const result = await runAllSweepCore(baseArgs(), {
      runOne,
      writeReport: () => ({ path: "/fake/REPORT.md", bytesWritten: 0 }),
      writeSweepMarkdown: () => "/fake/SWEEP.md",
      now: () => 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.overallPass).toBe(true);
  });

  it("returns exit code 1 when any entry failed", async () => {
    makeFakeEvalSetDir(evalSetsDir, "dev-debugging");
    makeFakeEvalSetDir(evalSetsDir, "investigate-investigate");
    const runOne: SweepRunOneFn = async (args) => ({
      overallPass: args.pluginSkill === "dev:debugging",
      exitCode: args.pluginSkill === "dev:debugging" ? 0 : 1,
      markdown: "# x\n",
      totalCostUsd: 0.5,
      trainVerdicts: [],
      testVerdicts: [],
    });

    const result = await runAllSweepCore(baseArgs(), {
      runOne,
      writeReport: () => ({ path: "/fake/REPORT.md", bytesWritten: 0 }),
      writeSweepMarkdown: () => "/fake/SWEEP.md",
      now: () => 0,
    });

    expect(result.exitCode).toBe(1);
    expect(result.overallPass).toBe(false);
  });

  it("returns exit code 2 when no eval-sets are discovered, does NOT emit SWEEP.md", async () => {
    // evalSetsDir is empty. SWEEP.md must NOT land in the (possibly
    // operator-unauthored) target dir — empty discovery is a misconfig
    // signal, not a result worth persisting.
    const runOne: SweepRunOneFn = vi.fn(async () => {
      throw new Error("should not be invoked");
    });
    const writeSweepMarkdown = vi.fn(() => "/fake/SWEEP.md");
    const result = await runAllSweepCore(baseArgs(), {
      runOne,
      writeReport: () => ({ path: "/fake/REPORT.md", bytesWritten: 0 }),
      writeSweepMarkdown,
      now: () => 0,
    });

    expect(result.exitCode).toBe(2);
    expect(result.entries).toHaveLength(0);
    expect(runOne).not.toHaveBeenCalled();
    expect(writeSweepMarkdown).not.toHaveBeenCalled();
    expect(result.sweepReportPath).toBeUndefined();
    // The rollup markdown still gets rendered so the CLI can announce
    // "_No eval-sets discovered_" to stdout — verify the hint is present.
    expect(result.rollupMarkdown).toContain("No eval-sets discovered");
  });

  it("records an ERROR entry when an eval-set throws — does NOT abort sweep", async () => {
    makeFakeEvalSetDir(evalSetsDir, "dev-debugging");
    makeFakeEvalSetDir(evalSetsDir, "broken-skill");

    const runOne: SweepRunOneFn = async (args) => {
      if (args.pluginSkill === "broken:skill") {
        throw new Error("eval-set parse failed: bad json");
      }
      return {
        overallPass: true,
        exitCode: 0,
        markdown: "# x\n",
        totalCostUsd: 0.5,
        trainVerdicts: [],
        testVerdicts: [],
      };
    };

    const result = await runAllSweepCore(baseArgs(), {
      runOne,
      writeReport: () => ({ path: "/fake/REPORT.md", bytesWritten: 0 }),
      writeSweepMarkdown: () => "/fake/SWEEP.md",
      now: () => 0,
    });

    expect(result.entries).toHaveLength(2);
    const errorEntry = result.entries.find((e) => e.pluginSkill === "broken:skill");
    expect(errorEntry?.status).toBe("ERROR");
    expect(errorEntry?.errorMessage).toContain("eval-set parse failed");
    expect(result.overallPass).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("aggregates total cost across all entries", async () => {
    makeFakeEvalSetDir(evalSetsDir, "dev-debugging");
    makeFakeEvalSetDir(evalSetsDir, "investigate-investigate");
    const runOne: SweepRunOneFn = async () => ({
      overallPass: true,
      exitCode: 0,
      markdown: "# x\n",
      totalCostUsd: 0.42,
      trainVerdicts: [],
      testVerdicts: [],
    });

    const result = await runAllSweepCore(baseArgs(), {
      runOne,
      writeReport: () => ({ path: "/fake/REPORT.md", bytesWritten: 0 }),
      writeSweepMarkdown: () => "/fake/SWEEP.md",
      now: () => 0,
    });

    expect(result.totalCostUsd).toBeCloseTo(0.84, 6);
  });

  it("measures wall-clock elapsedMs per entry + total via the injected clock", async () => {
    makeFakeEvalSetDir(evalSetsDir, "dev-debugging");

    let n = 0;
    const now = (): number => {
      n += 1;
      // 0 = sweep start, 1 = entry start, 2 = entry end, 3 = sweep end.
      return [0, 1000, 4000, 5000][n - 1] ?? 5000;
    };

    const runOne: SweepRunOneFn = async () => ({
      overallPass: true,
      exitCode: 0,
      markdown: "# x\n",
      totalCostUsd: 0,
      trainVerdicts: [],
      testVerdicts: [],
    });

    const result = await runAllSweepCore(baseArgs(), {
      runOne,
      writeReport: () => ({ path: "/fake/REPORT.md", bytesWritten: 0 }),
      writeSweepMarkdown: () => "/fake/SWEEP.md",
      now,
    });

    expect(result.entries[0].elapsedMs).toBe(3000); // 4000 - 1000
    expect(result.totalElapsedMs).toBe(5000); // 5000 - 0
  });

  it("forwards per-run flags (parallel, seed, runsPerQuery, pricingModel) into each runOne call", async () => {
    makeFakeEvalSetDir(evalSetsDir, "dev-debugging");
    const captured: EvalQuery[] = [];
    let argsSeen: { parallel: number; seed: number; runsPerQuery: number; pricingModel: string } | null = null;

    const runOne: SweepRunOneFn = async (a, queries) => {
      argsSeen = {
        parallel: a.parallel,
        seed: a.seed,
        runsPerQuery: a.runsPerQuery,
        pricingModel: a.pricingModel,
      };
      for (const q of queries) captured.push(q);
      return {
        overallPass: true,
        exitCode: 0,
        markdown: "# x\n",
        totalCostUsd: 0,
        trainVerdicts: [],
        testVerdicts: [],
      };
    };

    const args: RunAllSweepArgs = {
      ...baseArgs(),
      parallel: 2,
      seed: 42,
      runsPerQuery: 5,
      pricingModel: "claude-opus-4-7",
    };

    await runAllSweepCore(args, {
      runOne,
      writeReport: () => ({ path: "/fake/REPORT.md", bytesWritten: 0 }),
      writeSweepMarkdown: () => "/fake/SWEEP.md",
      now: () => 0,
    });

    expect(argsSeen).toEqual({
      parallel: 2,
      seed: 42,
      runsPerQuery: 5,
      pricingModel: "claude-opus-4-7",
    });
    expect(captured.length).toBe(8); // 8 queries in the fake eval-set
  });
});

describe("parseSweepArgs", () => {
  const baseEnv = { DANXBOT_WORKER_PORT: "5563", DANXBOT_REPO_ROOT: "/fake/repo" } as NodeJS.ProcessEnv;

  it("defaults evalSetsDir to <repoRoot>/tests/skill-evals", () => {
    const args = parseSweepArgs([], baseEnv);
    expect(args.evalSetsDir).toBe(join("/fake/repo", "tests", "skill-evals"));
  });

  it("honors --eval-sets-dir override", () => {
    const args = parseSweepArgs(
      ["--eval-sets-dir", "/custom/path"],
      baseEnv,
    );
    expect(args.evalSetsDir).toBe("/custom/path");
  });

  it("rejects missing worker port", () => {
    expect(() => parseSweepArgs([], { DANXBOT_REPO_ROOT: "/fake/repo" })).toThrow(
      RunAllSweepArgsError,
    );
  });

  it("rejects missing repo root", () => {
    expect(() => parseSweepArgs([], { DANXBOT_WORKER_PORT: "5563" })).toThrow(
      RunAllSweepArgsError,
    );
  });

  it("forwards seed / runs-per-query / parallel overrides", () => {
    const args = parseSweepArgs(
      ["--seed", "42", "--runs-per-query", "5", "--parallel", "2"],
      baseEnv,
    );
    expect(args.seed).toBe(42);
    expect(args.runsPerQuery).toBe(5);
    expect(args.parallel).toBe(2);
  });
});
