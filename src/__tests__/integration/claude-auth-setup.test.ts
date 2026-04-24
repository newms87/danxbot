/**
 * Integration tests for scripts/claude-auth-setup.sh.
 *
 * The script is invoked from entrypoint.sh on every worker container start.
 * Its one job: point the in-HOME Claude auth files at the bind-mounted
 * CLAUDE_AUTH_DIR via symlinks, so token refreshes on the host are live
 * inside the container with no restart. The contract is load-bearing —
 * if it silently falls back to copying, stale-token 401s return and every
 * dispatch breaks until someone notices.
 *
 * Tests run the real shell script via child_process against per-test
 * temporary directories, then inspect the resulting filesystem. No mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, lstatSync, readlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(process.cwd(), "scripts/claude-auth-setup.sh");

let tmpRoot: string;
let mountDir: string;
let homeDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "claude-auth-test-"));
  mountDir = join(tmpRoot, "mount");
  homeDir = join(tmpRoot, "home");
  // Matches the compose layout: $CLAUDE_AUTH_DIR is the mounted dir, $DANXBOT_HOME
  // is where the in-HOME symlinks should end up.
  require("node:fs").mkdirSync(mountDir, { recursive: true });
  require("node:fs").mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runScript(env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [SCRIPT], {
    env: {
      CLAUDE_AUTH_DIR: mountDir,
      DANXBOT_HOME: homeDir,
      // Skip chown in tests — running as non-root, and the ownership assertion
      // is covered by the prod runtime.
      CHOWN_USER: "",
      PATH: process.env.PATH ?? "",
      ...env,
    },
    encoding: "utf-8",
  });
}

describe("claude-auth-setup.sh", () => {
  it("symlinks .claude.json and .credentials.json into DANXBOT_HOME pointing at CLAUDE_AUTH_DIR", () => {
    writeFileSync(join(mountDir, ".claude.json"), '{"hello":"world"}');
    writeFileSync(join(mountDir, ".credentials.json"), '{"token":"abc"}');

    const result = runScript();
    expect(result.status).toBe(0);

    const claudeJsonPath = join(homeDir, ".claude.json");
    const credsPath = join(homeDir, ".claude/.credentials.json");

    // Must be SYMLINKS — not copies. This is the core contract.
    expect(lstatSync(claudeJsonPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(credsPath).isSymbolicLink()).toBe(true);

    // Symlinks must point at the mount, not a copy.
    expect(readlinkSync(claudeJsonPath)).toBe(join(mountDir, ".claude.json"));
    expect(readlinkSync(credsPath)).toBe(join(mountDir, ".credentials.json"));
  });

  it("reading through the symlink returns whatever the mount source currently has — no stale snapshot", () => {
    writeFileSync(join(mountDir, ".claude.json"), '{"version":1}');
    writeFileSync(join(mountDir, ".credentials.json"), '{"token":"original"}');

    const result = runScript();
    expect(result.status).toBe(0);

    // Reading through the symlink returns mount contents.
    expect(readFileSync(join(homeDir, ".claude/.credentials.json"), "utf-8")).toBe('{"token":"original"}');

    // Rotate the mount source via in-place rewrite (writeFileSync truncates
    // and overwrites the existing inode — matches how a simple text-editor
    // save works on the host).
    writeFileSync(join(mountDir, ".credentials.json"), '{"token":"refreshed"}');

    // The in-HOME read reflects the fresh value with no re-run of the script.
    // This proves the symlink path traversal is live for same-inode writes.
    expect(readFileSync(join(homeDir, ".claude/.credentials.json"), "utf-8")).toBe('{"token":"refreshed"}');
  });

  it("documents the known rename-over-mount limitation — host atomic-write rotation needs a worker restart", () => {
    // This test exists to pin down the LIMITATION, not to celebrate a
    // success. Docker file-level bind mounts pin the host INODE, not the
    // host path. When Claude Code rotates credentials on the host via the
    // standard atomic-write pattern (write new file → rename() over the
    // old one), the host path gets a new inode but the container's bind
    // still points at the original (now unlinked) inode. Reads in the
    // container keep returning the OLD bytes until the worker restarts
    // and re-establishes the bind.
    //
    // The bind-mount infrastructure is only invoked once, at compose-up
    // time, so there's nothing claude-auth-setup.sh can do about this —
    // it's a Docker-level constraint. The live-refresh guarantee this
    // script currently provides is "in-place host writes are visible"
    // (test above). The rename-rotation case is tracked as a follow-up
    // Action Item; when the dir-mount enhancement lands, this test will
    // be updated to assert rename tolerance instead of documenting the
    // lack of it. See Trello 9ZurZCK2 retro.
    //
    // NOTE: we simulate the bind by NOT re-running the script. In the
    // real prod container the bind is never torn down between dispatches
    // either. This test is a filesystem-level analog.
    writeFileSync(join(mountDir, ".credentials.json"), '{"token":"original"}');
    writeFileSync(join(mountDir, ".claude.json"), "{}");
    runScript();

    // Capture inode of the current mount-source file.
    const originalIno = require("node:fs").statSync(
      join(mountDir, ".credentials.json"),
    ).ino;

    // Simulate the host atomic-write rotation: write the new content to a
    // temp path, then rename() it onto the mount source. This creates a
    // new inode at the path.
    const tmpPath = join(mountDir, ".credentials.json.tmp");
    writeFileSync(tmpPath, '{"token":"rotated via rename()"}');
    require("node:fs").renameSync(
      tmpPath,
      join(mountDir, ".credentials.json"),
    );
    const rotatedIno = require("node:fs").statSync(
      join(mountDir, ".credentials.json"),
    ).ino;
    expect(rotatedIno).not.toBe(originalIno); // sanity: rename DID change inode

    // At the filesystem level — since we're going through a symlink, not
    // an actual Docker bind — the test DOES see the rotated content:
    expect(readFileSync(join(homeDir, ".claude/.credentials.json"), "utf-8"))
      .toBe('{"token":"rotated via rename()"}');

    // …but inside a real Docker file-level bind mount, the container would
    // still see the original bytes because the bind is pinned to
    // `originalIno` and the kernel keeps that inode alive via the bind
    // reference even though no host path points at it anymore. Verifying
    // that Docker-level behavior requires a live container and is covered
    // in the system test suite, not here. This unit test's contract is
    // limited to the symlink path resolution.
  });

  it("creates DANXBOT_HOME/.claude as a real directory — not a symlink — so claude can still write backups/", () => {
    writeFileSync(join(mountDir, ".claude.json"), "{}");
    writeFileSync(join(mountDir, ".credentials.json"), "{}");

    runScript();

    const claudeDir = join(homeDir, ".claude");
    expect(lstatSync(claudeDir).isDirectory()).toBe(true);
    expect(lstatSync(claudeDir).isSymbolicLink()).toBe(false);

    // Sanity check: the directory is writable — claude can drop its backups/
    // and session-state children here.
    const backups = join(claudeDir, "backups");
    require("node:fs").mkdirSync(backups);
    expect(existsSync(backups)).toBe(true);
  });

  it("is idempotent — running twice produces the same symlinks with no error", () => {
    writeFileSync(join(mountDir, ".claude.json"), "{}");
    writeFileSync(join(mountDir, ".credentials.json"), "{}");

    const first = runScript();
    expect(first.status).toBe(0);

    const second = runScript();
    expect(second.status).toBe(0);

    expect(lstatSync(join(homeDir, ".claude.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(homeDir, ".claude/.credentials.json")).isSymbolicLink()).toBe(true);
  });

  it("overwrites a pre-existing regular file at the symlink path (fixes a stale copy from an older entrypoint version)", () => {
    writeFileSync(join(mountDir, ".claude.json"), '{"from":"mount"}');
    writeFileSync(join(mountDir, ".credentials.json"), '{"from":"mount"}');
    // Pre-seed the HOME with stale copies as if an older entrypoint ran.
    require("node:fs").mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(join(homeDir, ".claude.json"), '{"from":"stale copy"}');
    writeFileSync(join(homeDir, ".claude/.credentials.json"), '{"from":"stale copy"}');

    const result = runScript();
    expect(result.status).toBe(0);

    // After the script runs, both paths must be symlinks pointing at the mount.
    expect(lstatSync(join(homeDir, ".claude.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(homeDir, ".claude/.credentials.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(homeDir, ".claude.json"), "utf-8")).toBe('{"from":"mount"}');
    expect(readFileSync(join(homeDir, ".claude/.credentials.json"), "utf-8")).toBe('{"from":"mount"}');
  });

  it("exits 0 with a warning when CLAUDE_AUTH_DIR/.claude.json is missing (dev shell with no creds yet)", () => {
    const result = runScript();
    expect(result.status).toBe(0);
    expect(String(result.stderr) + String(result.stdout)).toMatch(/WARNING.*No Claude auth/i);
    // No symlinks should have been created.
    expect(existsSync(join(homeDir, ".claude.json"))).toBe(false);
  });

  it("fails loudly when CLAUDE_AUTH_DIR is not set (missing config is a bug, not a silent no-op)", () => {
    const result = spawnSync("bash", [SCRIPT], {
      env: {
        DANXBOT_HOME: homeDir,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/CLAUDE_AUTH_DIR/);
  });

  it("fails loudly when DANXBOT_HOME is not set", () => {
    writeFileSync(join(mountDir, ".claude.json"), "{}");
    const result = spawnSync("bash", [SCRIPT], {
      env: {
        CLAUDE_AUTH_DIR: mountDir,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/DANXBOT_HOME/);
  });
});
