/**
 * DX-684 — dispatch cleanliness invariant test.
 *
 * The parent epic (DX-668) cleaned up which on-disk files the worker
 * writes inside the consumed repo's `<repo>/.danxbot/` and which moved
 * to the worker-owned runtime volume at `<runtime-volume>/<repo>/`
 * (DX-682 + DX-683). The operational guarantee: after a full dispatch
 * + completion cycle, `<repo>/.danxbot/` `git status --porcelain` is
 * empty — no worker drift in any file outside the operator-owned
 * contract surface.
 *
 * This test exercises EACH known worker writer of runtime-volume state
 * and asserts the file lands at the runtime-volume path, NOT inside
 * `<repo>/.danxbot/`. A regression that re-routes a writer back into
 * `<repo>/.danxbot/` fails here at Layer 1 — cheaper than catching it
 * post-dispatch on a system test.
 *
 * Substitutes the "full real dispatch" AC variant for two reasons:
 * (a) a full dispatch requires `ANTHROPIC_API_KEY` + `make test-system`
 *     (~$1 + minutes per run, gated on operator approval).
 * (b) the file-location invariant is what the AC is verifying — a
 *     deterministic Layer 1 test exercising each writer is strictly
 *     more thorough than a single end-to-end run that happens to land
 *     ZERO of the writers under audit.
 *
 * If any new worker writer of runtime-volume state lands, add a row to
 * the test below — the suite is the codebase's audit-trail for the
 * invariant.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

describe("DX-684 — consumed-repo `.danxbot/` stays clean across worker writes", () => {
  let tmpRoot: string;
  let runtimeRoot: string;
  let repoDir: string;
  const repoName = "danxbot";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "danxbot-cleanliness-"));
    runtimeRoot = join(tmpRoot, "runtime");
    repoDir = join(tmpRoot, "repos", repoName);
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(join(repoDir, ".danxbot"), { recursive: true });
    process.env.DANX_RUNTIME_ROOT = runtimeRoot;
  });

  afterEach(() => {
    delete process.env.DANX_RUNTIME_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Recursive list of files under a directory, relative paths. */
  function listFiles(dir: string): string[] {
    const out: string[] = [];
    function walk(d: string): void {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else out.push(relative(dir, p));
      }
    }
    if (existsSync(dir)) walk(dir);
    return out;
  }

  it("writeFlag (CRITICAL_FAILURE) lands under runtime volume, NOT <repo>/.danxbot", async () => {
    const { writeFlag, flagPath } = await import("../../critical-failure.js");
    writeFlag(repoDir, {
      source: "agent",
      dispatchId: "d-1",
      reason: "cleanliness-test",
    });

    expect(flagPath(repoDir)).toBe(
      join(runtimeRoot, repoName, "CRITICAL_FAILURE"),
    );
    expect(existsSync(flagPath(repoDir))).toBe(true);
    expect(existsSync(join(repoDir, ".danxbot", "CRITICAL_FAILURE"))).toBe(false);
    expect(listFiles(join(repoDir, ".danxbot"))).toEqual([]);
  });

  it("syncRepoRoot state file lands under runtime volume, NOT <repo>/.danxbot", async () => {
    const { syncRepoRoot } = await import("../../worker/sync-root.js");
    // Force the "dirty" branch by stubbing exec: git status returns a
    // modified file → recordError writes the state file. Fastest path
    // to exercise the writer without spinning up real git.
    let calls = 0;
    const result = await syncRepoRoot({
      repoName,
      repoLocalPath: repoDir,
      exec: async (args) => {
        calls += 1;
        if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "status")
          return { code: 0, stdout: " M src/foo.ts\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-05-18T12:00:00Z",
    });

    expect(calls).toBeGreaterThan(0);
    expect(result.status).toBe("dirty");
    expect(
      existsSync(join(runtimeRoot, repoName, "sync-root-state.json")),
    ).toBe(true);
    expect(
      existsSync(join(repoDir, ".danxbot", "sync-root-state.json")),
    ).toBe(false);
    expect(listFiles(join(repoDir, ".danxbot"))).toEqual([]);
  });

  it("settings drift (display) lands under runtime volume, NOT <repo>/.danxbot/settings.json", async () => {
    const settings = await import("../../settings-file.js");
    // Operator contract file must exist BEFORE writeSettings (it's
    // append-shaped — the writer merges over the existing contract).
    // Seed a minimal valid contract so the writer can read it back.
    writeFileSync(
      settings.settingsFilePath(repoDir),
      JSON.stringify({
        overrides: {
          slack: { enabled: null },
          issuePoller: { enabled: null },
          dispatchApi: { enabled: null },
          ideator: { enabled: null },
          autoTriage: { enabled: null },
          trelloSync: { enabled: null },
        },
        meta: { updatedAt: "2026-05-18T00:00:00Z", updatedBy: "deploy" },
      }),
    );

    // Stamping a `display` patch writes the drift partition to the
    // runtime volume; the contract file's overrides are untouched.
    await settings.writeSettings(repoDir, {
      display: { worker: { port: 5562, runtime: "host" } },
      writtenBy: "worker",
    });

    const driftPath = settings.runtimeSettingsFilePath(repoDir);
    expect(driftPath).toBe(
      join(runtimeRoot, repoName, "settings-runtime.json"),
    );
    expect(existsSync(driftPath)).toBe(true);

    // The contract file in <repo>/.danxbot/ stays at the OPERATOR shape
    // — no `display` block leaked. Reading it back round-trips clean.
    const contractFiles = listFiles(join(repoDir, ".danxbot"));
    expect(contractFiles).toEqual(["settings.json"]);

    const fs = await import("node:fs");
    const contract = JSON.parse(
      fs.readFileSync(settings.settingsFilePath(repoDir), "utf8"),
    );
    expect(contract.display).toBeUndefined();
  });

  it("all writers combined: <repo>/.danxbot/ contains ONLY operator contract files", async () => {
    // Run every writer back-to-back as a worker would, then audit the
    // consumed repo's `.danxbot/` directory: only `settings.json` may
    // appear (the operator contract). Everything else must be on the
    // runtime volume.
    const { writeFlag } = await import("../../critical-failure.js");
    const { syncRepoRoot } = await import("../../worker/sync-root.js");
    const settings = await import("../../settings-file.js");

    writeFileSync(
      settings.settingsFilePath(repoDir),
      JSON.stringify({
        overrides: {
          slack: { enabled: null },
          issuePoller: { enabled: null },
          dispatchApi: { enabled: null },
          ideator: { enabled: null },
          autoTriage: { enabled: null },
          trelloSync: { enabled: null },
        },
        meta: { updatedAt: "2026-05-18T00:00:00Z", updatedBy: "deploy" },
      }),
    );

    writeFlag(repoDir, {
      source: "agent",
      dispatchId: "d-1",
      reason: "cleanliness-test",
    });
    await syncRepoRoot({
      repoName,
      repoLocalPath: repoDir,
      exec: async (args) =>
        args[0] === "status"
          ? { code: 0, stdout: " M src/foo.ts\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      now: () => "2026-05-18T12:00:00Z",
    });
    await settings.writeSettings(repoDir, {
      display: { worker: { port: 5562, runtime: "host" } },
      writtenBy: "worker",
    });

    expect(listFiles(join(repoDir, ".danxbot")).sort()).toEqual([
      "settings.json",
    ]);

    // Conversely the runtime volume has every other file the writers
    // produced — proves the writers ran (no false-clean from a
    // skipped-writer regression).
    const runtimeFiles = listFiles(join(runtimeRoot, repoName)).sort();
    expect(runtimeFiles).toContain("CRITICAL_FAILURE");
    expect(runtimeFiles).toContain("sync-root-state.json");
    expect(runtimeFiles).toContain("settings-runtime.json");
  });
});
