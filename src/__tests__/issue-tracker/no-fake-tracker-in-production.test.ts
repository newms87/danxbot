import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * DX-345 AC #6 — repo-level guard for "no `FakeTracker` in
 * production code." The class lives at
 * `src/__tests__/helpers/FakeTracker.ts`; production code MUST NOT
 * import from it. The `__tests__/` ancestor segment is the contract;
 * this assertion makes it load-bearing.
 *
 * Two checks per file under `src/`:
 *
 *   1. The bare identifier `\bFakeTracker\b` must not appear in
 *      any non-test file (docstrings, code, comments — all forbidden
 *      so the comment scrub doesn't rot back).
 *   2. The module specifier `__tests__/helpers/FakeTracker` must not
 *      appear in any non-test import — the `__tests__/` ancestor is
 *      the contract; this assertion makes the contract load-bearing.
 *
 * Mirrors the `dashboard/src/__tests__/no-poll-imports.test.ts`
 * pattern: replaces reviewer discipline + manual `grep` with a
 * vitest-time invariant.
 *
 * Replaces the retired `no-memory-tracker-in-production.test.ts` from
 * DX-343 — the prior in-memory tracker class was deleted entirely in
 * Phase 4 / DX-345.
 */

const SRC_ROOT = resolve(__dirname, "..", "..");

// Files allowed to mention `FakeTracker`. The set is exhaustive:
//   - This file (carries the literal string in its own assertions).
// Everything else under `src/__tests__/helpers/FakeTracker.ts` is
// already excluded by `isProductionFile` (the `__tests__/` ancestor
// segment marks it test-only).
const SYMBOL_EXEMPT_FILES = new Set<string>([
  join("__tests__", "issue-tracker", "no-fake-tracker-in-production.test.ts"),
]);

const SYMBOL_RE = /\bFakeTracker\b/;
const HELPER_IMPORT_RE = /__tests__\/helpers\/FakeTracker(?:\.js)?["']/;

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

describe("no-FakeTracker-in-production sweep", () => {
  it("no production .ts file mentions the bare `FakeTracker` identifier", () => {
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

  it("no production .ts file imports from `__tests__/helpers/FakeTracker`", () => {
    const violations: string[] = [];
    for (const absPath of walkSrc(SRC_ROOT)) {
      const relPath = absPath.slice(SRC_ROOT.length + 1);
      if (!isProductionFile(absPath)) continue;
      const content = readFileSync(absPath, "utf-8");
      if (HELPER_IMPORT_RE.test(content)) {
        violations.push(relPath);
      }
    }
    expect(violations).toEqual([]);
  });
});
