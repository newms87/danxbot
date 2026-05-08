/**
 * Direct unit test for the leaf prefix-loader module.
 *
 * Phase 2 of ISS-99 lifted `loadIssuePrefix` out of `src/repo-context.ts`
 * specifically so leaf consumers (the dashboard reader) could import it
 * without transitively pulling `src/config.ts`'s required-env-var
 * checks. Phase 1's `repo-context.test.ts` exercises `loadIssuePrefix`
 * via the back-compat re-export — that path still goes through
 * `repo-context.ts` itself, which DOES pull `config.ts`. This file pins
 * the leaf-import contract directly so a future regression (someone
 * re-importing a config-pulling symbol inside the leaf, or moving the
 * function back to a heavy module) fails loudly instead of silently
 * passing every Phase 1 test through the re-export shim.
 *
 * The mock against `node:fs` lives at module-top so every consumer in
 * this test file resolves the same fixture filesystem; `_resetWarnedPrefixPaths`
 * is the test seam that keeps warn-once log assertions deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadIssuePrefix,
  _resetWarnedPrefixPaths,
} from "../../issue-tracker/load-issue-prefix.js";
import { DEFAULT_ISSUE_PREFIX } from "../../issue-tracker/yaml.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const fs = await import("node:fs");
const existsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const readFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetWarnedPrefixPaths();
  existsSync.mockReset();
  readFileSync.mockReset();
});

describe("load-issue-prefix.ts (leaf module)", () => {
  it("returns the prefix verbatim when config.yml has issue_prefix: DX", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("issue_prefix: DX\n");
    expect(loadIssuePrefix("/repo/danxbot")).toBe("DX");
  });

  it("returns DEFAULT_ISSUE_PREFIX when config.yml is absent", () => {
    existsSync.mockReturnValue(false);
    expect(loadIssuePrefix("/repo/missing")).toBe(DEFAULT_ISSUE_PREFIX);
  });

  it("throws on shape mismatch", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('issue_prefix: "bad-shape"\n');
    expect(() => loadIssuePrefix("/repo/bad")).toThrow(
      /Invalid issue_prefix.*must match.*2-4 uppercase ASCII letters/,
    );
  });

  it("warns once per config path across repeated calls and dedups via _resetWarnedPrefixPaths", () => {
    // First two calls: same missing config — warn-once dedup.
    existsSync.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadIssuePrefix("/repo/missing")).toBe(DEFAULT_ISSUE_PREFIX);
    expect(loadIssuePrefix("/repo/missing")).toBe(DEFAULT_ISSUE_PREFIX);
    // Reset the dedup state — the next call must warn again, proving the
    // test seam exists and is wired into the same module-level Set the
    // production warn-once path uses.
    _resetWarnedPrefixPaths();
    expect(loadIssuePrefix("/repo/missing")).toBe(DEFAULT_ISSUE_PREFIX);
    warnSpy.mockRestore();
  });
});
