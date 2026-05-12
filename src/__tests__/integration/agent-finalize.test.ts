/**
 * Integration tests for `src/inject/scripts/agent-finalize.sh`.
 *
 * The script is the agent's per-dispatch completion helper — it runs
 * inside an agent's persistent worktree at
 * `<repo>/.danxbot/worktrees/<agent>/` and squashes the agent branch
 * onto `origin/main` with a Conventional Commits message, retrying on
 * push race up to 5 times (DX-162 / multi-worker dispatch epic
 * DX-158).
 *
 * Tests use a bare origin + the agent's worktree (cloned + branch
 * checked out as `<agent>`) so every git operation in the script
 * exercises real refspecs against a real remote. The "push race"
 * scenarios use a sibling clone that pushes between our fetch + push
 * to drive the rebase loop.
 *
 * Skip-on-no-git mirrors the worktree-manager integration test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const D = hasGit ? describe : describe.skip;

// Resolve to the in-repo source script. Tests copy this into each
// tmpdir's `.danxbot/scripts/` so the invocation matches the way the
// script lands at runtime (the inject pipeline mirrors it there on
// every cron tick — see `injectDanxbotScripts` in src/inject/sync.ts).
const SCRIPT_SOURCE = resolve(
  __dirname,
  "..",
  "..",
  "inject",
  "scripts",
  "agent-finalize.sh",
);

D("agent-finalize.sh (integration, real git)", () => {
  let workArea: string;
  let originDir: string;
  let repoDir: string;
  let worktreePath: string;
  let scriptPath: string;
  const AGENT = "alice";
  const CARD = "DX-1";

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf-8" });
  }

  function configureGitIdentity(cwd: string): void {
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "test"], {
      cwd,
      stdio: "ignore",
    });
  }

  /**
   * Run the script with the given args. Returns exit code + stdout +
   * stderr + a `succeeded` shorthand. We use `spawnSync` (not
   * `execFileSync`) so non-zero exits don't throw — we want to assert
   * on the exit code directly.
   */
  function runScript(...args: string[]) {
    const result = spawnSync("bash", [scriptPath, ...args], {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    return {
      code: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      succeeded: result.status === 0,
    };
  }

  beforeEach(() => {
    workArea = mkdtempSync(join(tmpdir(), "danxbot-finalize-"));
    originDir = join(workArea, "origin.git");
    repoDir = join(workArea, "checkout");

    // Bare origin with one seed commit on main.
    execFileSync("git", ["init", "--bare", "--initial-branch=main", originDir], {
      stdio: "ignore",
    });
    const seed = join(workArea, "seed");
    execFileSync("git", ["clone", originDir, seed], { stdio: "ignore" });
    configureGitIdentity(seed);
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

    // Worker's "main checkout" — the parent the worktree branches off.
    execFileSync("git", ["clone", originDir, repoDir], { stdio: "ignore" });
    configureGitIdentity(repoDir);

    // Add the agent worktree at <repo>/.danxbot/worktrees/<agent>/
    // with branch `<agent>` based on origin/main — same shape
    // WorktreeManager.bootstrap() produces in production.
    worktreePath = join(repoDir, ".danxbot", "worktrees", AGENT);
    mkdirSync(join(repoDir, ".danxbot", "worktrees"), { recursive: true });
    execFileSync(
      "git",
      ["worktree", "add", "-B", AGENT, worktreePath, "origin/main"],
      { cwd: repoDir, stdio: "ignore" },
    );
    configureGitIdentity(worktreePath);

    // Mirror the script into <repo>/.danxbot/scripts/ — same place
    // injectDanxbotScripts puts it in production.
    const scriptsDir = join(repoDir, ".danxbot", "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    scriptPath = join(scriptsDir, "agent-finalize.sh");
    cpSync(SCRIPT_SOURCE, scriptPath);
    execFileSync("chmod", ["+x", scriptPath], { stdio: "ignore" });
  });

  afterEach(() => {
    rmSync(workArea, { recursive: true, force: true });
  });

  // ============================================================
  // Happy path
  // ============================================================

  it("happy path: dirty file → WIP commit → rebase → squash → push; exit 0; output contains PUSHED <sha>", () => {
    writeFileSync(join(worktreePath, "feature.ts"), "export const x = 1;\n");
    const result = runScript(AGENT, CARD, "Add feature x", "Added feature.ts");

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^PUSHED [0-9a-f]{40}/m);

    // Origin/main must now contain the squash commit.
    const log = git(originDir, "log", "--format=%s%n%b", "main", "-1");
    expect(log.split("\n")[0]).toBe(`feat(${CARD}): Add feature x`);
    expect(log).toContain("- Added feature.ts");
  });

  it("happy path with multiple bullets: each bullet appears on its own line in the commit body", () => {
    writeFileSync(join(worktreePath, "a.ts"), "// a\n");
    const result = runScript(
      AGENT,
      CARD,
      "Multi-bullet card",
      "First bullet",
      "Second bullet",
      "Third bullet",
    );

    expect(result.code).toBe(0);
    const log = git(originDir, "log", "--format=%B", "main", "-1");
    expect(log).toContain(`feat(${CARD}): Multi-bullet card`);
    expect(log).toContain("- First bullet");
    expect(log).toContain("- Second bullet");
    expect(log).toContain("- Third bullet");
  });

  it("happy path with zero bullets: header-only commit (no bullet body)", () => {
    writeFileSync(join(worktreePath, "a.ts"), "// a\n");
    const result = runScript(AGENT, CARD, "Header only");

    expect(result.code).toBe(0);
    const log = git(originDir, "log", "--format=%s", "main", "-1");
    expect(log.trim()).toBe(`feat(${CARD}): Header only`);
  });

  // ============================================================
  // Branch state after success
  // ============================================================

  it("after success the agent branch is reset to origin/main (clean for next dispatch)", () => {
    writeFileSync(join(worktreePath, "feature.ts"), "export const x = 1;\n");
    const result = runScript(AGENT, CARD, "Add feature x", "Added feature.ts");
    expect(result.code).toBe(0);

    // Agent branch HEAD must equal origin/main.
    const branchSha = git(worktreePath, "rev-parse", "HEAD").trim();
    const originSha = git(originDir, "rev-parse", "main").trim();
    expect(branchSha).toBe(originSha);

    // Working tree clean.
    expect(git(worktreePath, "status", "--porcelain").trim()).toBe("");
  });

  it("after success origin/main is exactly one commit ahead of the pre-run state", () => {
    const originBefore = git(originDir, "rev-parse", "main").trim();
    writeFileSync(join(worktreePath, "feature.ts"), "x\n");
    const result = runScript(AGENT, CARD, "title", "bullet");
    expect(result.code).toBe(0);

    const originAfter = git(originDir, "rev-parse", "main").trim();
    expect(originAfter).not.toBe(originBefore);
    const distance = git(
      originDir,
      "rev-list",
      "--count",
      `${originBefore}..${originAfter}`,
    ).trim();
    expect(distance).toBe("1");
  });

  // ============================================================
  // Sanity check (wrong branch)
  // ============================================================

  it("exits 65 (wrong-branch sentinel, distinct from rebase-conflict 1) when invoked on a branch that doesn't match the agent name", () => {
    // Move HEAD off the agent branch (detach). The script's first
    // sanity gate must catch it before any commit/push. Exit 65 is
    // distinct from 1 (rebase conflict) so the SKILL routes the agent
    // to "investigate the worktree" not "git rebase --continue".
    execFileSync("git", ["checkout", "--detach", "HEAD"], {
      cwd: worktreePath,
      stdio: "ignore",
    });
    const result = runScript(AGENT, CARD, "title", "bullet");
    expect(result.code).toBe(65);
    expect(result.stderr).toContain("expected branch 'alice'");
    // Origin must NOT have advanced.
    const originLog = git(originDir, "log", "--format=%s", "main");
    expect(originLog.trim()).toBe("seed");
  });

  // ============================================================
  // Rebase conflict (exit 1)
  // ============================================================

  it("rebase conflict path: exits 1 (distinct from wrong-branch 65 / usage 64) when origin/main + agent branch modify the same line", () => {
    // Simulate a conflict: a sibling clone pushes a change to README,
    // and the agent branch ALSO modifies README on the same line.
    // The rebase in the script will conflict.
    const sib = join(workArea, "sibling");
    execFileSync("git", ["clone", originDir, sib], { stdio: "ignore" });
    configureGitIdentity(sib);
    writeFileSync(join(sib, "README.md"), "main-side change\n");
    execFileSync("git", ["add", "."], { cwd: sib, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main-side"], {
      cwd: sib,
      stdio: "ignore",
    });
    execFileSync("git", ["push", "origin", "main"], {
      cwd: sib,
      stdio: "ignore",
    });

    // Agent edits the same line of README.
    writeFileSync(join(worktreePath, "README.md"), "agent-side change\n");

    const result = runScript(AGENT, CARD, "Title", "bullet");
    expect(result.code).toBe(1);
    // git rebase should report the conflict on stderr (the actual
    // text varies by git version; the exit code is the contract).
    // Origin must NOT have a `feat(DX-1)` commit.
    const originLog = git(originDir, "log", "--format=%s", "main");
    expect(originLog).not.toContain(`feat(${CARD})`);
  });

  // ============================================================
  // Push race — succeeds within retries
  // ============================================================

  it("push race that resolves within retries: succeeds; output shows PUSHED <sha>", () => {
    // Race scenario: between the script's first fetch and its first
    // push attempt, origin/main jumps forward by an external commit
    // touching a DIFFERENT file (so rebase succeeds). The script's
    // until-loop fetches + rebases + retries; on the second attempt
    // the push fast-forwards origin/main onto the squash commit.
    //
    // Mechanics: a client-side `pre-push` hook in the WORKTREE's git
    // dir fires before each push attempt. On the FIRST fire, the
    // hook pushes a sibling clone's commit to origin/main (advancing
    // the remote) and then self-deletes. The agent's first push then
    // proceeds and fails as non-fast-forward (origin/main moved
    // between fetch + push). The until-loop retries: fetch sees the
    // new origin/main, rebases the squash commit onto it, second
    // push fast-forwards. Client-side hooks don't trigger git's
    // quarantine environment (which forbids ref updates inside
    // pre-receive hooks on the server), so this is the reliable
    // injection point.
    const sib = join(workArea, "sibling-race");
    execFileSync("git", ["clone", originDir, sib], { stdio: "ignore" });
    configureGitIdentity(sib);
    writeFileSync(join(sib, "sib.txt"), "sibling change\n");
    execFileSync("git", ["add", "."], { cwd: sib, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "sibling change"], {
      cwd: sib,
      stdio: "ignore",
    });

    // Hooks live in the COMMON git dir (shared by every worktree),
    // not in the worktree-specific gitdir. `git rev-parse
    // --git-common-dir` resolves to `<repo>/.git/` even when run from
    // inside a worktree.
    const commonGitDir = execFileSync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: worktreePath, encoding: "utf-8" },
    ).trim();
    const hookDir = join(commonGitDir, "hooks");
    mkdirSync(hookDir, { recursive: true });
    const hookPath = join(hookDir, "pre-push");
    const markerPath = join(workArea, "pre-push-fired");
    const hookLogPath = join(workArea, "pre-push.log");
    writeFileSync(
      hookPath,
      [
        "#!/usr/bin/env bash",
        // Git invokes pre-push with GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE
        // / GIT_PREFIX pointing at the AGENT's repo. If we don't strip them
        // before running git from inside the sibling clone, the inner push
        // operates on the agent repo (not the sibling), the test never
        // simulates a real race, and the agent's first push fast-forwards
        // origin to the agent's HEAD — losing the "sibling change" commit
        // the test expects to see in the final origin/main log.
        "unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_NAMESPACE GIT_QUARANTINE_PATH GIT_PUSH_OPTION_COUNT GIT_INTERNAL_GETTEXT_TEST_FALLBACKS",
        `touch ${markerPath}`,
        `echo "hook fired at $(date)" >> ${hookLogPath}`,
        `cd ${sib} || { echo "cd failed" >> ${hookLogPath}; exit 0; }`,
        `git push origin main >> ${hookLogPath} 2>&1 || echo "push failed code $?" >> ${hookLogPath}`,
        `echo "post-push origin main: $(cd ${originDir} && git rev-parse main)" >> ${hookLogPath}`,
        `rm -f ${hookPath}`,
        "exit 0",
      ].join("\n"),
    );
    execFileSync("chmod", ["+x", hookPath], { stdio: "ignore" });

    writeFileSync(join(worktreePath, "feature.ts"), "x\n");
    const result = runScript(AGENT, CARD, "title", "bullet");
    const fs = require("node:fs");
    const hookLog = fs.existsSync(hookLogPath)
      ? fs.readFileSync(hookLogPath, "utf-8")
      : "(no log)";
    const diag = `\n--- script stdout ---\n${result.stdout}\n--- script stderr ---\n${result.stderr}\n--- hook fired? ---\n${fs.existsSync(markerPath)}\n--- hook log ---\n${hookLog}\n`;
    expect(result.code, diag).toBe(0);
    expect(result.stdout, diag).toMatch(/^PUSHED [0-9a-f]{40}/m);

    // Origin/main now has both the sibling change AND the squash commit.
    const log = git(originDir, "log", "--format=%s", "main");
    expect(log, diag).toContain(`feat(${CARD}): title`);
    expect(log, diag).toContain("sibling change");
  });

  // ============================================================
  // Push race exhaustion (exit 2)
  // ============================================================

  it("5 consecutive push rejections: exit 2; stderr contains PUSH_RACE_EXHAUSTED; pre-receive hook fires exactly 5 times (retry budget pinned); origin/main is byte-identical to its pre-run state", () => {
    // pre-receive hook that ALWAYS rejects pushes to main AND increments
    // a counter file on every fire. The script retries 5 times then
    // bails with exit 2 — the counter pins the off-by-one budget so a
    // future regression to 4 or 6 retries fails loudly here.
    const counterPath = join(workArea, "pre-receive-fires");
    writeFileSync(counterPath, "");
    const hookPath = join(originDir, "hooks", "pre-receive");
    writeFileSync(
      hookPath,
      [
        "#!/usr/bin/env bash",
        `echo x >> ${counterPath}`,
        "exit 1",
      ].join("\n"),
    );
    execFileSync("chmod", ["+x", hookPath], { stdio: "ignore" });

    const originBefore = git(originDir, "rev-parse", "main").trim();
    writeFileSync(join(worktreePath, "feature.ts"), "x\n");
    const result = runScript(AGENT, CARD, "title", "bullet");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("PUSH_RACE_EXHAUSTED");

    // Origin/main has NOT advanced.
    const log = git(originDir, "log", "--format=%s", "main");
    expect(log).not.toContain(`feat(${CARD})`);
    // Byte-identical to pre-run sha — catches a regression where a
    // partial push leaks even though the headline assertions pass.
    const originAfter = git(originDir, "rev-parse", "main").trim();
    expect(originAfter).toBe(originBefore);

    // Hook fired exactly 5 times — the documented retry budget. Pins
    // the off-by-one regression surface.
    const fires = readFileSync(counterPath, "utf-8")
      .split("\n")
      .filter(Boolean).length;
    expect(fires).toBe(5);
  });

  // ============================================================
  // Argument validation
  // ============================================================

  it("exits 64 (EX_USAGE) with usage on stderr when called without enough arguments", () => {
    const result = runScript(AGENT, CARD); // missing title
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("Usage:");
  });

  it("exits 64 when card id does not match <PREFIX>-N (would corrupt the Conventional Commits scope)", () => {
    writeFileSync(join(worktreePath, "f.ts"), "x\n");
    const result = runScript(AGENT, "DX-1; rm -rf /", "title", "bullet");
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("invalid card id");
    // Origin must NOT have advanced.
    expect(git(originDir, "log", "--format=%s", "main").trim()).toBe("seed");
  });

  it("rejects an agent name with path-traversal chars (../) at the wrong-branch gate (rev-parse returns 'alice', not '../evil')", () => {
    writeFileSync(join(worktreePath, "f.ts"), "x\n");
    const result = runScript("../evil", CARD, "title", "bullet");
    // Wrong-branch sentinel — current branch is `alice`, not `../evil`.
    expect(result.code).toBe(65);
    expect(result.stderr).toContain("expected branch '../evil'");
    // Origin/main untouched. No commit landed.
    expect(git(originDir, "log", "--format=%s", "main").trim()).toBe("seed");
  });

  it("preserves shell-special chars in bullet bodies verbatim (no command substitution, no expansion)", () => {
    writeFileSync(join(worktreePath, "f.ts"), "x\n");
    const tricky = "bullet with `whoami` and $HOME and \"quotes\"";
    const result = runScript(AGENT, CARD, "Title", tricky);
    expect(result.code).toBe(0);
    const body = git(originDir, "log", "--format=%B", "main", "-1");
    expect(body).toContain(`- ${tricky}`);
    // The literal `whoami` and `$HOME` strings survive — no expansion.
    expect(body).toContain("`whoami`");
    expect(body).toContain("$HOME");
  });

  it("preserves double-quotes in title verbatim (single-line, no quote-stripping)", () => {
    writeFileSync(join(worktreePath, "f.ts"), "x\n");
    const result = runScript(AGENT, CARD, 'Add "quoted" feature', "bullet");
    expect(result.code).toBe(0);
    const subject = git(originDir, "log", "--format=%s", "main", "-1").trim();
    expect(subject).toBe(`feat(${CARD}): Add "quoted" feature`);
  });

  it("exits 64 when title contains a literal newline (would split the Conventional Commits subject)", () => {
    writeFileSync(join(worktreePath, "f.ts"), "x\n");
    const result = runScript(
      AGENT,
      CARD,
      "Title with a\nembedded newline",
      "bullet",
    );
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("title must be single-line");
    // Origin must NOT have advanced.
    expect(git(originDir, "log", "--format=%s", "main").trim()).toBe("seed");
  });

  // ============================================================
  // No-op (no commits ahead)
  // ============================================================

  it("no commits ahead of origin/main: exit 0; stdout token is NO_OP (not PUSHED <sha>) so retro.commits[] never records an unreachable WIP sha", () => {
    // No file changes, no commits. The script should detect the
    // merge-base == HEAD case and exit 0 cleanly. Stdout MUST be
    // `NO_OP` — emitting `PUSHED <sha>` here was a bug (L4) where
    // the sha was the pre-reset WIP HEAD, not a reachable origin/main
    // commit, so an agent capturing stdout into retro.commits[] would
    // record a sha that wasn't pushed.
    const result = runScript(AGENT, CARD, "title", "bullet");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("no commits ahead");
    // `git rebase` emits "Current branch alice is up to date." to
    // stdout before the script's NO_OP echo runs; assert the literal
    // NO_OP token lands as its own line and that no PUSHED <sha> ever
    // appears (the L4 regression surface).
    expect(result.stdout).toMatch(/^NO_OP$/m);
    expect(result.stdout).not.toMatch(/PUSHED/);
    // Origin/main untouched.
    const log = git(originDir, "log", "--format=%s", "main");
    expect(log.trim()).toBe("seed");
  });

  it("branch already ahead of origin/main with clean working tree: skips WIP-commit branch and squash + push lands one commit", () => {
    // Pre-stage a real commit on the agent branch — no uncommitted
    // changes. Exercises the `[[ -n "$(git status --porcelain)" ]]`
    // branch (line ~59 in the script) where WIP-commit is correctly
    // SKIPPED. Without this test, the skip branch is uncovered: every
    // happy-path test goes through the WIP branch.
    writeFileSync(join(worktreePath, "feature.ts"), "ahead\n");
    execFileSync("git", ["add", "."], { cwd: worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "real ahead commit"], {
      cwd: worktreePath,
      stdio: "ignore",
    });
    expect(git(worktreePath, "status", "--porcelain").trim()).toBe(""); // clean

    const result = runScript(AGENT, CARD, "Title", "bullet");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^PUSHED [0-9a-f]{40}/m);
    // Origin/main got exactly one new commit and it's the squash.
    const log = git(originDir, "log", "--format=%s", "main");
    const lines = log.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(`feat(${CARD}): Title`);
    expect(lines[1]).toBe("seed");
  });

});
