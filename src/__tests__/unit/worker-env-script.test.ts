/**
 * Regression test for Trello oGbjLtjN — `make launch-all-workers` was
 * leaking the parent shell's `DANXBOT_WORKER_PORT` into every per-repo
 * `docker compose up`, causing the first repo to win the host bind and
 * the rest to fail with "port is already allocated".
 *
 * Both `make launch-worker` and `make launch-all-workers` now share
 * `scripts/worker-env.sh`, which extracts the port from the per-repo
 * `.danxbot/.env` and explicitly overwrites the export (never inherits).
 *
 * This test source-executes the helper in a `bash -c` subshell with a
 * hostile parent env (`DANXBOT_WORKER_PORT=9999`) and asserts the
 * exported port matches the per-repo file, NOT the inherited shell
 * value. It also verifies the three sibling exports (DANXBOT_REPO_ROOT,
 * CLAUDE_AUTH_DIR, CLAUDE_PROJECTS_DIR) are populated so the two
 * targets cannot drift on those either.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HELPER = resolve(__dirname, "../../../scripts/worker-env.sh");

interface RunArgs {
  repo: string;
  envFiles: Record<string, string>;
  shellEnv?: Record<string, string>;
  /** Skip creating the danxbot/claude-auth and claude-projects scaffolding */
  skipDanxbotScaffold?: boolean;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  vars: Record<string, string>;
}

function setupRepoTree(args: RunArgs): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-env-test-"));
  for (const [repo, content] of Object.entries(args.envFiles)) {
    const repoPath = join(dir, "repos", repo, ".danxbot");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, ".env"), content);
  }
  if (!args.skipDanxbotScaffold) {
    mkdirSync(join(dir, "repos", "danxbot", "claude-auth"), { recursive: true });
    mkdirSync(join(dir, "repos", "danxbot", "claude-projects"), { recursive: true });
  }
  return dir;
}

function runHelper(args: RunArgs): RunResult {
  const dir = setupRepoTree(args);
  // Source the helper, then dump exported vars one-per-line so the
  // test can parse them deterministically. `printf` (not echo) avoids
  // any shell variant differences in newline handling.
  const script = [
    `cd ${dir}`,
    `export REPOS_DIR=./repos`,
    `if . ${HELPER} ${args.repo}; then`,
    `  printf 'OK\\n'`,
    `  printf 'DANXBOT_WORKER_PORT=%s\\n' "$DANXBOT_WORKER_PORT"`,
    `  printf 'DANXBOT_REPO_ROOT=%s\\n' "$DANXBOT_REPO_ROOT"`,
    `  printf 'CLAUDE_AUTH_DIR=%s\\n' "$CLAUDE_AUTH_DIR"`,
    `  printf 'CLAUDE_PROJECTS_DIR=%s\\n' "$CLAUDE_PROJECTS_DIR"`,
    `else`,
    `  printf 'FAIL\\n' >&2`,
    `  exit 1`,
    `fi`,
  ].join("\n");

  // Build a clean env: PATH + HOME from process, plus the provided shellEnv.
  // Do NOT inherit the test runner's variables wholesale — that would
  // smuggle a real DANXBOT_WORKER_PORT in and mask the leak we're testing.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    ...(args.shellEnv ?? {}),
  };

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("bash", ["-c", script], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    stdout = err.stdout?.toString() ?? "";
    stderr = err.stderr?.toString() ?? "";
    exitCode = err.status ?? 1;
  }
  rmSync(dir, { recursive: true, force: true });

  const vars: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  return { stdout, stderr, exitCode, vars };
}

describe("scripts/worker-env.sh", () => {
  it("reads DANXBOT_WORKER_PORT from per-repo .env, IGNORES parent shell value (the oGbjLtjN bug)", () => {
    const result = runHelper({
      repo: "platform",
      envFiles: { platform: "DANXBOT_WORKER_PORT=5560\n" },
      // Hostile shell: simulates a leftover `DANXBOT_WORKER_PORT=9999` from
      // a prior `make launch-worker` in the same shell.
      shellEnv: { DANXBOT_WORKER_PORT: "9999" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.vars.DANXBOT_WORKER_PORT).toBe("5560");
    expect(result.vars.DANXBOT_WORKER_PORT).not.toBe("9999");
  });

  it("exports DANXBOT_REPO_ROOT, CLAUDE_AUTH_DIR, CLAUDE_PROJECTS_DIR for parity with launch-worker", () => {
    const result = runHelper({
      repo: "platform",
      envFiles: { platform: "DANXBOT_WORKER_PORT=5560\n" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.vars.DANXBOT_REPO_ROOT).toMatch(/repos\/platform$/);
    expect(result.vars.CLAUDE_AUTH_DIR).toMatch(/repos\/danxbot\/claude-auth$/);
    expect(result.vars.CLAUDE_PROJECTS_DIR).toMatch(/repos\/danxbot\/claude-projects$/);
  });

  it("each repo gets its own port — sequential sources do not leak between iterations", () => {
    // Simulates the launch-all-workers loop body: source helper for repo
    // A, then for repo B in a fresh subshell. Asserts B's port is B's,
    // not A's. The Makefile uses `( ... )` subshells around each loop
    // iteration; this test verifies the helper's own behavior is
    // idempotent so the subshell isolation is belt-and-suspenders.
    const dir = setupRepoTree({
      repo: "platform",
      envFiles: {
        platform: "DANXBOT_WORKER_PORT=5560\n",
        danxbot: "DANXBOT_WORKER_PORT=5561\n",
        "gpt-manager": "DANXBOT_WORKER_PORT=5562\n",
      },
    });
    try {
      // Three back-to-back subshell sources, each printing the resolved port.
      const script = [
        `cd ${dir}`,
        `export REPOS_DIR=./repos`,
        `( . ${HELPER} platform && printf 'platform=%s\\n' "$DANXBOT_WORKER_PORT" )`,
        `( . ${HELPER} danxbot && printf 'danxbot=%s\\n' "$DANXBOT_WORKER_PORT" )`,
        `( . ${HELPER} gpt-manager && printf 'gpt-manager=%s\\n' "$DANXBOT_WORKER_PORT" )`,
      ].join("\n");

      const out = execFileSync("bash", ["-c", script], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          // Hostile shell — the leak we're guarding against.
          DANXBOT_WORKER_PORT: "9999",
        },
        encoding: "utf8",
      }).toString();
      expect(out).toContain("platform=5560");
      expect(out).toContain("danxbot=5561");
      expect(out).toContain("gpt-manager=5562");
      expect(out).not.toMatch(/=9999/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips surrounding double-quotes from a quoted port value", () => {
    const result = runHelper({
      repo: "platform",
      // Real .env files written by hand often quote string values.
      envFiles: { platform: 'DANXBOT_WORKER_PORT="5560"\n' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.vars.DANXBOT_WORKER_PORT).toBe("5560");
  });

  it("strips surrounding single-quotes from a quoted port value", () => {
    const result = runHelper({
      repo: "platform",
      envFiles: { platform: "DANXBOT_WORKER_PORT='5560'\n" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.vars.DANXBOT_WORKER_PORT).toBe("5560");
  });

  it("strips trailing CRLF carriage return from a Windows-edited .env", () => {
    const result = runHelper({
      repo: "platform",
      envFiles: { platform: "DANXBOT_WORKER_PORT=5560\r\n" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.vars.DANXBOT_WORKER_PORT).toBe("5560");
  });

  it("rejects a non-numeric port value rather than silently exporting garbage", () => {
    const result = runHelper({
      repo: "platform",
      envFiles: { platform: "DANXBOT_WORKER_PORT=not-a-port\n" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/not numeric/);
  });

  it("fails loudly when the danxbot scaffold dirs (claude-auth/claude-projects) are missing rather than exporting empty paths", () => {
    const result = runHelper({
      repo: "platform",
      envFiles: { platform: "DANXBOT_WORKER_PORT=5560\n" },
      skipDanxbotScaffold: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/realpath/);
  });

  it("fails with a clear error when per-repo .env is missing", () => {
    const result = runHelper({
      repo: "no-such-repo",
      envFiles: {},
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/\.danxbot\/\.env/);
  });

  it("fails with a clear error when DANXBOT_WORKER_PORT is missing from the per-repo .env", () => {
    const result = runHelper({
      repo: "platform",
      envFiles: { platform: "SOME_OTHER_VAR=foo\n" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/DANXBOT_WORKER_PORT/);
  });

  it("requires a repo name argument", () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-env-empty-"));
    try {
      const script = [
        `cd ${dir}`,
        `export REPOS_DIR=./repos`,
        `. ${HELPER} || exit 1`,
      ].join("\n");
      let exitCode = 0;
      let stderr = "";
      try {
        execFileSync("bash", ["-c", script], {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "/tmp",
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e: unknown) {
        const err = e as { stderr?: Buffer; status?: number };
        stderr = err.stderr?.toString() ?? "";
        exitCode = err.status ?? 1;
      }
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/repo/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
