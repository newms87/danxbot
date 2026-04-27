/**
 * Unit tests for the spawn-time projects-dir preflight (Trello cjAyJpgr-followup).
 *
 * Tests use real temp dirs + chmod, NOT fs mocks. The whole point of this
 * preflight is to catch a real-filesystem bug (Docker auto-created the
 * bind source as `root:root`, container UID 1000 can't write); a mocked
 * `access` call would not exercise the actual `EACCES` code path.
 *
 * The chmod-based readonly test is skipped under root (uid=0) because
 * root bypasses standard write checks; the worker container's `danxbot`
 * user is non-root and exercises the real path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightProjectsDir, ProjectsDirError } from "./projects-dir-preflight.js";

let tmpRoot: string;
let projectsDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "projects-dir-preflight-"));
  projectsDir = join(tmpRoot, "projects");
  mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  // Restore mode so rmSync can recurse — chmod 0o555 directories block
  // unlink in some sandboxes.
  try {
    chmodSync(projectsDir, 0o755);
  } catch {
    // missing dir: fine
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

const isRoot = process.getuid?.() === 0;

describe("preflightProjectsDir", () => {
  it("returns ok when the dir exists and is writable", async () => {
    const result = await preflightProjectsDir({ projectsDir });
    expect(result.ok).toBe(true);
  });

  it("fails with reason=missing when the dir does not exist", async () => {
    const result = await preflightProjectsDir({
      projectsDir: join(tmpRoot, "does-not-exist"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(result.summary).toMatch(/does not exist/);
  });

  it.skipIf(isRoot)(
    "fails with reason=readonly when the dir exists but is not writable",
    async () => {
      // 0o555 = r-xr-xr-x — readable + traversable but NOT writable. This
      // is the EXACT mode `root:root` + 0o755 produces for a non-root
      // user (UID 1000). `access(W_OK)` correctly returns EACCES.
      chmodSync(projectsDir, 0o555);

      const result = await preflightProjectsDir({ projectsDir });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("readonly");
      expect(result.summary).toMatch(/not writable/);
      // Contract: the summary names the chown remediation so an operator
      // reading the error in the dispatch response or /health knows what
      // command to run, instead of being told "permission denied" with
      // no remediation. Drop or rephrase only with a real reason.
      expect(result.summary).toMatch(/chown/);
    },
  );

  it.skipIf(isRoot)(
    "follows symlinks for the writability check (production layout uses bind-mount symlinks)",
    async () => {
      // Production layout doesn't currently symlink projects dir but
      // the auth-preflight does, and following symlinks is the safer
      // default. Lock the behavior so a future refactor that switches
      // to lstat doesn't silently miss EACCES on the target.
      const realDir = join(tmpRoot, "real-projects");
      const symlinkPath = join(tmpRoot, "link-projects");
      mkdirSync(realDir);
      symlinkSync(realDir, symlinkPath);
      chmodSync(realDir, 0o555);

      const result = await preflightProjectsDir({ projectsDir: symlinkPath });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("readonly");
    },
  );
});

describe("ProjectsDirError", () => {
  it("wraps a failure result with the same reason and message", () => {
    const result = {
      ok: false as const,
      reason: "readonly" as const,
      summary: "Projects dir /tmp/x is not writable by the worker — chown ...",
    };
    const err = new ProjectsDirError(result);

    expect(err.name).toBe("ProjectsDirError");
    expect(err.reason).toBe("readonly");
    expect(err.message).toBe(result.summary);
    // Dispatch.ts uses `err instanceof ProjectsDirError` to map to 503.
    // Lock the inheritance so a future refactor doesn't break the catch.
    expect(err).toBeInstanceOf(Error);
  });
});
