/**
 * Integration tests for WorktreeManager — exercises the real
 * `defaultGitRunner` (backed by `child_process.execFile`) against real git
 * repos in tmpdirs. Verifies the manager works end-to-end before code paths
 * that depend on it (DX-161 dispatch pre-flight, agent CRUD bootstrap/
 * teardown wiring) are wired up.
 *
 * Test layout per scenario:
 *   - `originDir` — bare repo acting as the remote (`origin`)
 *   - `repoDir` — main checkout cloned from origin; this is the
 *     `RepoContext.localPath`. The manager creates worktrees under
 *     `<repoDir>/.danxbot/worktrees/<name>/` and calls `git push origin
 *     --delete` against the bare clone for branch teardown.
 *
 * Skip-on-no-git: `which git` runs once at module load; the entire suite
 * skips if git is unavailable (CI hardening).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktreeManager,
  defaultGitRunner,
} from "../../agent/worktree-manager.js";
import { makeRepoContext } from "../helpers/fixtures.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const D = hasGit ? describe : describe.skip;

D("WorktreeManager (integration, real git)", () => {
  let originDir: string;
  let repoDir: string;
  let workArea: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf-8" });
  }

  beforeEach(() => {
    workArea = mkdtempSync(join(tmpdir(), "danxbot-wt-"));
    originDir = join(workArea, "origin.git");
    repoDir = join(workArea, "checkout");

    // Bare repo as the remote.
    execFileSync("git", ["init", "--bare", "--initial-branch=main", originDir], {
      stdio: "ignore",
    });

    // Seed the bare repo with one commit on `main` via a throwaway clone —
    // `git worktree add ... origin/main` requires `origin/main` to resolve
    // to a real commit.
    const seed = join(workArea, "seed");
    execFileSync("git", ["clone", originDir, seed], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: seed,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "test"], {
      cwd: seed,
      stdio: "ignore",
    });
    writeFileSync(join(seed, "README.md"), "seed\n");
    execFileSync("git", ["add", "."], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "seed"], {
      cwd: seed,
      stdio: "ignore",
    });
    execFileSync("git", ["push", "origin", "main"], {
      cwd: seed,
      stdio: "ignore",
    });

    // The "real" main checkout the worker uses.
    execFileSync("git", ["clone", originDir, repoDir], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "test"], {
      cwd: repoDir,
      stdio: "ignore",
    });
  });

  afterEach(() => {
    rmSync(workArea, { recursive: true, force: true });
  });

  function ctx() {
    return makeRepoContext({ localPath: repoDir });
  }

  // ============================================================
  // Bootstrap — fresh + idempotent
  // ============================================================

  it("bootstrap creates a worktree at <repo>/.danxbot/worktrees/<name>/ with a same-named branch", async () => {
    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const wtPath = wm.worktreePath(ctx(), "alice");
    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, ".git"))).toBe(true);

    const list = git(repoDir, "worktree", "list", "--porcelain");
    expect(list).toContain(wtPath);
    expect(list).toContain("branch refs/heads/alice");
  });

  it("bootstrap is idempotent — second run is a no-op", async () => {
    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");
    await wm.bootstrap(ctx(), "alice");

    const list = git(repoDir, "worktree", "list", "--porcelain");
    // One main + one alice — only two "worktree <path>" lines.
    const matches = list.match(/^worktree\s/gm) ?? [];
    expect(matches.length).toBe(2);
  });

  // ============================================================
  // validate — clean / dirty
  // ============================================================

  it("validate returns clean immediately after bootstrap", async () => {
    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const result = await wm.validate(ctx(), "alice");
    expect(result.state).toBe("clean");
  });

  it("validate returns dirty (uncommitted changes) when a file is modified", async () => {
    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");
    const wtPath = wm.worktreePath(ctx(), "alice");

    writeFileSync(join(wtPath, "wip.txt"), "in progress\n");

    const result = await wm.validate(ctx(), "alice");
    expect(result.state).toBe("dirty");
    if (result.state === "dirty") {
      expect(result.reason).toBe("uncommitted changes");
      expect(result.details.porcelain).toContain("wip.txt");
    }
  });

  it("validate returns dirty (branch ahead) when a commit is added on the agent branch", async () => {
    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");
    const wtPath = wm.worktreePath(ctx(), "alice");

    writeFileSync(join(wtPath, "feature.txt"), "feature\n");
    git(wtPath, "add", ".");
    git(wtPath, "commit", "-m", "wip feature");

    const result = await wm.validate(ctx(), "alice");
    expect(result.state).toBe("dirty");
    if (result.state === "dirty") {
      expect(result.reason).toBe("branch has unmerged commits");
      expect(result.details.ahead).toBe(1);
      expect(result.details.behind).toBe(0);
      expect(result.details.porcelain).toBe("");
    }
  });

  it("validate returns clean when only behind origin/main (reset will fast-forward)", async () => {
    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");
    const wtPath = wm.worktreePath(ctx(), "alice");

    // Add a commit on origin/main via a sibling clone, then push.
    const sib = join(workArea, "sib");
    execFileSync("git", ["clone", originDir, sib], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: sib,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "test"], {
      cwd: sib,
      stdio: "ignore",
    });
    writeFileSync(join(sib, "extra.txt"), "extra\n");
    execFileSync("git", ["add", "."], { cwd: sib, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "extra"], { cwd: sib, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "main"], { cwd: sib, stdio: "ignore" });

    // Refresh alice's cached `origin/main` — the manager doesn't fetch
    // (worktree mgmt is purely local; GitHub connectivity is the agent's
    // concern), so the caller does it explicitly when it needs to see
    // newly-pushed remote commits.
    execFileSync("git", ["fetch", "origin"], {
      cwd: wtPath,
      stdio: "ignore",
    });

    // Verify alice's worktree is now strictly behind origin/main.
    const result = await wm.validate(ctx(), "alice");
    expect(result.state).toBe("clean");
    expect(existsSync(join(wtPath, "extra.txt"))).toBe(false);
  });

  // ============================================================
  // resetClean — fast-forward and recover
  // ============================================================

  it("resetClean fast-forwards a behind-only branch back to origin/main", async () => {
    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");
    const wtPath = wm.worktreePath(ctx(), "alice");

    // Push a new commit through a sibling clone.
    const sib = join(workArea, "sib");
    execFileSync("git", ["clone", originDir, sib], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: sib,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "test"], {
      cwd: sib,
      stdio: "ignore",
    });
    writeFileSync(join(sib, "next.txt"), "next\n");
    execFileSync("git", ["add", "."], { cwd: sib, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "next"], { cwd: sib, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "main"], { cwd: sib, stdio: "ignore" });

    // Refresh cached `origin/main` so resetClean's `git reset --hard
    // origin/main` sees the new commit. The manager itself never
    // fetches.
    execFileSync("git", ["fetch", "origin"], {
      cwd: wtPath,
      stdio: "ignore",
    });

    await wm.resetClean(ctx(), "alice");

    // After reset, alice's tree should contain the new file.
    expect(existsSync(join(wtPath, "next.txt"))).toBe(true);

    // And validate should report clean.
    const result = await wm.validate(ctx(), "alice");
    expect(result.state).toBe("clean");
  });

  // ============================================================
  // Teardown — worktree gone, branch gone (local + remote)
  // ============================================================

  it("teardown removes the worktree directory and deletes both local + remote branches", async () => {
    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");
    const wtPath = wm.worktreePath(ctx(), "alice");

    // Push the alice branch to origin so there's a remote ref to delete.
    execFileSync("git", ["push", "origin", "alice"], {
      cwd: wtPath,
      stdio: "ignore",
    });

    expect(existsSync(wtPath)).toBe(true);
    const branchesBefore = git(repoDir, "branch", "--list", "alice").trim();
    expect(branchesBefore).not.toBe("");
    const remoteBefore = execFileSync("git", ["branch", "--list", "alice"], {
      cwd: originDir,
      encoding: "utf-8",
    }).trim();
    expect(remoteBefore).not.toBe("");

    await wm.teardown(ctx(), "alice");

    expect(existsSync(wtPath)).toBe(false);
    expect(git(repoDir, "branch", "--list", "alice").trim()).toBe("");
    expect(
      execFileSync("git", ["branch", "--list", "alice"], {
        cwd: originDir,
        encoding: "utf-8",
      }).trim(),
    ).toBe("");
  });
});
