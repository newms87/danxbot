/**
 * Integration test for `make launch-all-workers` — the Trello oGbjLtjN
 * regression.
 *
 * Spawns the real Makefile against a synthetic three-repo project tree
 * and a `docker` shim that captures `$DANXBOT_WORKER_PORT` at the time
 * of each `docker compose up -d` invocation. Asserts each repo's
 * compose was called with its OWN per-repo port, even when the parent
 * shell exports a hostile `DANXBOT_WORKER_PORT=9999`.
 *
 * Without this test, a future refactor could re-introduce the parent
 * shell leak: any change to `launch-all-workers` (or to the shared
 * `scripts/worker-env.sh` it sources) that fails to overwrite
 * `DANXBOT_WORKER_PORT` per iteration would silently put every repo's
 * compose on the same host port. The unit test for `worker-env.sh`
 * verifies the helper itself; this test verifies the Makefile target's
 * loop wires the helper in correctly.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(__dirname, "../../..");
const REAL_MAKEFILE = join(PROJECT_ROOT, "Makefile");
const REAL_WORKER_ENV = join(PROJECT_ROOT, "scripts/worker-env.sh");
const REAL_AUTH_CHECK = join(PROJECT_ROOT, "scripts/check-claude-auth-env.sh");

// `make` is part of the standard host toolchain (every developer has it
// for `make launch-all-workers`) but is intentionally absent from the
// minimal danxbot worker container image. Skip rather than fail when the
// binary is missing so the same suite runs both inside the worker and on
// the host. The unit test for `scripts/worker-env.sh` still covers the
// helper-level guarantees in the worker container.
const MAKE_AVAILABLE = spawnSync("make", ["--version"], { encoding: "utf8" }).status === 0;

interface FakeProject {
  dir: string;
  dockerLog: string;
}

/**
 * Builds a temp project tree with three fake repos and a `docker` shim
 * that logs `$DANXBOT_WORKER_PORT` and the compose project name to a
 * file. Returns the project dir and the docker log path. Caller is
 * responsible for `rmSync(dir, ...)`.
 */
function setupFakeProject(repoPorts: [string, string][]): FakeProject {
  const dir = mkdtempSync(join(tmpdir(), "launch-all-workers-test-"));

  // Synthesize per-repo .env + compose stub for each repo.
  for (const [name, port] of repoPorts) {
    const danxbotDir = join(dir, "repos", name, ".danxbot");
    mkdirSync(join(danxbotDir, "config"), { recursive: true });
    writeFileSync(join(danxbotDir, ".env"), `DANXBOT_WORKER_PORT=${port}\n`);
    // Minimal stub — the docker shim doesn't actually parse it; this just
    // satisfies the Makefile's `[ -f $$COMPOSE_FILE ]` precheck.
    writeFileSync(join(danxbotDir, "config/compose.yml"), "services: {}\n");
  }

  // Phase B: the Makefile reads connected-repo names from
  // deploy/targets/<DANXBOT_TARGET>.yml via `list-target-repos.ts`. The
  // CLI script lives in the real project src/, so symlink the parts the
  // helper transitively imports so `npx tsx src/cli/list-target-repos.ts`
  // resolves cleanly from the temp project dir. Avoids re-shipping
  // node_modules into every fake project.
  symlinkSync(join(PROJECT_ROOT, "src"), join(dir, "src"));
  symlinkSync(join(PROJECT_ROOT, "node_modules"), join(dir, "node_modules"));
  symlinkSync(join(PROJECT_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(PROJECT_ROOT, "tsconfig.json"), join(dir, "tsconfig.json"));

  // Write a `local` target YML listing every fake repo so the loop sees them.
  // worker_port here is irrelevant to this test (the docker shim reads
  // the runtime DANXBOT_WORKER_PORT env which scripts/worker-env.sh
  // exports from each repo's .danxbot/.env), but the YML schema requires
  // it — give each entry an arbitrary valid port.
  const targetsDir = join(dir, "deploy/targets");
  mkdirSync(targetsDir, { recursive: true });
  const targetYml = [
    "name: local",
    "mode: local",
    "repos:",
    ...repoPorts.flatMap(([name, port]) => [
      `  - name: ${name}`,
      `    url: https://example.com/${name}.git`,
      `    worker_port: ${port}`,
    ]),
  ].join("\n");
  writeFileSync(join(targetsDir, "local.yml"), targetYml + "\n");

  // EVERY worker (not just the danxbot one) bind-mounts the danxbot
  // self-host `claude-auth` dir for Claude credentials in local dev,
  // so `scripts/worker-env.sh` realpaths it on every launch — even
  // when invoked as `make launch-worker REPO=platform`. Create it
  // unconditionally so single-repo test scenarios don't trip the
  // helper's realpath check.
  mkdirSync(join(dir, "repos/danxbot/claude-auth"), { recursive: true });

  // Real helper scripts — symlink so a future edit is automatically
  // reflected here.
  mkdirSync(join(dir, "scripts"));
  symlinkSync(REAL_WORKER_ENV, join(dir, "scripts/worker-env.sh"));
  symlinkSync(REAL_AUTH_CHECK, join(dir, "scripts/check-claude-auth-env.sh"));

  // Docker shim. Captures `$DANXBOT_WORKER_PORT` and the `-p` arg so the
  // test can correlate each call with the repo it was for. Must `exec`
  // nothing else — `up -d` is the last arg and the shim simply succeeds.
  const dockerShimDir = join(dir, "shim");
  mkdirSync(dockerShimDir);
  const dockerLog = join(dir, "docker.log");
  const dockerShim = join(dockerShimDir, "docker");
  // Only log `compose ... up` calls; ignore any other docker subcommands
  // that future Makefile edits might introduce so the assertions stay
  // deterministic.
  writeFileSync(
    dockerShim,
    [
      "#!/usr/bin/env bash",
      `LOG="${dockerLog}"`,
      'is_compose=0; is_up=0; project=""',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    compose) is_compose=1 ;;',
      '    up) is_up=1 ;;',
      '  esac',
      'done',
      'if [ "$is_compose" -eq 1 ] && [ "$is_up" -eq 1 ]; then',
      '  while [ $# -gt 0 ]; do',
      '    if [ "$1" = "-p" ]; then project="$2"; break; fi',
      '    shift',
      '  done',
      '  echo "$project DANXBOT_WORKER_PORT=$DANXBOT_WORKER_PORT" >> "$LOG"',
      'fi',
      'exit 0',
    ].join("\n"),
  );
  chmodSync(dockerShim, 0o755);

  return { dir, dockerLog };
}

function runMakeTarget(
  project: FakeProject,
  target: string,
  shellEnv: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    "make",
    ["-f", REAL_MAKEFILE, "-C", project.dir, target],
    {
      env: {
        // Synthetic minimal env: PATH with shim FIRST so `docker` resolves
        // to our logger, plus HOME (realpath needs it on some systems).
        PATH: `${join(project.dir, "shim")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: process.env.HOME ?? "/tmp",
        ...shellEnv,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("make launch-all-workers", () => {
  it.skipIf(!MAKE_AVAILABLE)("each repo's compose is called with its OWN per-repo DANXBOT_WORKER_PORT (resists hostile shell — Trello oGbjLtjN)", () => {
    const project = setupFakeProject([
      ["platform", "5560"],
      ["danxbot", "5561"],
      ["gpt-manager", "5562"],
    ]);
    try {
      const result = runMakeTarget(project, "launch-all-workers", {
        REPOS: "platform:url1,danxbot:url2,gpt-manager:url3",
        // Hostile shell — exactly the leak the bug card describes.
        DANXBOT_WORKER_PORT: "9999",
        // The danxbot leg of the loop runs the auth check; satisfy it.
        CLAUDE_CONFIG_FILE: "/fake/.claude.json",
        CLAUDE_CREDS_DIR: "/fake/.claude",
      });
      expect(result.status, `make stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);

      const logLines = readFileSync(project.dockerLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);

      expect(logLines).toContain("danxbot-worker-platform DANXBOT_WORKER_PORT=5560");
      expect(logLines).toContain("danxbot-worker-danxbot DANXBOT_WORKER_PORT=5561");
      expect(logLines).toContain("danxbot-worker-gpt-manager DANXBOT_WORKER_PORT=5562");

      // The hostile parent value MUST not show up on any compose call.
      for (const line of logLines) {
        expect(line).not.toMatch(/DANXBOT_WORKER_PORT=9999/);
      }
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!MAKE_AVAILABLE)("clean shell — same per-repo binding is preserved when DANXBOT_WORKER_PORT is unset in the parent", () => {
    const project = setupFakeProject([
      ["platform", "5560"],
      ["danxbot", "5561"],
      ["gpt-manager", "5562"],
    ]);
    try {
      const result = runMakeTarget(project, "launch-all-workers", {
        REPOS: "platform:url1,danxbot:url2,gpt-manager:url3",
        CLAUDE_CONFIG_FILE: "/fake/.claude.json",
        CLAUDE_CREDS_DIR: "/fake/.claude",
        // Note: no DANXBOT_WORKER_PORT here — clean parent shell.
      });
      expect(result.status, `make stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);

      const logLines = readFileSync(project.dockerLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);

      expect(logLines).toContain("danxbot-worker-platform DANXBOT_WORKER_PORT=5560");
      expect(logLines).toContain("danxbot-worker-danxbot DANXBOT_WORKER_PORT=5561");
      expect(logLines).toContain("danxbot-worker-gpt-manager DANXBOT_WORKER_PORT=5562");
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!MAKE_AVAILABLE)("aborts the whole target when one repo's helper fails — does NOT silently continue to subsequent repos", () => {
    // Three repos; the middle one has a malformed `.env` (no PORT line).
    // The Makefile's outer `|| exit 1` and the subshell's `set -e` must
    // combine to: (a) start repo A successfully, (b) fail at repo B, (c)
    // NOT start repo C. Without the guards a future edit could silently
    // skip the bad repo and bring up the rest, which would mask
    // configuration errors in CI/dev.
    const project = setupFakeProject([
      ["platform", "5560"],
      ["danxbot", "5561"],
      ["gpt-manager", "5562"],
    ]);
    try {
      // Corrupt the danxbot .env so the helper fails on its iteration.
      writeFileSync(
        join(project.dir, "repos/danxbot/.danxbot/.env"),
        "SOMETHING_ELSE=foo\n",
      );
      const result = runMakeTarget(project, "launch-all-workers", {
        REPOS: "platform:url1,danxbot:url2,gpt-manager:url3",
        CLAUDE_CONFIG_FILE: "/fake/.claude.json",
        CLAUDE_CREDS_DIR: "/fake/.claude",
      });
      expect(result.status, `make stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).not.toBe(0);

      const logLines = readFileSync(project.dockerLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);

      // Repo A ran (loop reached it before the fault).
      expect(logLines).toContain("danxbot-worker-platform DANXBOT_WORKER_PORT=5560");
      // Repo C MUST NOT have run — that's the behavior we're guarding.
      expect(logLines.some((l) => l.startsWith("danxbot-worker-gpt-manager"))).toBe(false);
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!MAKE_AVAILABLE)("make launch-worker REPO=<name> still reads the per-repo .env (no regression in single-repo target)", () => {
    const project = setupFakeProject([["platform", "5560"]]);
    try {
      const result = runMakeTarget(project, "launch-worker", {
        REPO: "platform",
        REPOS: "platform:url1",
        // Hostile shell — same guard for single-repo path.
        DANXBOT_WORKER_PORT: "9999",
      });
      expect(result.status, `make stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);

      const logLines = readFileSync(project.dockerLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);

      expect(logLines).toContain("danxbot-worker-platform DANXBOT_WORKER_PORT=5560");
      for (const line of logLines) {
        expect(line).not.toMatch(/DANXBOT_WORKER_PORT=9999/);
      }
    } finally {
      rmSync(project.dir, { recursive: true, force: true });
    }
  });
});
