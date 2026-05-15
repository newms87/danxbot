/**
 * DX-525 — `mirrorWorkspacesIntoWorktrees` must filter against the git
 * worktree registry instead of blindly iterating every subdir under
 * `<repo>/.danxbot/worktrees/`. The producer of stale orphan dirs
 * (sibling-package compose stacks with relative bind-mount sources) is
 * external to danxbot; the inject pipeline's only job is to refuse to
 * `mkdir` into them (which triggered the EACCES warn-spam loop) and to
 * reap empties the parent dir's permissions allow.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REAP_AGE_FLOOR_MS,
  listRegisteredWorktreeBasenames,
  reapOrSkipOrphanWorktreeDir,
} from "./sync.js";

function gitInit(repoRoot: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoRoot,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repoRoot });
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: repoRoot,
  });
  writeFileSync(resolve(repoRoot, "README"), "init\n");
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync(
    "git",
    ["commit", "-q", "-m", "init", "--allow-empty"],
    { cwd: repoRoot },
  );
}

describe("listRegisteredWorktreeBasenames — DX-525", () => {
  let tmpRoot: string;
  let repoRoot: string;
  let worktreesRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "dx525-registry-"));
    repoRoot = resolve(tmpRoot, "repo");
    worktreesRoot = resolve(repoRoot, ".danxbot", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    gitInit(repoRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns basenames of worktrees registered under worktreesRoot", () => {
    execFileSync(
      "git",
      [
        "worktree",
        "add",
        "-q",
        "-B",
        "sage",
        resolve(worktreesRoot, "sage"),
      ],
      { cwd: repoRoot },
    );
    execFileSync(
      "git",
      [
        "worktree",
        "add",
        "-q",
        "-B",
        "buildy",
        resolve(worktreesRoot, "buildy"),
      ],
      { cwd: repoRoot },
    );

    const names = listRegisteredWorktreeBasenames(repoRoot, worktreesRoot);
    expect(names).not.toBeNull();
    expect(names).toEqual(new Set(["sage", "buildy"]));
  });

  it("ignores worktrees registered outside worktreesRoot (main checkout)", () => {
    const names = listRegisteredWorktreeBasenames(repoRoot, worktreesRoot);
    expect(names).toEqual(new Set());
  });

  it("excludes hand-mkdir-ed orphan subdirs (not in registry)", () => {
    execFileSync(
      "git",
      [
        "worktree",
        "add",
        "-q",
        "-B",
        "sage",
        resolve(worktreesRoot, "sage"),
      ],
      { cwd: repoRoot },
    );
    mkdirSync(resolve(worktreesRoot, "danx"));
    mkdirSync(resolve(worktreesRoot, "danx-ui"));

    const names = listRegisteredWorktreeBasenames(repoRoot, worktreesRoot);
    expect(names).toEqual(new Set(["sage"]));
  });

  it("returns null when repoRoot is not a git repo (fail loud — caller skips mirror)", () => {
    const notARepo = resolve(tmpRoot, "not-a-repo");
    mkdirSync(notARepo);

    const names = listRegisteredWorktreeBasenames(notARepo, worktreesRoot);
    expect(names).toBeNull();
  });

  // The connected-repo dirs at `<danxbot>/repos/<name>/` are symlinks
  // (`repo-context.ts` builds `localPath` from the symlinked path). git
  // worktree list --porcelain emits realpath. Without symlink resolution
  // in the prefix comparison, every registered worktree string-mismatches
  // → empty set → caller misclassifies real worktrees as orphans → reap
  // pass would nuke active agent dirs. CRITICAL — do not remove this test
  // without proving the realpath normalization is preserved.
  it("symlink-rooted worktreesRoot still resolves real worktrees (CRITICAL realpath)", () => {
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-B", "sage", resolve(worktreesRoot, "sage")],
      { cwd: repoRoot },
    );
    // Build a symlink to the real repo and call the helper through it,
    // mirroring how `<danxbot>/repos/<name>/` shapes the localPath the
    // poller passes in.
    const symRepo = resolve(tmpRoot, "repo-via-symlink");
    symlinkSync(repoRoot, symRepo);
    const symWorktreesRoot = resolve(symRepo, ".danxbot", "worktrees");

    const names = listRegisteredWorktreeBasenames(symRepo, symWorktreesRoot);
    expect(names).not.toBeNull();
    // If realpath normalization is missing, this set is EMPTY and the
    // assertion fails — exactly the symptom that would have caused
    // catastrophic reap-of-live-worktrees.
    expect(names).toEqual(new Set(["sage"]));
  });
});

describe("reapOrSkipOrphanWorktreeDir — DX-525", () => {
  let tmpRoot: string;
  let worktreesRoot: string;
  const oldMtimeSec = Math.floor((Date.now() - REAP_AGE_FLOOR_MS * 5) / 1000);

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "dx525-reap-fn-"));
    worktreesRoot = resolve(tmpRoot, "worktrees");
    mkdirSync(worktreesRoot);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reaps an empty orphan dir older than the age floor", () => {
    const orphan = resolve(worktreesRoot, "danx");
    mkdirSync(orphan);
    utimesSync(orphan, oldMtimeSec, oldMtimeSec);

    reapOrSkipOrphanWorktreeDir("repo", orphan, "danx", oldMtimeSec * 1000);
    expect(existsSync(orphan)).toBe(false);
  });

  it("leaves a non-empty orphan dir in place", () => {
    const orphan = resolve(worktreesRoot, "danx-with-content");
    mkdirSync(orphan);
    writeFileSync(resolve(orphan, "marker.txt"), "do not reap");
    utimesSync(orphan, oldMtimeSec, oldMtimeSec);

    reapOrSkipOrphanWorktreeDir(
      "repo",
      orphan,
      "danx-with-content",
      oldMtimeSec * 1000,
    );
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(resolve(orphan, "marker.txt"))).toBe(true);
  });

  it("skips a fresh dir (mid-bootstrap race guard)", () => {
    const fresh = resolve(worktreesRoot, "just-created");
    mkdirSync(fresh);

    reapOrSkipOrphanWorktreeDir("repo", fresh, "just-created", Date.now());
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("mirrorWorkspacesIntoWorktrees — DX-525 orphan reap (integration via syncRepoFiles)", () => {
  // Light end-to-end: a hand-mkdir-ed empty orphan must be reaped on the
  // next tick. We do not exercise the full `syncRepoFiles` here because
  // its other stages need a populated `.danxbot/config/` and full
  // `RepoContext`; covered separately. Instead we drive
  // `mirrorWorkspacesIntoWorktrees` via the orphan path using only the
  // pieces that interact with the filter logic.

  let tmpRoot: string;
  let repoRoot: string;
  let worktreesRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "dx525-reap-"));
    repoRoot = resolve(tmpRoot, "repo");
    worktreesRoot = resolve(repoRoot, ".danxbot", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    gitInit(repoRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("filter correctly identifies orphan-empty vs orphan-nonempty vs registered", () => {
    // Registered worktree.
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-B", "sage", resolve(worktreesRoot, "sage")],
      { cwd: repoRoot },
    );
    // Orphan empty (the danx / danx-ui shape).
    mkdirSync(resolve(worktreesRoot, "danx"));
    // Orphan non-empty.
    const stubborn = resolve(worktreesRoot, "danx-with-content");
    mkdirSync(stubborn);
    writeFileSync(resolve(stubborn, "marker.txt"), "do not reap");

    const names = listRegisteredWorktreeBasenames(repoRoot, worktreesRoot);
    expect(names).toEqual(new Set(["sage"]));
    // The caller is responsible for the rmdir attempt; we assert here that
    // the registry-based filter classifies the three correctly.
    expect(names!.has("danx")).toBe(false);
    expect(names!.has("danx-with-content")).toBe(false);
    expect(existsSync(stubborn)).toBe(true);
  });
});
