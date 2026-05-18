import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runtimeVolumePath } from "../runtime-volume.js";
import { migrateRuntimeVolume } from "./runtime-volume-migrate.js";

describe("migrateRuntimeVolume", () => {
  let tmp: string;
  let repoLocalPath: string;
  let repoName: string;
  let savedRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "danxbot-rtmig-"));
    savedRoot = process.env.DANX_RUNTIME_ROOT;
    process.env.DANX_RUNTIME_ROOT = join(tmp, "runtime");
    repoLocalPath = join(tmp, "repo");
    repoName = basename(repoLocalPath);
    mkdirSync(join(repoLocalPath, ".danxbot"), { recursive: true });
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.DANX_RUNTIME_ROOT;
    else process.env.DANX_RUNTIME_ROOT = savedRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("no-op when both old and new are absent", () => {
    const result = migrateRuntimeVolume(repoName, repoLocalPath);
    expect(result.moved).toEqual([]);
    expect(result.alreadyMigrated).toEqual([]);
    // DX-683 added `settings.json` split migration; with no in-repo
    // settings.json present it lands in `skipped` alongside CRITICAL_FAILURE.
    expect(result.skipped.sort()).toEqual(["CRITICAL_FAILURE", "settings.json"]);
  });

  it("moves CRITICAL_FAILURE from old to new when only old exists", () => {
    const oldPath = join(repoLocalPath, ".danxbot", "CRITICAL_FAILURE");
    const newPath = runtimeVolumePath(repoName, "CRITICAL_FAILURE");
    const body = '{"source":"agent","timestamp":"2026-05-18T00:00:00Z","dispatchId":"d-1","reason":"test"}';
    writeFileSync(oldPath, body);

    const result = migrateRuntimeVolume(repoName, repoLocalPath);

    expect(result.moved).toEqual(["CRITICAL_FAILURE"]);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, "utf-8")).toBe(body);
  });

  it("is idempotent — second run after a successful move is a no-op (alreadyMigrated)", () => {
    const oldPath = join(repoLocalPath, ".danxbot", "CRITICAL_FAILURE");
    writeFileSync(oldPath, '{"source":"agent","timestamp":"t","dispatchId":"d","reason":"r"}');

    migrateRuntimeVolume(repoName, repoLocalPath);
    const second = migrateRuntimeVolume(repoName, repoLocalPath);

    expect(second.moved).toEqual([]);
    expect(second.alreadyMigrated).toEqual(["CRITICAL_FAILURE"]);
    // DX-683 — no in-repo settings.json in this fixture, so the split
    // migration lands in `skipped`. CRITICAL_FAILURE is the focus of
    // this assertion.
    expect(second.skipped).toEqual(["settings.json"]);
  });

  it("when both old and new exist: keeps new content, deletes old residue", () => {
    const oldPath = join(repoLocalPath, ".danxbot", "CRITICAL_FAILURE");
    const newPath = runtimeVolumePath(repoName, "CRITICAL_FAILURE");
    mkdirSync(join(process.env.DANX_RUNTIME_ROOT!, repoName), { recursive: true });
    writeFileSync(oldPath, '{"source":"agent","timestamp":"old","dispatchId":"d-old","reason":"old"}');
    writeFileSync(newPath, '{"source":"agent","timestamp":"new","dispatchId":"d-new","reason":"new"}');

    const result = migrateRuntimeVolume(repoName, repoLocalPath);

    expect(result.alreadyMigrated).toEqual(["CRITICAL_FAILURE"]);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    // Verify the NEW file's content survived — old was discarded.
    expect(readFileSync(newPath, "utf-8")).toContain('"d-new"');
  });

  it("skips when old path is a directory (defensive guard against shape confusion)", () => {
    const oldPath = join(repoLocalPath, ".danxbot", "CRITICAL_FAILURE");
    mkdirSync(oldPath);

    const result = migrateRuntimeVolume(repoName, repoLocalPath);

    expect(result.skipped).toContain("CRITICAL_FAILURE");
    expect(result.moved).toEqual([]);
    // Old dir is left as-is — caller must not silently destroy it.
    expect(existsSync(oldPath)).toBe(true);
  });

  it("ensures the per-repo runtime dir exists even when no migration runs", () => {
    const result = migrateRuntimeVolume(repoName, repoLocalPath);
    expect(result.skipped.sort()).toEqual(["CRITICAL_FAILURE", "settings.json"]);
    expect(existsSync(join(process.env.DANX_RUNTIME_ROOT!, repoName))).toBe(true);
  });

  // ====================================================================
  // DX-683 — settings.json contract/drift split migration
  // ====================================================================

  describe("settings.json split (DX-683)", () => {
    const settingsInRepoPath = (): string =>
      join(repoLocalPath, ".danxbot", "settings.json");
    const settingsDriftPath = (): string =>
      runtimeVolumePath(repoName, "settings-runtime.json");

    it("no-op when in-repo settings.json is absent (fresh install)", () => {
      const result = migrateRuntimeVolume(repoName, repoLocalPath);
      expect(result.moved).not.toContain("settings.json");
      expect(result.alreadyMigrated).not.toContain("settings.json");
      expect(result.skipped).toContain("settings.json");
      expect(existsSync(settingsDriftPath())).toBe(false);
    });

    it("no-op when in-repo settings.json has no `display` field (already canonical)", () => {
      writeFileSync(
        settingsInRepoPath(),
        JSON.stringify({
          overrides: { slack: { enabled: true } },
          meta: { updatedAt: "2026-05-18T00:00:00Z", updatedBy: "dashboard:op" },
        }),
      );

      const result = migrateRuntimeVolume(repoName, repoLocalPath);
      expect(result.moved).not.toContain("settings.json");
      expect(result.alreadyMigrated).not.toContain("settings.json");
      expect(result.skipped).toContain("settings.json");
      // Drift file untouched — no display to migrate, no reason to create it.
      expect(existsSync(settingsDriftPath())).toBe(false);
      // In-repo file untouched.
      const after = JSON.parse(readFileSync(settingsInRepoPath(), "utf-8"));
      expect(after.overrides.slack.enabled).toBe(true);
    });

    it("PARTITIONS a pre-split single-file shape: drift file gets display, in-repo file loses display; all other contract fields preserved verbatim", () => {
      const legacyBody = {
        overrides: { slack: { enabled: false }, dispatchApi: { enabled: true } },
        agents: { alice: { type: "agent", bio: "test" } },
        agentDefaults: { prepMode: "separate" },
        effortLevels: [{ name: "medium", model: "x", effort: "low" }],
        effortAssignmentPrompt: "operator prompt",
        selfRepair: { threshold: 5 },
        display: { worker: { port: 1234, runtime: "host" } },
        meta: { updatedAt: "2026-05-18T00:00:00Z", updatedBy: "worker" },
      };
      writeFileSync(settingsInRepoPath(), JSON.stringify(legacyBody));

      const result = migrateRuntimeVolume(repoName, repoLocalPath);
      expect(result.moved).toContain("settings.json");

      // Drift file present with display + meta.
      expect(existsSync(settingsDriftPath())).toBe(true);
      const drift = JSON.parse(readFileSync(settingsDriftPath(), "utf-8"));
      expect(drift.display).toEqual({ worker: { port: 1234, runtime: "host" } });
      expect(drift.meta).toEqual(legacyBody.meta);

      // In-repo file rewritten without display; every OTHER contract
      // field preserved verbatim (no normalize-on-migrate — the writers
      // re-normalize on next read, the migration is purely structural).
      const contract = JSON.parse(readFileSync(settingsInRepoPath(), "utf-8"));
      expect(contract.display).toBeUndefined();
      expect(contract.overrides).toEqual(legacyBody.overrides);
      expect(contract.agents).toEqual(legacyBody.agents);
      expect(contract.agentDefaults).toEqual(legacyBody.agentDefaults);
      expect(contract.effortLevels).toEqual(legacyBody.effortLevels);
      expect(contract.effortAssignmentPrompt).toEqual(legacyBody.effortAssignmentPrompt);
      expect(contract.selfRepair).toEqual(legacyBody.selfRepair);
      expect(contract.meta).toEqual(legacyBody.meta);
    });

    it("partitions a legacy file with NO meta block — drift gets display, no meta key", () => {
      // Legacy display-bearing shape without a meta block (synthetic
      // hand-edited file, or pre-meta versions of the worker).
      const legacyBody = {
        overrides: { slack: { enabled: true } },
        display: { worker: { port: 1, runtime: "docker" } },
      };
      writeFileSync(settingsInRepoPath(), JSON.stringify(legacyBody));

      migrateRuntimeVolume(repoName, repoLocalPath);

      const drift = JSON.parse(readFileSync(settingsDriftPath(), "utf-8"));
      expect(drift.display).toEqual({ worker: { port: 1, runtime: "docker" } });
      // No meta key on the drift file when the legacy file had none.
      expect("meta" in drift).toBe(false);

      // In-repo file still readable — no meta key either, but partitioned.
      const contract = JSON.parse(readFileSync(settingsInRepoPath(), "utf-8"));
      expect(contract.display).toBeUndefined();
      expect(contract.overrides.slack.enabled).toBe(true);
    });

    it("is idempotent — second run after a successful split is a no-op", () => {
      writeFileSync(
        settingsInRepoPath(),
        JSON.stringify({
          overrides: { slack: { enabled: false } },
          display: { worker: { port: 1, runtime: "docker" } },
          meta: { updatedAt: "2026-05-18T00:00:00Z", updatedBy: "worker" },
        }),
      );

      // First run partitions.
      migrateRuntimeVolume(repoName, repoLocalPath);
      const driftBytesAfterFirst = readFileSync(settingsDriftPath(), "utf-8");

      // Second run — no `display` left on the in-repo file → skipped.
      const result2 = migrateRuntimeVolume(repoName, repoLocalPath);
      expect(result2.moved).not.toContain("settings.json");
      expect(result2.skipped).toContain("settings.json");
      // Drift file untouched (byte-stable).
      expect(readFileSync(settingsDriftPath(), "utf-8")).toBe(driftBytesAfterFirst);
    });

    it("both present (operator pre-populated drift) — tidies in-repo residue, leaves drift alone", () => {
      // Operator pre-populated the drift file by hand.
      mkdirSync(join(process.env.DANX_RUNTIME_ROOT!, repoName), { recursive: true });
      const operatorDrift = {
        display: { worker: { port: 9999, runtime: "host" } },
        meta: { updatedAt: "2026-05-18T05:00:00Z", updatedBy: "deploy" },
      };
      writeFileSync(settingsDriftPath(), JSON.stringify(operatorDrift));

      // The in-repo file ALSO still carries display residue (older boot).
      writeFileSync(
        settingsInRepoPath(),
        JSON.stringify({
          overrides: { slack: { enabled: true } },
          display: { worker: { port: 1, runtime: "docker" } },
          meta: { updatedAt: "2026-05-17T00:00:00Z", updatedBy: "worker" },
        }),
      );

      const result = migrateRuntimeVolume(repoName, repoLocalPath);
      expect(result.alreadyMigrated).toContain("settings.json");

      // Drift file untouched — operator's content wins.
      const drift = JSON.parse(readFileSync(settingsDriftPath(), "utf-8"));
      expect(drift).toEqual(operatorDrift);

      // In-repo file rewritten without display.
      const contract = JSON.parse(readFileSync(settingsInRepoPath(), "utf-8"));
      expect(contract.display).toBeUndefined();
      expect(contract.overrides.slack.enabled).toBe(true);
    });

    it("skips when in-repo settings.json fails to parse (leaves both files untouched)", () => {
      writeFileSync(settingsInRepoPath(), "{not json");
      const result = migrateRuntimeVolume(repoName, repoLocalPath);
      expect(result.skipped).toContain("settings.json");
      // Drift file NOT created — migration refuses to act on bad input.
      expect(existsSync(settingsDriftPath())).toBe(false);
      // In-repo file untouched.
      expect(readFileSync(settingsInRepoPath(), "utf-8")).toBe("{not json");
    });
  });
});
