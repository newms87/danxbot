/**
 * Unit tests for stale-dir prune.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pruneStaleSfcDeps } from "./prune.js";
import type { PruneLogLine } from "./types.js";

describe("pruneStaleSfcDeps", () => {
  let baseDir: string;
  let logs: PruneLogLine[];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "sfc-deps-prune-"));
    logs = [];
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  async function mkVersion(name: string, ageMs: number, now: number) {
    const dir = join(baseDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "shared_deps_lock.json"),
      JSON.stringify({ shell_version: name, deps: {} }),
    );
    const t = new Date(now - ageMs);
    await utimes(dir, t, t);
    return dir;
  }

  it("keeps active versions even when they are old", async () => {
    const now = Date.now();
    await mkVersion("1.0.0", 90 * 24 * 60 * 60 * 1000, now);
    await mkVersion("2.0.0", 1000, now);

    const result = await pruneStaleSfcDeps({
      baseDir,
      activeShellVersions: new Set(["1.0.0", "2.0.0"]),
      staleAfterMs: 30 * 24 * 60 * 60 * 1000,
      now: () => now,
      log: (l) => logs.push(l),
    });

    expect(result.pruned).toEqual([]);
    expect(result.kept.sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(await stat(join(baseDir, "1.0.0"))).toBeDefined();
  });

  it("prunes inactive versions older than staleAfterMs", async () => {
    const now = Date.now();
    await mkVersion("1.0.0", 90 * 24 * 60 * 60 * 1000, now); // stale
    await mkVersion("2.0.0", 1000, now);

    const result = await pruneStaleSfcDeps({
      baseDir,
      activeShellVersions: new Set(["2.0.0"]),
      staleAfterMs: 30 * 24 * 60 * 60 * 1000,
      now: () => now,
      log: (l) => logs.push(l),
    });

    expect(result.pruned).toEqual(["1.0.0"]);
    expect(result.kept).toEqual(["2.0.0"]);
    await expect(stat(join(baseDir, "1.0.0"))).rejects.toThrow();
  });

  it("keeps inactive but fresh versions (within staleAfterMs window)", async () => {
    const now = Date.now();
    await mkVersion("1.0.0", 10 * 24 * 60 * 60 * 1000, now); // 10d old, inactive

    const result = await pruneStaleSfcDeps({
      baseDir,
      activeShellVersions: new Set(["2.0.0"]),
      staleAfterMs: 30 * 24 * 60 * 60 * 1000,
      now: () => now,
      log: (l) => logs.push(l),
    });

    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual(["1.0.0"]);
    expect(logs.some((l) => l.kind === "skipped-fresh")).toBe(true);
  });

  it("rejects unsafe shell_version dir names (defense in depth)", async () => {
    // Create a real-looking dir name that has a safe filesystem name but
    // we drop into the prune as an "active" set entry with unsafe chars
    // to make sure the prune doesn't follow it.
    const now = Date.now();
    await mkVersion("legit", 1000, now);

    // Manually create an unsafe-named dir (not via mkVersion to bypass
    // mkdir refusing names with '/' — names with '..' as a segment
    // wouldn't survive `mkdir baseDir/..` anyway, so we test the active
    // set name validity instead).
    const result = await pruneStaleSfcDeps({
      baseDir,
      activeShellVersions: new Set(["../escape"]),
      staleAfterMs: 30 * 24 * 60 * 60 * 1000,
      now: () => now,
      log: (l) => logs.push(l),
    });

    // The unsafe entry in activeShellVersions is ignored — the live
    // "legit" dir is inactive but fresh, so it stays.
    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual(["legit"]);
  });

  it("ignores non-directory entries under baseDir", async () => {
    const now = Date.now();
    await writeFile(join(baseDir, "stray.txt"), "hi");
    await mkVersion("1.0.0", 1000, now);

    const result = await pruneStaleSfcDeps({
      baseDir,
      activeShellVersions: new Set(["1.0.0"]),
      staleAfterMs: 30 * 24 * 60 * 60 * 1000,
      now: () => now,
      log: (l) => logs.push(l),
    });

    expect(result.kept).toEqual(["1.0.0"]);
  });

  it("isolates per-dir delete failures: one rm throws, others still pruned", async () => {
    const now = Date.now();
    await mkVersion("1.0.0", 90 * 24 * 60 * 60 * 1000, now);
    await mkVersion("2.0.0", 90 * 24 * 60 * 60 * 1000, now);

    let calls = 0;
    const result = await pruneStaleSfcDeps({
      baseDir,
      activeShellVersions: new Set(),
      staleAfterMs: 30 * 24 * 60 * 60 * 1000,
      now: () => now,
      rmDir: async (dir) => {
        calls++;
        if (dir.endsWith("1.0.0")) throw new Error("simulated rm fail");
        await rm(dir, { recursive: true, force: true });
      },
      log: (l) => logs.push(l),
    });

    expect(calls).toBe(2);
    expect(result.pruned).toEqual(["2.0.0"]);
    expect(result.failed).toEqual([
      { shell_version: "1.0.0", error: "simulated rm fail" },
    ]);
  });

  it("returns empty result when baseDir does not exist", async () => {
    const result = await pruneStaleSfcDeps({
      baseDir: join(baseDir, "missing"),
      activeShellVersions: new Set(),
      staleAfterMs: 1000,
      log: (l) => logs.push(l),
    });
    expect(result).toEqual({ pruned: [], kept: [], failed: [] });
  });
});
