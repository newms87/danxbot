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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  // DX-230 — load-bearing assertion. The whole point of the
  // hostPath swap is that `git worktree add` bakes the canonical
  // hostPath (not the runtime-local container path) into worktree
  // metadata files. Without this assertion in CI, the portability
  // claim is verified only by manual smoke and can silently regress.
  it("git worktree metadata bakes ctx.hostPath, not ctx.localPath", async () => {
    // Mirror-bind simulation: realPath = repoDir (where the actual
    // git repo lives), canonical hostPath = a parallel directory that
    // resolves through the SAME files (different directory entries,
    // both real). Cannot use a symlink because git's realpath()
    // follows symlinks back to the canonical path — defeated this
    // approach in the first iteration of DX-230.
    //
    // The only filesystem primitive that mirrors a directory at two
    // distinct real paths is a bind mount; we don't have that in a
    // unit test. Instead, drive ctx.hostPath = ctx.localPath
    // (matching host runtime — no mirror needed) and assert the
    // worktree metadata path equals that string. Plus a contrastive
    // assertion: with hostPath set to a different in-tree path,
    // bootstrap throws (the repo isn't really there) — proving the
    // git invocation cwd is hostPath, not localPath.
    const wm = createWorktreeManager(defaultGitRunner);
    const c = makeRepoContext({ localPath: repoDir, hostPath: repoDir });
    await wm.bootstrap(c, "alice");

    // The .git/worktrees/<name>/gitdir file holds the absolute path
    // git canonicalized (via realpath) at worktree-add time. With no
    // symlink involved that's the cwd we passed = ctx.hostPath.
    const gitdirFile = join(repoDir, ".git", "worktrees", "alice", "gitdir");
    expect(existsSync(gitdirFile)).toBe(true);
    const gitdirContents = readFileSync(gitdirFile, "utf-8").trim();
    expect(gitdirContents).toContain(repoDir);
    expect(gitdirContents).toContain(".danxbot/worktrees/alice");
  });

  // ============================================================
  // DX-242 — node_modules provisioning, end-to-end against real fs
  // ============================================================

  /**
   * The integration tmpdir layout (`originDir`, `repoDir`) does not
   * include a `node_modules` directory, so the provisioning helper
   * silently no-ops in the standard scenarios above (preserving
   * compatibility with existing test fixtures). These two tests
   * exercise the live provisioning path by seeding a fake repo-root
   * `node_modules/.bin/tsx` before running bootstrap, then asserting
   * the symlink lands at `<worktree>/node_modules` and resolves to
   * the seeded target.
   */

  it("DX-242: bootstrap symlinks <worktree>/node_modules → <repoRoot>/node_modules when seeded", async () => {
    // Seed a fake repo-root node_modules with the tsx bin the helper's
    // fail-loud check expects. The contents don't have to be a real
    // tsx — the helper only checks existence.
    mkdirSync(join(repoDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(
      join(repoDir, "node_modules", ".bin", "tsx"),
      "#!/bin/sh\necho fake-tsx\n",
      { mode: 0o755 },
    );

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const link = join(
      repoDir,
      ".danxbot",
      "worktrees",
      "alice",
      "node_modules",
    );
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // realpath canonicalizes through any host symlinks; both sides
    // resolve to the same on-disk inode.
    expect(realpathSync(link)).toBe(
      realpathSync(join(repoDir, "node_modules")),
    );
    // And the load-bearing assertion: tsx resolves through the symlink
    // from the worktree's cwd. This is the exact resolution path
    // failing for `npx vitest run` + `spawn(tsxBin)` test scaffolding
    // that DX-242 was filed for.
    expect(
      existsSync(join(link, ".bin", "tsx")),
    ).toBe(true);
  });

  it("DX-242: a tsx-spawning command resolves through the bootstrap-provisioned link", async () => {
    // The exact failure DX-242 was filed for: integration test
    // scaffolding spawns `<worktree>/node_modules/.bin/tsx` (and the
    // fake-claude / dispatch-pipeline tests do the same) and ENOENTs
    // because git worktree add did not provision node_modules. After
    // the fix, the bin resolves through the symlink and the spawn
    // exits cleanly.
    mkdirSync(join(repoDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(
      join(repoDir, "node_modules", ".bin", "tsx"),
      "#!/bin/sh\necho fake-tsx-ok\nexit 0\n",
      { mode: 0o755 },
    );

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const tsxBin = join(
      repoDir,
      ".danxbot",
      "worktrees",
      "alice",
      "node_modules",
      ".bin",
      "tsx",
    );

    // Spawn the bin directly from the worktree-resolved path. No
    // ENOENT — the symlink resolves the lookup.
    const stdout = execFileSync(tsxBin, [], { encoding: "utf-8" });
    expect(stdout.trim()).toBe("fake-tsx-ok");
  });

  it("DX-242: validate() silently re-provisions a missing node_modules symlink before reading git state", async () => {
    // Production repos gitignore `node_modules` so the worktree's
    // symlink is never untracked. Mirror that in the test fixture so
    // validate() can return clean after re-provisioning.
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n");
    git(repoDir, "add", ".gitignore");
    git(repoDir, "commit", "-m", "ignore node_modules");
    git(repoDir, "push", "origin", "main");

    mkdirSync(join(repoDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(
      join(repoDir, "node_modules", ".bin", "tsx"),
      "#!/bin/sh\necho fake-tsx\n",
      { mode: 0o755 },
    );

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const link = join(
      repoDir,
      ".danxbot",
      "worktrees",
      "alice",
      "node_modules",
    );
    rmSync(link, { force: true });
    expect(existsSync(link)).toBe(false);

    // validate is supposed to be read-only at the contract level, but
    // it ALSO calls `provisionWorktreeArtifacts` internally to
    // self-heal before reading git state (node_modules here, .env via
    // the umbrella's second leg — see DX-244 tests below). The return
    // value remains the git-state shape; the side effect is repair.
    const result = await wm.validate(ctx(), "alice");
    expect(result.state).toBe("clean");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("DX-242: resetClean() re-provisions node_modules after the reset (operator-driven `git clean -fdx` heal)", async () => {
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n");
    git(repoDir, "add", ".gitignore");
    git(repoDir, "commit", "-m", "ignore node_modules");
    git(repoDir, "push", "origin", "main");

    mkdirSync(join(repoDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(
      join(repoDir, "node_modules", ".bin", "tsx"),
      "#!/bin/sh\necho fake-tsx\n",
      { mode: 0o755 },
    );

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const link = join(
      repoDir,
      ".danxbot",
      "worktrees",
      "alice",
      "node_modules",
    );
    rmSync(link, { force: true });

    // resetClean's primary contract is the git reset; the post-reset
    // re-provisioning is the secondary side effect we're asserting.
    await wm.resetClean(ctx(), "alice");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(
      realpathSync(join(repoDir, "node_modules")),
    );
  });

  it("DX-242: ensureProvisioned heals an existing worktree that pre-dates the fix", async () => {
    // Bootstrap creates the worktree; remove the symlink to simulate
    // an existing worktree from before the fix landed (or to simulate
    // an operator who ran `git clean -fdx` inside the worktree).
    mkdirSync(join(repoDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(
      join(repoDir, "node_modules", ".bin", "tsx"),
      "#!/bin/sh\necho fake-tsx\n",
      { mode: 0o755 },
    );

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const link = join(
      repoDir,
      ".danxbot",
      "worktrees",
      "alice",
      "node_modules",
    );
    expect(existsSync(link)).toBe(true);
    rmSync(link, { force: true });
    expect(existsSync(link)).toBe(false);

    // Now exercise the boot-side repair path. ensureProvisioned must
    // restore the symlink without redoing bootstrap.
    await wm.ensureProvisioned(ctx(), "alice");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(
      realpathSync(join(repoDir, "node_modules")),
    );
  });

  // ============================================================
  // DX-244 — .env provisioning, end-to-end against real fs
  // ============================================================

  /**
   * Same pattern as the DX-242 tests above: the standard scenarios
   * have no `<repoDir>/.env`, so the provisioning helper silently
   * no-ops (preserving compat with existing fixtures). These tests
   * seed a fake repo-root `.env` first and assert the symlink lands
   * at `<worktree>/.env` resolving to that target.
   */

  it("DX-244: bootstrap symlinks <worktree>/.env → <repoRoot>/.env when seeded", async () => {
    writeFileSync(
      join(repoDir, ".env"),
      "DXTEST_BOOT=ok\nDANXBOT_DB_USER=fake\n",
    );

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const link = join(repoDir, ".danxbot", "worktrees", "alice", ".env");
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(repoDir, ".env")));
    // Load-bearing assertion: the symlink resolves the same content
    // a `npx vitest run` from the worktree's cwd would read via the
    // setup file. This is the exact resolution path that fails
    // pre-DX-244 with "Missing required environment variable:
    // DANXBOT_DB_USER".
    expect(readFileSync(link, "utf-8")).toBe(
      "DXTEST_BOOT=ok\nDANXBOT_DB_USER=fake\n",
    );
  });

  it("DX-244: bootstrap is a silent no-op for .env when the repo root has none", async () => {
    // Mirrors the node_modules fixture-compat behavior: a missing
    // repo-root .env is fine (CI / fresh clones / legacy fixtures);
    // bootstrap creates the worktree without throwing and without
    // creating a broken symlink.
    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const link = join(repoDir, ".danxbot", "worktrees", "alice", ".env");
    expect(existsSync(link)).toBe(false);
  });

  it("DX-244: bootstrap is idempotent for .env — second run keeps the same symlink", async () => {
    writeFileSync(join(repoDir, ".env"), "DXTEST_IDEMPOTENT=1\n");

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");
    const link = join(repoDir, ".danxbot", "worktrees", "alice", ".env");
    const targetBefore = realpathSync(link);

    await wm.bootstrap(ctx(), "alice");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(targetBefore);
  });

  it("DX-244: validate() silently re-provisions a missing .env symlink before reading git state", async () => {
    // Mirror the DX-242 .gitignore-based fixture so the worktree
    // stays clean after the symlink is in place.
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n.env\n");
    git(repoDir, "add", ".gitignore");
    git(repoDir, "commit", "-m", "ignore node_modules + .env");
    git(repoDir, "push", "origin", "main");

    writeFileSync(join(repoDir, ".env"), "DXTEST_VALIDATE=ok\n");

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const link = join(repoDir, ".danxbot", "worktrees", "alice", ".env");
    rmSync(link, { force: true });
    expect(existsSync(link)).toBe(false);

    const result = await wm.validate(ctx(), "alice");
    expect(result.state).toBe("clean");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(repoDir, ".env")));
  });

  it("DX-244: resetClean() re-provisions .env after the reset (operator-driven `git clean -fdx` heal)", async () => {
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n.env\n");
    git(repoDir, "add", ".gitignore");
    git(repoDir, "commit", "-m", "ignore node_modules + .env");
    git(repoDir, "push", "origin", "main");

    writeFileSync(join(repoDir, ".env"), "DXTEST_RESET=ok\n");

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const link = join(repoDir, ".danxbot", "worktrees", "alice", ".env");
    rmSync(link, { force: true });

    await wm.resetClean(ctx(), "alice");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(repoDir, ".env")));
  });

  it("DX-244: ensureProvisioned heals an existing worktree's missing .env symlink", async () => {
    writeFileSync(join(repoDir, ".env"), "DXTEST_ENSURE=ok\n");

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    const link = join(repoDir, ".danxbot", "worktrees", "alice", ".env");
    expect(existsSync(link)).toBe(true);
    rmSync(link, { force: true });
    expect(existsSync(link)).toBe(false);

    await wm.ensureProvisioned(ctx(), "alice");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(join(repoDir, ".env")));
  });

  it("DX-244: ensureProvisioned replaces a stale non-symlink .env (e.g. operator copied a real file in)", async () => {
    writeFileSync(join(repoDir, ".env"), "DXTEST_REPLACE=fresh\n");

    const wm = createWorktreeManager(defaultGitRunner);
    await wm.bootstrap(ctx(), "alice");

    // Operator (or a buggy script) replaced the symlink with a real
    // file containing stale content. The next ensureProvisioned (or
    // validate / resetClean) must replace it with the symlink — leaving
    // the stale file would mean the worktree's env values diverge from
    // the canonical .env every time a secret rotates.
    const link = join(repoDir, ".danxbot", "worktrees", "alice", ".env");
    rmSync(link, { force: true });
    writeFileSync(link, "DXTEST_REPLACE=stale\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);

    await wm.ensureProvisioned(ctx(), "alice");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf-8")).toBe("DXTEST_REPLACE=fresh\n");
  });

  it("bootstrap fails when ctx.hostPath does not resolve to a git repo", async () => {
    // Defends the swap in worktree-manager.ts — git invocations use
    // ctx.hostPath. If the swap regressed back to ctx.localPath, this
    // test would pass when it shouldn't (bootstrap would succeed via
    // localPath even with a bogus hostPath).
    const wm = createWorktreeManager(defaultGitRunner);
    const bogus = join(workArea, "does-not-exist");
    const c = makeRepoContext({ localPath: repoDir, hostPath: bogus });
    await expect(wm.bootstrap(c, "alice")).rejects.toThrow();
  });
});
