/**
 * DX-652 — wiring guard. The Self-Repair finalize hook
 * (`finalizeRepairByDispatchId`) MUST be invoked by both
 * `handleStop` (in-memory path) AND `handleStopFromDb` (DB-fallback
 * path) BEFORE the dispatch row's terminal write. We wrap the call
 * in `maybeFinalizeRepair` to share the swallow-on-error contract;
 * this test pins that the call exists in BOTH paths AND that the
 * helper itself is defined.
 *
 * Source-grep rather than runtime mock: `handleStop` carries a long
 * branch tree (critical_failure / agent_blocked / completed / failed)
 * each with its own preconditions, gates, and stamp paths — driving
 * it end-to-end in a unit test would dwarf the cost-benefit of this
 * guard. The two structural invariants (helper defined + called in
 * both stop paths) are what would actually regress.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DISPATCH_TS = readFileSync(
  join(__dirname, "dispatch.ts"),
  "utf-8",
);

describe("DX-652 wiring guard — maybeFinalizeRepair", () => {
  it("defines `maybeFinalizeRepair` helper that delegates to finalizeRepairByDispatchId", () => {
    expect(DISPATCH_TS).toMatch(
      /async function maybeFinalizeRepair\(/,
    );
    expect(DISPATCH_TS).toMatch(/finalizeRepairByDispatchId\(/);
    // Imports the hook from the system-repair module.
    expect(DISPATCH_TS).toMatch(
      /import\s*\{\s*finalizeRepairByDispatchId\s*\}\s*from\s*"\.\.\/system-repair\/finalize-by-dispatch-id\.js"/,
    );
  });

  it("invokes `maybeFinalizeRepair` from BOTH handleStop and handleStopFromDb", () => {
    // Two call sites — one per stop path.
    const matches = DISPATCH_TS.match(/await maybeFinalizeRepair\(/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("calls maybeFinalizeRepair AFTER the gate (status/summary already finalized) and BEFORE the terminal-branch matchers", () => {
    // Anchor on the gate's `let status = gated.status;` line; the
    // finalize call must appear within ~10 lines of the gate result
    // and BEFORE the first `if (status === "critical_failure")`
    // branch in both paths.
    const handleStopIdx = DISPATCH_TS.indexOf("export async function handleStop(");
    const handleStopFromDbIdx = DISPATCH_TS.indexOf(
      "async function handleStopFromDb(",
    );
    expect(handleStopIdx).toBeGreaterThan(-1);
    expect(handleStopFromDbIdx).toBeGreaterThan(-1);

    function assertOrdering(startIdx: number, label: string): void {
      const slice = DISPATCH_TS.slice(startIdx, startIdx + 12_000);
      const gateIdx = slice.indexOf("let status = gated.status");
      const finalizeIdx = slice.indexOf("await maybeFinalizeRepair(");
      const firstBranchIdx = slice.indexOf(
        'if (status === "critical_failure")',
      );
      expect(gateIdx, `${label}: gate marker`).toBeGreaterThan(-1);
      expect(finalizeIdx, `${label}: finalize call`).toBeGreaterThan(gateIdx);
      expect(firstBranchIdx, `${label}: first branch`).toBeGreaterThan(
        finalizeIdx,
      );
    }
    assertOrdering(handleStopFromDbIdx, "handleStopFromDb");
    assertOrdering(handleStopIdx, "handleStop");
  });
});
