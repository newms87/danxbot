import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, utimes, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pruneSfcDepsJob, runPruneSfcDepsJob } from "./prune-sfc-deps.js";

describe("pruneSfcDepsJob", () => {
  it("registers with name + 24h interval", () => {
    expect(pruneSfcDepsJob.name).toBe("prune-sfc-deps");
    expect(pruneSfcDepsJob.intervalSec).toBe(86400);
  });
});

describe("runPruneSfcDepsJob", () => {
  let baseDir: string;
  let manifestDir: string;
  let logs: object[];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "sfc-cron-prune-"));
    manifestDir = await mkdtemp(join(tmpdir(), "sfc-cron-prune-manifest-"));
    logs = [];
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await rm(manifestDir, { recursive: true, force: true });
  });

  it("skips when no manifest source configured", async () => {
    await mkdir(join(baseDir, "old"), { recursive: true });
    await runPruneSfcDepsJob({
      env: {},
      baseDir,
      log: (l) => logs.push(l),
    });
    expect(logs.some((l: any) => l.kind === "skipped-no-source")).toBe(true);
    // The stale dir was preserved because no source = unknown active set.
    expect(await stat(join(baseDir, "old"))).toBeDefined();
  });

  it("prunes inactive stale dirs when source returns active set", async () => {
    // Active: 1.0.0
    await mkdir(join(manifestDir, "1.0.0"), { recursive: true });
    await writeFile(
      join(manifestDir, "1.0.0", "shared_deps_lock.json"),
      JSON.stringify({ shell_version: "1.0.0", deps: {} }),
    );

    // Inactive + stale (90d old): 2.0.0
    await mkdir(join(baseDir, "2.0.0"), { recursive: true });
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await utimes(join(baseDir, "2.0.0"), old, old);

    // Inactive + fresh: 3.0.0 (just created)
    await mkdir(join(baseDir, "3.0.0"), { recursive: true });

    await runPruneSfcDepsJob({
      env: { SFC_DEPS_LOCAL_MANIFEST_DIR: manifestDir },
      baseDir,
      log: (l) => logs.push(l),
    });

    const tick = logs.find((l: any) => l.kind === "tick-complete");
    expect(tick).toBeDefined();
    expect((tick as any).pruned).toBe(1);

    await expect(stat(join(baseDir, "2.0.0"))).rejects.toThrow();
    expect(await stat(join(baseDir, "3.0.0"))).toBeDefined();
  });
});
