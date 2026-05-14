/**
 * Unit tests for the worker-boot stale-/tmp-dir sweep — DX-44.
 *
 * The sweep is the safety net for the SIGKILL / OOM / worker-crash leak
 * class that no in-process cleanup hook can ever cover: when the worker
 * dies without running its shutdown handler, every dir created by
 * `mkdtempSync(join(tmpdir(), "danxbot-{mcp,term,prompt}-"))` survives.
 * On worker boot we walk those prefixes and remove any dir older than a
 * safe threshold (defaults to 2 × the longest single-dispatch timeout).
 *
 * Property tests we lock down:
 *   - Older-than-threshold dirs are removed.
 *   - Newer-than-threshold dirs are preserved (no live-dispatch
 *     interference).
 *   - Unrelated `/tmp` entries (`danxbot-test-*`, `danxbot-workspace-*`,
 *     etc.) are untouched — the sweep is prefix-scoped.
 *   - A missing tmpdir is treated as "nothing to sweep" (returns 0, does
 *     not throw).
 *   - A single failed `rm` does NOT abort the rest of the sweep — the
 *     remaining dirs still get reaped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleTmpDirs, STALE_TMP_PREFIXES } from "./tmp-dir-sweep.js";

function ageDir(path: string, ageMs: number): void {
  // utimes only takes seconds for the seconds-resolution legacy syscall,
  // but Node accepts numbers + the underlying fs op honors ms via the
  // libuv layer. Use Date objects for portability.
  const past = new Date(Date.now() - ageMs);
  utimesSync(path, past, past);
}

describe("sweepStaleTmpDirs (DX-44)", () => {
  let testBase: string;

  beforeEach(() => {
    // Isolated sandbox per test — never touches the real /tmp.
    testBase = mkdtempSync(join(tmpdir(), "danxbot-test-sweep-"));
  });

  afterEach(() => {
    rmSync(testBase, { recursive: true, force: true });
  });

  it("removes danxbot-{mcp,term,prompt}-* dirs older than the threshold", async () => {
    const oldDirs = STALE_TMP_PREFIXES.map((prefix) => {
      const dir = join(testBase, `${prefix}-OLD-${prefix.slice(8)}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "settings.json"), "{}");
      ageDir(dir, 3 * 60 * 60 * 1000); // 3 hours old
      return dir;
    });

    const result = await sweepStaleTmpDirs({
      tmpRoot: testBase,
      maxAgeMs: 2 * 60 * 60 * 1000, // threshold = 2h
    });

    expect(result.removed.length).toBe(oldDirs.length);
    for (const dir of oldDirs) {
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("preserves dirs newer than the threshold (no live-dispatch interference)", async () => {
    const recentDirs = STALE_TMP_PREFIXES.map((prefix) => {
      const dir = join(testBase, `${prefix}-NEW-${prefix.slice(8)}`);
      mkdirSync(dir);
      // 30 minutes old — well within the 2h threshold; represents a
      // dispatch that may still be running.
      ageDir(dir, 30 * 60 * 1000);
      return dir;
    });

    const result = await sweepStaleTmpDirs({
      tmpRoot: testBase,
      maxAgeMs: 2 * 60 * 60 * 1000,
    });

    expect(result.removed.length).toBe(0);
    for (const dir of recentDirs) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("does NOT touch unrelated /tmp entries (prefix-scoped)", async () => {
    const danxbotMcp = join(testBase, "danxbot-mcp-XYZ");
    mkdirSync(danxbotMcp);
    ageDir(danxbotMcp, 3 * 60 * 60 * 1000);

    // Untouched: test fixture dirs use `danxbot-test-*` / `danxbot-assert-*` —
    // neither matches the sweep allowlist.
    const otherEntries = [
      "danxbot-test-fixture-aaa",
      "danxbot-assert-ok-bbb",
      "not-a-danxbot-dir",
      "some-other-app-data",
    ];
    for (const name of otherEntries) {
      const path = join(testBase, name);
      mkdirSync(path);
      ageDir(path, 3 * 60 * 60 * 1000);
    }

    const result = await sweepStaleTmpDirs({
      tmpRoot: testBase,
      maxAgeMs: 2 * 60 * 60 * 1000,
    });

    expect(result.removed).toEqual([danxbotMcp]);
    expect(existsSync(danxbotMcp)).toBe(false);
    for (const name of otherEntries) {
      expect(existsSync(join(testBase, name))).toBe(true);
    }
  });

  it("returns 0 + does not throw when the tmpdir does not exist", async () => {
    const missing = join(testBase, "does-not-exist");

    const result = await sweepStaleTmpDirs({
      tmpRoot: missing,
      maxAgeMs: 60 * 60 * 1000,
    });

    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("continues sweeping when one rm fails (best-effort per-dir)", async () => {
    const ok = join(testBase, "danxbot-mcp-okok");
    mkdirSync(ok);
    ageDir(ok, 3 * 60 * 60 * 1000);

    const failing = join(testBase, "danxbot-mcp-fail");
    mkdirSync(failing);
    ageDir(failing, 3 * 60 * 60 * 1000);

    // Force the rm on `failing` to throw — `rmSync` with `force: true`
    // doesn't normally throw on missing entries, but a real-world
    // failure path is EACCES on a Linux dev box. Spy on the helper's
    // injected `rm` function so we can deterministically fail one of
    // the targets without messing with file permissions.
    const rm = vi.fn((path: string) => {
      if (path === failing) throw new Error("EACCES");
      rmSync(path, { recursive: true, force: true });
    });

    const result = await sweepStaleTmpDirs({
      tmpRoot: testBase,
      maxAgeMs: 2 * 60 * 60 * 1000,
      rm,
    });

    expect(result.removed).toEqual([ok]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].path).toBe(failing);
    expect(existsSync(ok)).toBe(false);
    expect(existsSync(failing)).toBe(true);
  });

  it("STALE_TMP_PREFIXES pins the producer allowlist", () => {
    // Adding a new `mkdtempSync(join(tmpdir(), "danxbot-<X>-"))` call
    // site MUST update both the producer module AND this list. Any
    // graceful-termination cleanup wiring is independent — the sweep
    // is purely defensive for the SIGKILL / OOM / crash leak class.
    expect([...STALE_TMP_PREFIXES]).toEqual([
      "danxbot-mcp",
      "danxbot-term",
      "danxbot-prompt",
      "danxbot-workspace-settings",
      "danxbot-workspace-mcp",
    ]);
  });
});
