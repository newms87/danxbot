import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runtimeVolumeRoot,
  repoRuntimeDir,
  runtimeVolumePath,
  ensureRepoRuntimeDir,
} from "./runtime-volume.js";

describe("runtime-volume", () => {
  let tmp: string;
  let savedOverride: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "danxbot-rtvol-"));
    savedOverride = process.env.DANX_RUNTIME_ROOT;
    savedXdg = process.env.XDG_DATA_HOME;
    delete process.env.DANX_RUNTIME_ROOT;
    delete process.env.XDG_DATA_HOME;
  });

  afterEach(() => {
    if (savedOverride === undefined) delete process.env.DANX_RUNTIME_ROOT;
    else process.env.DANX_RUNTIME_ROOT = savedOverride;
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdg;
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("runtimeVolumeRoot", () => {
    it("honors DANX_RUNTIME_ROOT override above all defaults", () => {
      process.env.DANX_RUNTIME_ROOT = tmp;
      expect(runtimeVolumeRoot()).toBe(tmp);
    });

    it("honors DANX_RUNTIME_ROOT even with XDG_DATA_HOME also set", () => {
      process.env.DANX_RUNTIME_ROOT = tmp;
      process.env.XDG_DATA_HOME = join(tmp, "xdg");
      expect(runtimeVolumeRoot()).toBe(tmp);
    });

    it("falls back to ~/.local/share/danxbot or $XDG_DATA_HOME/danxbot on host", () => {
      const root = runtimeVolumeRoot();
      // On host (the test runtime), root must NOT be the docker path.
      expect(root).not.toBe("/var/lib/danxbot");
      // It must end with /danxbot — either via XDG default or the home fallback.
      expect(root.endsWith("/danxbot")).toBe(true);
    });

    it("honors XDG_DATA_HOME when no override is set (host runtime)", () => {
      process.env.XDG_DATA_HOME = join(tmp, "xdg");
      expect(runtimeVolumeRoot()).toBe(join(tmp, "xdg", "danxbot"));
    });

    it("re-reads the override on every call — not memoized", () => {
      process.env.DANX_RUNTIME_ROOT = tmp;
      expect(runtimeVolumeRoot()).toBe(tmp);
      const other = mkdtempSync(join(tmpdir(), "danxbot-rtvol-other-"));
      try {
        process.env.DANX_RUNTIME_ROOT = other;
        expect(runtimeVolumeRoot()).toBe(other);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  describe("repoRuntimeDir + runtimeVolumePath", () => {
    beforeEach(() => {
      process.env.DANX_RUNTIME_ROOT = tmp;
    });

    it("returns <root>/<repoName>", () => {
      expect(repoRuntimeDir("danxbot")).toBe(join(tmp, "danxbot"));
    });

    it("joins extra segments onto the per-repo dir", () => {
      expect(runtimeVolumePath("danxbot", "CRITICAL_FAILURE")).toBe(
        join(tmp, "danxbot", "CRITICAL_FAILURE"),
      );
      expect(runtimeVolumePath("danxbot", "sync-root-state.json")).toBe(
        join(tmp, "danxbot", "sync-root-state.json"),
      );
      expect(runtimeVolumePath("gpt-manager", "subdir", "file.json")).toBe(
        join(tmp, "gpt-manager", "subdir", "file.json"),
      );
    });

    it("isolates per-repo paths under the same root", () => {
      const a = repoRuntimeDir("repo-a");
      const b = repoRuntimeDir("repo-b");
      expect(a).not.toBe(b);
      expect(a).toBe(join(tmp, "repo-a"));
      expect(b).toBe(join(tmp, "repo-b"));
    });
  });

  describe("ensureRepoRuntimeDir", () => {
    beforeEach(() => {
      process.env.DANX_RUNTIME_ROOT = tmp;
    });

    it("creates the per-repo dir under the volume root", () => {
      const dir = repoRuntimeDir("danxbot");
      expect(existsSync(dir)).toBe(false);
      ensureRepoRuntimeDir("danxbot");
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
    });

    it("is idempotent — repeat calls do not throw", () => {
      ensureRepoRuntimeDir("danxbot");
      ensureRepoRuntimeDir("danxbot");
      ensureRepoRuntimeDir("danxbot");
      expect(existsSync(repoRuntimeDir("danxbot"))).toBe(true);
    });

    it("creates parent dirs recursively when the volume root itself is missing", () => {
      const nested = join(tmp, "nested", "extra");
      process.env.DANX_RUNTIME_ROOT = nested;
      expect(existsSync(nested)).toBe(false);
      ensureRepoRuntimeDir("danxbot");
      expect(existsSync(join(nested, "danxbot"))).toBe(true);
    });
  });
});
