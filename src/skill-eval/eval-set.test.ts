import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EvalSetError,
  loadEvalSet,
  resolveEvalSetPath,
  validateEvalSet,
} from "./eval-set.js";

describe("validateEvalSet", () => {
  it("accepts a well-formed 20-query 10/10 eval-set", () => {
    const queries = Array.from({ length: 20 }, (_, i) => ({
      query: `q${i}`,
      should_trigger: i < 10,
    }));
    const result = validateEvalSet(queries);
    expect(result.length).toBe(20);
    expect(result.filter((q) => q.shouldTrigger).length).toBe(10);
    expect(result.filter((q) => !q.shouldTrigger).length).toBe(10);
  });

  it("normalizes the wire `should_trigger` to in-memory `shouldTrigger`", () => {
    const queries = Array.from({ length: 16 }, (_, i) => ({
      query: `q${i}`,
      should_trigger: i < 8,
    }));
    const result = validateEvalSet(queries);
    // Pin the rename — wire field is snake_case, in-memory is camelCase.
    expect(Object.keys(result[0])).toEqual(["query", "shouldTrigger"]);
  });

  it("rejects non-array top-level shape", () => {
    expect(() => validateEvalSet({ queries: [] })).toThrow(EvalSetError);
    expect(() => validateEvalSet("string")).toThrow(EvalSetError);
    expect(() => validateEvalSet(null)).toThrow(EvalSetError);
  });

  it("rejects a query entry that is not an object", () => {
    expect(() => validateEvalSet(["str", "str"])).toThrow(/object/);
  });

  it("rejects an entry missing `query`", () => {
    expect(() =>
      validateEvalSet([{ should_trigger: true } as unknown]),
    ).toThrow(/query/);
  });

  it("rejects an entry with an empty `query` string", () => {
    expect(() =>
      validateEvalSet([{ query: "", should_trigger: true }]),
    ).toThrow(/empty/);
  });

  it("rejects an entry whose `query` is not a string", () => {
    expect(() =>
      validateEvalSet([{ query: 42, should_trigger: true } as unknown]),
    ).toThrow(/string/);
  });

  it("rejects an entry whose `should_trigger` is not a boolean", () => {
    expect(() =>
      validateEvalSet([
        { query: "q", should_trigger: "yes" } as unknown,
      ]),
    ).toThrow(/boolean/);
  });

  it("rejects an empty array", () => {
    expect(() => validateEvalSet([])).toThrow(/at least/);
  });

  it("rejects a too-small set (fewer than 8 queries total)", () => {
    const queries = Array.from({ length: 6 }, (_, i) => ({
      query: `q${i}`,
      should_trigger: i < 3,
    }));
    expect(() => validateEvalSet(queries)).toThrow(/at least 8/);
  });

  it("rejects a set with zero positives (no should_trigger=true)", () => {
    const queries = Array.from({ length: 12 }, (_, i) => ({
      query: `q${i}`,
      should_trigger: false,
    }));
    expect(() => validateEvalSet(queries)).toThrow(/positive/);
  });

  it("rejects a set with zero negatives (no should_trigger=false)", () => {
    const queries = Array.from({ length: 12 }, (_, i) => ({
      query: `q${i}`,
      should_trigger: true,
    }));
    expect(() => validateEvalSet(queries)).toThrow(/negative/);
  });

  it("rejects a set with only 2 negatives (below the 3-per-side floor)", () => {
    // 6 positives + 2 negatives — total 8 passes MIN_TOTAL but the
    // negative side is too thin to give a non-trivial precision signal.
    const queries = [
      ...Array.from({ length: 6 }, (_, i) => ({
        query: `pos${i}`,
        should_trigger: true,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        query: `neg${i}`,
        should_trigger: false,
      })),
    ];
    expect(() => validateEvalSet(queries)).toThrow(/at least 3 negative/);
  });

  it("surfaces a per-entry shape error BEFORE a too-small-set error when both apply", () => {
    // 3 entries: #0 well-formed, #1 has a non-string query, #2
    // well-formed. The total is below MIN_TOTAL (8) AND entry #1 is
    // malformed. The validator must surface the per-entry shape error
    // first so the operator gets actionable feedback (fix #1) rather
    // than being told "your set is too small" when the more pressing
    // issue is a typed-wrong entry.
    expect(() =>
      validateEvalSet([
        { query: "a", should_trigger: true },
        { query: 42, should_trigger: false },
        { query: "c", should_trigger: true },
      ]),
    ).toThrow(/entry #1/);
  });

  it("accepts a small but balanced 8/8 eval-set (minimum allowed)", () => {
    const queries = Array.from({ length: 16 }, (_, i) => ({
      query: `q${i}`,
      should_trigger: i < 8,
    }));
    expect(validateEvalSet(queries).length).toBe(16);
  });

  it("rejects duplicate `query` strings (would skew train/test split)", () => {
    const queries = [
      { query: "same", should_trigger: true },
      { query: "same", should_trigger: false },
      { query: "x", should_trigger: true },
      { query: "y", should_trigger: false },
      { query: "z", should_trigger: true },
      { query: "w", should_trigger: false },
      { query: "v", should_trigger: true },
      { query: "u", should_trigger: false },
    ];
    expect(() => validateEvalSet(queries)).toThrow(/duplicate/i);
  });
});

describe("resolveEvalSetPath", () => {
  it("maps `dev:debugging` to tests/skill-evals/dev-debugging/eval-set.json", () => {
    expect(resolveEvalSetPath("/repo", "dev:debugging")).toBe(
      "/repo/tests/skill-evals/dev-debugging/eval-set.json",
    );
  });

  it("maps `base:tool-discipline` (hyphenated skill) by collapsing the colon to a hyphen", () => {
    expect(resolveEvalSetPath("/repo", "base:tool-discipline")).toBe(
      "/repo/tests/skill-evals/base-tool-discipline/eval-set.json",
    );
  });

  it("rejects a missing colon (not <plugin>:<skill> form)", () => {
    expect(() => resolveEvalSetPath("/repo", "dev-debugging")).toThrow(
      EvalSetError,
    );
  });

  it("rejects an empty plugin or skill segment", () => {
    expect(() => resolveEvalSetPath("/repo", ":debugging")).toThrow(
      EvalSetError,
    );
    expect(() => resolveEvalSetPath("/repo", "dev:")).toThrow(EvalSetError);
  });

  it("splits on FIRST colon only — multi-colon plugin names keep the remainder as the skill segment", () => {
    // Pin the intentional indexOf-first-colon behavior so a future
    // refactor to `split(":")` (which would over-eagerly split) doesn't
    // silently break multi-colon plugin name support.
    expect(resolveEvalSetPath("/repo", "org:plugin:skill")).toBe(
      "/repo/tests/skill-evals/org-plugin:skill/eval-set.json",
    );
  });
});

describe("loadEvalSet — committed fixture", () => {
  it("the committed dev-debugging eval-set is a valid 10/10 set", () => {
    // Loads the actual on-disk JSON committed under tests/skill-evals/
    // through the same validator that production uses. A typo in the
    // committed eval-set would fail this test instead of waiting until
    // a real paid sweep tries to load it. Free safety net.
    const path = resolveEvalSetPath(process.cwd(), "dev:debugging");
    const queries = loadEvalSet(path);
    expect(queries.length).toBe(20);
    expect(queries.filter((q) => q.shouldTrigger).length).toBe(10);
    expect(queries.filter((q) => !q.shouldTrigger).length).toBe(10);
    // No duplicate prompts (validator already enforces this — assert
    // explicitly so a future relaxation of the validator doesn't slip
    // through).
    expect(new Set(queries.map((q) => q.query)).size).toBe(20);
  });
});

describe("loadEvalSet", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eval-set-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads + validates a JSON file end-to-end", () => {
    const file = join(tmpDir, "eval-set.json");
    const queries = Array.from({ length: 16 }, (_, i) => ({
      query: `q${i}`,
      should_trigger: i < 8,
    }));
    writeFileSync(file, JSON.stringify(queries));
    const result = loadEvalSet(file);
    expect(result.length).toBe(16);
  });

  it("wraps a parse failure in EvalSetError with the file path", () => {
    const file = join(tmpDir, "broken.json");
    writeFileSync(file, "not valid json");
    expect(() => loadEvalSet(file)).toThrow(EvalSetError);
    try {
      loadEvalSet(file);
    } catch (err) {
      // Path should be mentioned so the operator can grep their filesystem.
      expect((err as Error).message).toContain(file);
    }
  });

  it("wraps a missing file in EvalSetError with the file path", () => {
    const file = join(tmpDir, "missing.json");
    expect(() => loadEvalSet(file)).toThrow(EvalSetError);
    try {
      loadEvalSet(file);
    } catch (err) {
      expect((err as Error).message).toContain(file);
    }
  });
});
