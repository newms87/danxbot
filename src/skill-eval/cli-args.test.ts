import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARALLEL,
  DEFAULT_PRICING_MODEL,
  DEFAULT_RUNS_PER_QUERY,
  DEFAULT_SEED,
  DEFAULT_TIMEOUT_MS,
  isInvokedAsScript,
  parseCommonRunFlags,
  parseNonNegativeInt,
  parsePositiveInt,
  pickArg,
  validateKnownFlags,
} from "./cli-args.js";

class TestErr extends Error {}

describe("pickArg", () => {
  it("returns the value when --flag is followed by its value", () => {
    expect(pickArg(["--seed", "42"], "seed")).toBe("42");
  });
  it("returns the value for --flag=value form", () => {
    expect(pickArg(["--seed=42"], "seed")).toBe("42");
  });
  it("returns null when the flag is absent", () => {
    expect(pickArg([], "seed")).toBe(null);
  });
});

describe("parsePositiveInt", () => {
  it("accepts a positive integer", () => {
    expect(parsePositiveInt("seed", "5")).toBe(5);
  });
  it("rejects zero", () => {
    expect(() => parsePositiveInt("seed", "0", TestErr)).toThrow(TestErr);
  });
  it("rejects negative", () => {
    expect(() => parsePositiveInt("seed", "-1", TestErr)).toThrow(TestErr);
  });
  it("rejects trailing non-digits (5abc)", () => {
    expect(() => parsePositiveInt("seed", "5abc", TestErr)).toThrow(TestErr);
  });
});

describe("parseNonNegativeInt", () => {
  it("accepts zero", () => {
    expect(parseNonNegativeInt("seed", "0")).toBe(0);
  });
  it("rejects negative", () => {
    expect(() => parseNonNegativeInt("seed", "-1", TestErr)).toThrow(TestErr);
  });
});

describe("parseCommonRunFlags", () => {
  const baseEnv = {
    DANXBOT_REPO_ROOT: "/fake/repo",
  } as NodeJS.ProcessEnv;

  it("returns defaults for every optional flag", () => {
    const r = parseCommonRunFlags([], baseEnv, TestErr);
    expect(r.repoRoot).toBe("/fake/repo");
    expect(r.workspace).toBe("skill-eval");
    expect(r.workspaceCwd).toBe(
      resolve("/fake/repo", ".danxbot", "workspaces", "skill-eval"),
    );
    expect(r.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(r.parallel).toBe(DEFAULT_PARALLEL);
    expect(r.runsPerQuery).toBe(DEFAULT_RUNS_PER_QUERY);
    expect(r.seed).toBe(DEFAULT_SEED);
    expect(r.pricingModel).toBe(DEFAULT_PRICING_MODEL);
  });

  it("honors --repo-root override", () => {
    const r = parseCommonRunFlags(
      ["--repo-root", "/different/repo"],
      baseEnv,
      TestErr,
    );
    expect(r.repoRoot).toBe("/different/repo");
    expect(r.workspaceCwd).toBe(
      resolve("/different/repo", ".danxbot", "workspaces", "skill-eval"),
    );
  });

  it("honors --workspace + --workspace-cwd overrides", () => {
    const r = parseCommonRunFlags(
      ["--workspace", "issue-worker", "--workspace-cwd", "/custom/cwd"],
      baseEnv,
      TestErr,
    );
    expect(r.workspace).toBe("issue-worker");
    expect(r.workspaceCwd).toBe("/custom/cwd");
  });

  it("honors all numeric flag overrides", () => {
    const r = parseCommonRunFlags(
      [
        "--parallel",
        "7",
        "--runs-per-query",
        "5",
        "--seed",
        "0",
        "--timeout-ms",
        "30000",
        "--pricing-model",
        "claude-opus-4-7",
      ],
      baseEnv,
      TestErr,
    );
    expect(r.parallel).toBe(7);
    expect(r.runsPerQuery).toBe(5);
    expect(r.seed).toBe(0);
    expect(r.timeoutMs).toBe(30000);
    expect(r.pricingModel).toBe("claude-opus-4-7");
  });

  it("throws caller's ErrorCtor when --repo-root + env missing", () => {
    expect(() => parseCommonRunFlags([], {}, TestErr)).toThrow(TestErr);
  });

  it("throws caller's ErrorCtor when --parallel is zero", () => {
    expect(() =>
      parseCommonRunFlags(["--parallel", "0"], baseEnv, TestErr),
    ).toThrow(TestErr);
  });

  it("propagates ErrorCtor to inner parsePositiveInt / parseNonNegativeInt", () => {
    expect(() =>
      parseCommonRunFlags(["--seed", "-1"], baseEnv, TestErr),
    ).toThrow(TestErr);
  });
});

describe("validateKnownFlags", () => {
  const KNOWN = ["seed", "parallel", "workspace", "pricing-model"] as const;

  it("accepts every flag in the allowlist (space form)", () => {
    expect(() =>
      validateKnownFlags(
        ["--seed", "1", "--parallel", "3", "--workspace", "skill-eval"],
        KNOWN,
        TestErr,
      ),
    ).not.toThrow();
  });

  it("accepts every flag in the allowlist (= form)", () => {
    expect(() =>
      validateKnownFlags(
        ["--seed=1", "--parallel=3", "--workspace=skill-eval"],
        KNOWN,
        TestErr,
      ),
    ).not.toThrow();
  });

  it("ignores positional args (anything not starting with --)", () => {
    expect(() =>
      validateKnownFlags(
        ["dev:debugging", "--seed", "1"],
        KNOWN,
        TestErr,
      ),
    ).not.toThrow();
  });

  it("rejects an unknown long flag (typo for an existing one)", () => {
    expect(() =>
      validateKnownFlags(["--eval-set-dir", "/tmp"], KNOWN, TestErr),
    ).toThrow(TestErr);
  });

  it("error message names the offending flag verbatim", () => {
    expect(() =>
      validateKnownFlags(["--eval-set-dir", "/tmp"], KNOWN, TestErr),
    ).toThrow(/--eval-set-dir/);
  });

  it("error message lists the accepted flags alphabetically (so operator sees the candidates)", () => {
    try {
      validateKnownFlags(["--bogus"], KNOWN, TestErr);
      throw new Error("should not reach");
    } catch (e) {
      expect((e as Error).message).toMatch(
        /--parallel, --pricing-model, --seed, --workspace/,
      );
    }
  });

  it("does NOT mistake a flag's value for an unknown flag (-- prefix on the value)", () => {
    // `--pricing-model --strict-foo` would NOT parse `--strict-foo` as
    // a value (it starts with `--`), so the validator should still
    // catch it as an unknown flag.
    expect(() =>
      validateKnownFlags(["--pricing-model", "--strict-foo"], KNOWN, TestErr),
    ).toThrow(/--strict-foo/);
  });
});

describe("isInvokedAsScript", () => {
  it("returns true for an exact end-of-path .ts match", () => {
    expect(isInvokedAsScript("run-all-sweep", "/path/to/run-all-sweep.ts")).toBe(
      true,
    );
  });

  it("returns true for an exact end-of-path .js match", () => {
    expect(isInvokedAsScript("run-all-sweep", "/path/to/run-all-sweep.js")).toBe(
      true,
    );
  });

  it("returns false when the basename has a leading prefix (false-positive guard)", () => {
    expect(isInvokedAsScript("run-all-sweep", "/path/to/notrun-all-sweep.ts")).toBe(
      false,
    );
  });

  it("returns false for a .ts.bak / unrelated suffix", () => {
    expect(isInvokedAsScript("run-all-sweep", "/path/to/run-all-sweep.ts.bak")).toBe(
      false,
    );
  });

  it("returns false when argv1 is undefined", () => {
    expect(isInvokedAsScript("run-all-sweep", undefined)).toBe(false);
  });

  it("returns true for a bare basename with no leading path", () => {
    expect(isInvokedAsScript("run-all-sweep", "run-all-sweep.ts")).toBe(true);
  });

  it("escapes regex metacharacters in scriptBaseName", () => {
    // Hypothetical script with a `.` in its base name — the helper should
    // NOT interpret the dot as a regex wildcard.
    expect(isInvokedAsScript("foo.bar", "/p/foo.bar.ts")).toBe(true);
    expect(isInvokedAsScript("foo.bar", "/p/fooxbar.ts")).toBe(false);
  });
});
