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
 * Canonical mount layout (Trello 0bjFD0a2):
 *   $CLAUDE_AUTH_DIR/.claude.json              — file-bind, rename-stale OK
 *   $CLAUDE_AUTH_DIR/.claude/.credentials.json — under a dir-bind so host
 *                                                rename rotation is visible
 *                                                inside the container
 *
 * Tests run the real shell script via child_process against per-test
 * temporary directories, then inspect the resulting filesystem. No mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, lstatSync, readlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(process.cwd(), "scripts/claude-auth-setup.sh");

let tmpRoot: string;
let mountDir: string;
let credsSubdir: string;
let homeDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "claude-auth-test-"));
  mountDir = join(tmpRoot, "mount");
  // Mirrors the canonical container layout: `.claude.json` is at the root
  // of $CLAUDE_AUTH_DIR; `.credentials.json` lives one level down in the
  // `.claude/` subdir which (in real Docker) is a separate dir-bind.
  credsSubdir = join(mountDir, ".claude");
  homeDir = join(tmpRoot, "home");
  mkdirSync(credsSubdir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
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
  it("symlinks .claude.json and .credentials.json into DANXBOT_HOME pointing at the canonical CLAUDE_AUTH_DIR layout", () => {
    writeFileSync(join(mountDir, ".claude.json"), '{"hello":"world"}');
    writeFileSync(join(credsSubdir, ".credentials.json"), '{"token":"abc"}');

    const result = runScript();
    expect(result.status).toBe(0);

    const claudeJsonPath = join(homeDir, ".claude.json");
    const credsPath = join(homeDir, ".claude/.credentials.json");

    // Must be SYMLINKS — not copies. This is the core contract.
    expect(lstatSync(claudeJsonPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(credsPath).isSymbolicLink()).toBe(true);

    // Symlinks must point at the canonical mount layout.
    expect(readlinkSync(claudeJsonPath)).toBe(join(mountDir, ".claude.json"));
    expect(readlinkSync(credsPath)).toBe(join(credsSubdir, ".credentials.json"));
  });

  it("reading through the symlink returns whatever the mount source currently has — no stale snapshot", () => {
    writeFileSync(join(mountDir, ".claude.json"), '{"version":1}');
    writeFileSync(join(credsSubdir, ".credentials.json"), '{"token":"original"}');

    const result = runScript();
    expect(result.status).toBe(0);

    // Reading through the symlink returns mount contents.
    expect(readFileSync(join(homeDir, ".claude/.credentials.json"), "utf-8")).toBe('{"token":"original"}');

    // Rotate the mount source via in-place rewrite (writeFileSync truncates
    // and overwrites the existing inode — matches how a simple text-editor
    // save works on the host).
    writeFileSync(join(credsSubdir, ".credentials.json"), '{"token":"refreshed"}');

    // The in-HOME read reflects the fresh value with no re-run of the script.
    // This proves the symlink path traversal is live for same-inode writes.
    expect(readFileSync(join(homeDir, ".claude/.credentials.json"), "utf-8")).toBe('{"token":"refreshed"}');
  });

  it("survives host atomic-write rotation (rename) — the dir-mount semantics this layout models", () => {
    // Trello 0bjFD0a2: Claude Code on the host rotates credentials via the
    // standard atomic-write pattern — write new file at temp path, then
    // rename() over the target. rename() creates a NEW inode.
    //
    // A file-level bind would pin the original inode at compose-up and
    // serve stale bytes after rename. The fix mounts the PARENT DIRECTORY
    // (`.claude/`) as a dir-bind: dir mounts expose the directory's
    // current file table, so a rename() inside that directory updates
    // the table and the next open() inside the container resolves to the
    // NEW inode.
    //
    // This test exercises the rename path at the filesystem level. The
    // test rig uses symlink path resolution rather than a real Docker
    // bind, but the symlink-through-dir semantics match what a real
    // dir-bind produces: every read traverses `mountDir/.claude/` and
    // sees the directory's CURRENT entry for `.credentials.json`. The
    // rename-tolerance contract documented here is what claude-auth-
    // setup.sh + the dir-bind in compose.yml deliver together.
    writeFileSync(join(credsSubdir, ".credentials.json"), '{"token":"original"}');
    writeFileSync(join(mountDir, ".claude.json"), "{}");
    runScript();

    // Capture inode of the current mount-source file.
    const originalIno = require("node:fs").statSync(
      join(credsSubdir, ".credentials.json"),
    ).ino;

    // Simulate the host atomic-write rotation: write new content to a
    // temp path inside the dir-mount source, then rename() over the
    // creds file. rename() creates a NEW inode at the path.
    const tmpPath = join(credsSubdir, ".credentials.json.tmp");
    writeFileSync(tmpPath, '{"token":"rotated via rename()"}');
    require("node:fs").renameSync(
      tmpPath,
      join(credsSubdir, ".credentials.json"),
    );
    const rotatedIno = require("node:fs").statSync(
      join(credsSubdir, ".credentials.json"),
    ).ino;
    expect(rotatedIno).not.toBe(originalIno); // sanity: rename DID change inode

    // The in-HOME read sees the rotated content. Both this filesystem
    // analog AND a real Docker dir-bind agree on this — the dir's
    // current file-table entry for `.credentials.json` points at the
    // new inode, so the symlink (or bind) traverses to fresh bytes.
    expect(readFileSync(join(homeDir, ".claude/.credentials.json"), "utf-8"))
      .toBe('{"token":"rotated via rename()"}');
  });

  it("creates DANXBOT_HOME/.claude as a real directory — not a symlink — so claude can still write backups/", () => {
    writeFileSync(join(mountDir, ".claude.json"), "{}");
    writeFileSync(join(credsSubdir, ".credentials.json"), "{}");

    runScript();

    const claudeDir = join(homeDir, ".claude");
    expect(lstatSync(claudeDir).isDirectory()).toBe(true);
    expect(lstatSync(claudeDir).isSymbolicLink()).toBe(false);

    // Sanity check: the directory is writable — claude can drop its backups/
    // and session-state children here.
    const backups = join(claudeDir, "backups");
    mkdirSync(backups);
    expect(existsSync(backups)).toBe(true);
  });

  it("is idempotent — running twice produces the same symlinks with no error", () => {
    writeFileSync(join(mountDir, ".claude.json"), "{}");
    writeFileSync(join(credsSubdir, ".credentials.json"), "{}");

    const first = runScript();
    expect(first.status).toBe(0);

    const second = runScript();
    expect(second.status).toBe(0);

    expect(lstatSync(join(homeDir, ".claude.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(homeDir, ".claude/.credentials.json")).isSymbolicLink()).toBe(true);
  });

  it("overwrites a pre-existing regular file at the symlink path (fixes a stale copy from an older entrypoint version)", () => {
    writeFileSync(join(mountDir, ".claude.json"), '{"from":"mount"}');
    writeFileSync(join(credsSubdir, ".credentials.json"), '{"from":"mount"}');
    // Pre-seed the HOME with stale copies as if an older entrypoint ran.
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
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

  it("exits 0 with a warning when .claude/.credentials.json is missing (half-configured layout — fails closed instead of dangling symlink)", () => {
    // Half-configured layout: `.claude.json` present at the root, but no
    // `.claude/.credentials.json` in the subdir. This is the failure mode
    // the parallel guard exists to prevent — without the guard, `ln -sfn`
    // would happily create a dangling symlink at
    // $DANXBOT_HOME/.claude/.credentials.json and the worker would report
    // healthy until the first dispatch's auth attempt 401's.
    writeFileSync(join(mountDir, ".claude.json"), "{}");
    // Note: credsSubdir was created in beforeEach but is empty.

    const result = runScript();
    expect(result.status).toBe(0);
    const out = String(result.stderr) + String(result.stdout);
    expect(out).toMatch(/WARNING.*credentials/i);
    expect(out).toMatch(/401/);
    // No symlink should have been created — fail closed.
    expect(existsSync(join(homeDir, ".claude/.credentials.json"))).toBe(false);
    // The .claude.json symlink also should NOT exist — exit 0 happens
    // before any ln -sfn runs, so the half-configured state is visibly
    // unfinished.
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
    writeFileSync(join(credsSubdir, ".credentials.json"), "{}");
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
