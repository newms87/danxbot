import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * DX-343 AC #3 — repo-level guard for "no `MemoryTracker` in
 * production code." The class is preserved as a TEST-ONLY stub at
 * `src/issue-tracker/__test__-memory.ts`; production code MUST NOT
 * import from it. Phase 4 (DX-345) deletes the stub entirely once
 * the test suite migrates to a dedicated FakeTracker.
 *
 * Two checks per file under `src/`:
 *
 *   1. The bare identifier `\bMemoryTracker\b` must not appear in
 *      any non-test file (docstrings, code, comments — all forbidden
 *      so the comment scrub doesn't rot back).
 *   2. The module specifier `issue-tracker/__test__-memory` must not
 *      appear in any non-test import — the `__test__-` filename
 *      prefix is the contract; this assertion makes the contract
 *      load-bearing.
 *
 * Mirrors the `dashboard/src/__tests__/no-poll-imports.test.ts`
 * pattern: the previous AC was enforced only by reviewer discipline
 * + a manual `grep`. Converting it to a vitest-time invariant means
 * the next regression fails the build instead of slipping past.
 */

const SRC_ROOT = resolve(__dirname, "..", "..");

// Files allowed to mention `MemoryTracker`. The set is exhaustive:
//   - The stub itself (the symbol it declares).
//   - This file (carries the literal string in its own assertions).
const SYMBOL_EXEMPT_FILES = new Set<string>([
  join("issue-tracker", "__test__-memory.ts"),
  join("__tests__", "issue-tracker", "no-memory-tracker-in-production.test.ts"),
]);

const SYMBOL_RE = /\bMemoryTracker\b/;
const STUB_IMPORT_RE = /issue-tracker\/__test__-memory(?:\.js)?["']/;

function* walkSrc(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkSrc(full);
    } else if (full.endsWith(".ts")) {
      yield full;
    }
  }
}

function isProductionFile(absPath: string): boolean {
  // Treat any file whose name OR ancestor segment marks it test-only
  // as exempt: `*.test.ts`, anything under a `__tests__/` dir, the
  // `__test__-` filename prefix.
  const segments = absPath.split(sep);
  if (segments.some((s) => s === "__tests__")) return false;
  const filename = segments[segments.length - 1];
  if (filename.endsWith(".test.ts")) return false;
  if (filename.startsWith("__test__-")) return false;
  return true;
}

describe("no-MemoryTracker-in-production sweep", () => {
  it("no production .ts file mentions the bare `MemoryTracker` identifier", () => {
    const violations: string[] = [];
    for (const absPath of walkSrc(SRC_ROOT)) {
      const relPath = absPath.slice(SRC_ROOT.length + 1);
      if (SYMBOL_EXEMPT_FILES.has(relPath)) continue;
      if (!isProductionFile(absPath)) continue;
      const content = readFileSync(absPath, "utf-8");
      if (SYMBOL_RE.test(content)) {
        violations.push(relPath);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no production .ts file imports from `issue-tracker/__test__-memory`", () => {
    const violations: string[] = [];
    for (const absPath of walkSrc(SRC_ROOT)) {
      const relPath = absPath.slice(SRC_ROOT.length + 1);
      if (!isProductionFile(absPath)) continue;
      const content = readFileSync(absPath, "utf-8");
      if (STUB_IMPORT_RE.test(content)) {
        violations.push(relPath);
      }
    }
    expect(violations).toEqual([]);
  });
});
