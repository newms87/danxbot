/**
 * DX-310 regression pin — guards the vitest config invariants that
 * stabilize the full-suite flake on subprocess-spawning test files.
 *
 * The flake (~5 timeouts per `npx vitest run`) returned when:
 *   - the worker pool was the default `"threads"` (V8 event-loop
 *     contention with spawned `npx tsx` children inside tests), OR
 *   - `availableParallelism()`-many workers were allowed (22 on the
 *     dev host), oversubscribing CPU for the four spawn-heavy suites.
 *
 * The fix (forks + maxForks <= 4) is documented inline in
 * `vitest.config.ts`. This file asserts the invariants survive every
 * commit so a future PR that reverts the cap fails loudly on `make
 * test` rather than reintroducing the flake silently on a low-cpu
 * dev box where it would not manifest locally.
 *
 * Pattern mirrors the schema_version invariant pin in
 * `src/issue-tracker/yaml.test.ts` (DX-280).
 */

import { describe, it, expect } from "vitest";
import config from "../vitest.config";

// `defineConfig` returns the raw object literal we passed in — its
// `test` field is the same shape we authored, no runtime narrowing
// needed for these reads.
const testConfig = (config as { test?: Record<string, unknown> }).test ?? {};

describe("vitest.config.ts — DX-310 flake regression pin", () => {
  it("uses the forks pool (threads pool is what the flake regressed under)", () => {
    expect(testConfig.pool).toBe("forks");
  });

  it("caps maxWorkers at <= 4 so subprocess-spawning tests don't race for CPU", () => {
    expect(testConfig.maxWorkers).toBeDefined();
    expect(testConfig.maxWorkers as number).toBeLessThanOrEqual(4);
  });

  it("raises testTimeout and hookTimeout above vitest's 5s/10s defaults", () => {
    expect(testConfig.testTimeout).toBeGreaterThanOrEqual(15_000);
    expect(testConfig.hookTimeout).toBeGreaterThanOrEqual(15_000);
  });
});
