import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * DX-593 — repo-level ordering test.
 *
 * The boot migration sweep MUST run BEFORE:
 *   - `startIssuesMirror` (chokidar mirror starts watching disk)
 *   - `startWorkerCronLoop` (poller arms + first dispatch tick)
 *   - `startWorkerServer` (HTTP listener accepts /api/launch dispatches)
 *
 * A boot that arms any of those readers / dispatchers against mixed-version
 * disk is a workflow violation — readers downstream of P3 (which strips the
 * validator's inline tolerance branches) will fail loud on pre-v10 input.
 *
 * Locked at the source-string level: read `src/index.ts` once, locate every
 * call by literal regex, assert byte-offset ordering. If any of the marker
 * functions move OR the sweep call gets removed, this test catches it
 * before merge.
 */
describe("DX-593 — boot order: migration sweep precedes mirror / cron / HTTP", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "../..", "index.ts"),
    "utf-8",
  );

  function indexOfOrThrow(needle: string): number {
    const idx = src.indexOf(needle);
    if (idx === -1) {
      throw new Error(
        `boot-order test: marker "${needle}" not found in src/index.ts — has the file been renamed / refactored?`,
      );
    }
    return idx;
  }

  it("runBootMigrationSweep is called inside startWorkerMode", () => {
    expect(src).toContain("runBootMigrationSweep");
  });

  it("the sweep call precedes startIssuesMirror in src/index.ts", () => {
    const sweep = indexOfOrThrow("runBootMigrationSweep(");
    const mirror = indexOfOrThrow("startIssuesMirror(");
    expect(sweep).toBeLessThan(mirror);
  });

  it("the sweep call precedes startWorkerCronLoop in src/index.ts", () => {
    const sweep = indexOfOrThrow("runBootMigrationSweep(");
    const cron = indexOfOrThrow("startWorkerCronLoop(");
    expect(sweep).toBeLessThan(cron);
  });

  it("the sweep call precedes startWorkerServer in src/index.ts", () => {
    const sweep = indexOfOrThrow("runBootMigrationSweep(");
    const http = indexOfOrThrow("startWorkerServer(");
    expect(sweep).toBeLessThan(http);
  });

  it("the failure path writes CRITICAL_FAILURE and exits the process — locked in one ordered region", () => {
    // Tight regex pinning all three tokens of the failure branch in
    // ORDER within a small byte window. Loose `process.exit(1)` matches
    // the file's fatal-error handler too — meaningless. The regex below
    // requires the conditional check, then writeFlag with the right
    // source, then process.exit(1) — all within ~1KB. A future edit that
    // drops any of the three (or rearranges them) fails the test.
    expect(src).toMatch(
      /sweep\.failed\.length\s*>\s*0[\s\S]{0,1000}writeFlag\s*\([\s\S]{0,500}"boot-migration-sweep"[\s\S]{0,500}process\.exit\(1\)/,
    );
  });

  it("the sweep call precedes reattachOrResolveDispatches (downstream YAML reader)", () => {
    // Defense for once P3 strips the validator's inline tolerance branches:
    // reattach reads open YAMLs via loadLocal → parseIssue. Today the
    // validator accepts v9 + v10; once P3 lands, only v10. The sweep MUST
    // run first so reattach never sees mixed-version disk.
    const sweep = indexOfOrThrow("runBootMigrationSweep(");
    const reattach = indexOfOrThrow("reattachOrResolveDispatches(");
    expect(sweep).toBeLessThan(reattach);
  });

  it("the sweep call precedes runInvariantHeal (downstream YAML reader)", () => {
    // Same rationale as the reattach test — the invariant-heal pass reads
    // every open YAML.
    const sweep = indexOfOrThrow("runBootMigrationSweep(");
    const heal = indexOfOrThrow("runInvariantHeal(");
    expect(sweep).toBeLessThan(heal);
  });
});
