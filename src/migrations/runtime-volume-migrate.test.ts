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
    expect(result.skipped).toEqual(["CRITICAL_FAILURE"]);
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
    expect(second.skipped).toEqual([]);
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

    expect(result.skipped).toEqual(["CRITICAL_FAILURE"]);
    expect(result.moved).toEqual([]);
    // Old dir is left as-is — caller must not silently destroy it.
    expect(existsSync(oldPath)).toBe(true);
  });

  it("ensures the per-repo runtime dir exists even when no migration runs", () => {
    const result = migrateRuntimeVolume(repoName, repoLocalPath);
    expect(result.skipped).toEqual(["CRITICAL_FAILURE"]);
    expect(existsSync(join(process.env.DANX_RUNTIME_ROOT!, repoName))).toBe(true);
  });
});
