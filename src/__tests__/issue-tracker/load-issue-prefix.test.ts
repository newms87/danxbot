/**
 * Direct unit test for the leaf prefix-loader module.
 *
 * Phase 2 of DX-99 lifted `loadIssuePrefix` out of `src/repo-context.ts`
 * specifically so leaf consumers (the dashboard reader) could import it
 * without transitively pulling `src/config.ts`'s required-env-var
 * checks. Phase 4 of DX-99 retired the warn-once-default fallback —
 * every absent / unreadable / malformed branch now throws fail-loud.
 *
 * The mock against `node:fs` lives at module-top so every consumer in
 * this test file resolves the same fixture filesystem.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadIssuePrefix } from "../../issue-tracker/load-issue-prefix.js";

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
  existsSync.mockReset();
  readFileSync.mockReset();
});

describe("load-issue-prefix.ts (leaf module)", () => {
  it("returns the prefix verbatim when config.yml has issue_prefix: DX", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("issue_prefix: DX\n");
    expect(loadIssuePrefix("/repo/danxbot")).toBe("DX");
  });

  it("throws when config.yml is absent", () => {
    existsSync.mockReturnValue(false);
    expect(() => loadIssuePrefix("/repo/missing")).toThrow(
      /not found; cannot resolve issue_prefix/,
    );
  });

  it("throws when issue_prefix field is empty / absent", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("name: thing\n");
    expect(() => loadIssuePrefix("/repo/empty")).toThrow(
      /missing required field issue_prefix/,
    );
  });

  it("throws when readFileSync errors (unreadable file)", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    expect(() => loadIssuePrefix("/repo/locked")).toThrow(
      /Failed to read.*EACCES/,
    );
  });

  it("throws on shape mismatch", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('issue_prefix: "bad-shape"\n');
    expect(() => loadIssuePrefix("/repo/bad")).toThrow(
      /Invalid issue_prefix.*must match.*2-4 uppercase ASCII letters/,
    );
  });
});
