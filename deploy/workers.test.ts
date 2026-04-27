import { describe, it, expect } from "vitest";
import { buildLaunchCommand, buildStopCommand, launchWorkers } from "./workers.js";
import type { DeployConfig } from "./config.js";
import type { RemoteHost } from "./remote.js";

const ENV = {
  workerImage: "123.dkr.ecr.us-east-1.amazonaws.com/prod:latest",
  claudeAuthDir: "/danxbot/claude-auth",
};

describe("worker commands", () => {
  it("builds a compose up command scoped to the repo", () => {
    expect(buildLaunchCommand({ name: "app", url: "x", workerPort: 5561 }, ENV)).toContain(
      "-f /danxbot/repos/app/.danxbot/config/compose.yml -p worker-app up -d --remove-orphans",
    );
  });

  it("injects DANXBOT_WORKER_IMAGE + CLAUDE_AUTH_DIR env vars", () => {
    const cmd = buildLaunchCommand({ name: "app", url: "x", workerPort: 5561 }, ENV);
    expect(cmd).toContain(
      `DANXBOT_WORKER_IMAGE='123.dkr.ecr.us-east-1.amazonaws.com/prod:latest'`,
    );
    expect(cmd).toContain(`CLAUDE_AUTH_DIR='/danxbot/claude-auth'`);
  });

  it("injects CLAUDE_CONFIG_FILE (file-bind) + CLAUDE_CREDS_DIR (dir-bind) so the danxbot self-ref compose substitutes the right absolute paths", () => {
    // The danxbot repo's own worker uses a SPLIT mount: `.claude.json` is
    // a file-bind (preferences/session metadata — rename staleness on
    // host rotation is acceptable), while `.credentials.json` lives one
    // level down in `.claude/` and is reached via a DIR-bind so host
    // atomic-write rotation (`mv tmp .credentials.json`) is visible
    // inside the container without a worker restart. Trello 0bjFD0a2.
    // Deploy must inject both vars so prod's compose substitutes the
    // canonical paths.
    const cmd = buildLaunchCommand({ name: "app", url: "x", workerPort: 5561 }, ENV);
    expect(cmd).toContain(`CLAUDE_CONFIG_FILE='/danxbot/claude-auth/.claude.json'`);
    expect(cmd).toContain(`CLAUDE_CREDS_DIR='/danxbot/claude-auth/.claude'`);
    // Legacy CLAUDE_CREDS_FILE was a file-bind that pinned the host
    // inode at compose-up; rename-rotation went stale until restart.
    // Replaced by CLAUDE_CREDS_DIR — must NOT regress.
    expect(cmd).not.toContain("CLAUDE_CREDS_FILE");
  });

  it("uses --env-file /danxbot/.env so worker compose sees shared vars", () => {
    const cmd = buildLaunchCommand({ name: "app", url: "x", workerPort: 5561 }, ENV);
    expect(cmd).toContain("--env-file /danxbot/.env");
  });

  it("does NOT inject CLAUDE_PROJECTS_DIR — workers use a static `../../claude-projects` mount in every worker compose (Trello cjAyJpgr)", () => {
    // The env var is dead. Re-introducing it would silently re-enable the
    // pre-cjAyJpgr shared-dir layout on any compose that regresses to
    // `${CLAUDE_PROJECTS_DIR:-...}` — that's the regression this guards.
    const a = buildLaunchCommand({ name: "app", url: "x", workerPort: 5561 }, ENV);
    const gpt = buildLaunchCommand({ name: "gpt-manager", url: "x", workerPort: 5562 }, ENV);
    expect(a).not.toContain("CLAUDE_PROJECTS_DIR");
    expect(gpt).not.toContain("CLAUDE_PROJECTS_DIR");
  });

  it("injects DANXBOT_WORKER_PORT from deploy config (idempotent, no settings.local.json needed)", () => {
    const cmd = buildLaunchCommand(
      { name: "app", url: "x", workerPort: 5571 },
      ENV,
    );
    expect(cmd).toContain("DANXBOT_WORKER_PORT='5571'");
  });

  it("injects DANXBOT_REPOS_BASE='/danxbot/repos' so agent spawn cwd uses container bind-mount path not dev symlinks", () => {
    const cmd = buildLaunchCommand(
      { name: "app", url: "x", workerPort: 5561 },
      ENV,
    );
    expect(cmd).toContain("DANXBOT_REPOS_BASE='/danxbot/repos'");
  });

  // Regression guard for the auX4nTRk fix: the prefix MUST NOT inject
  // DANXBOT_COMMIT. The SHA reaches the runtime via the image-baked ENV
  // (Dockerfile ARG, populated by deploy/build.ts --build-arg). Adding it
  // to the prefix would require the worker compose to interpolate it
  // back, which silently overrides the image-baked value with empty when
  // the host shell doesn't export it.
  it("does NOT inject DANXBOT_COMMIT — image-baked ENV is the single source of truth", () => {
    const cmd = buildLaunchCommand(
      { name: "app", url: "x", workerPort: 5561 },
      ENV,
    );
    expect(cmd).not.toContain("DANXBOT_COMMIT=");
  });

  it("builds a matching stop command", () => {
    expect(buildStopCommand({ name: "app", url: "x" })).toBe(
      "docker compose -p worker-app down",
    );
  });

  it("two repos get independently-named compose projects", () => {
    const a = buildLaunchCommand({ name: "repo-a", url: "x", workerPort: 5561 }, ENV);
    const b = buildLaunchCommand({ name: "repo-b", url: "x", workerPort: 5562 }, ENV);
    expect(a).toContain("-p worker-repo-a");
    expect(b).toContain("-p worker-repo-b");
    expect(a).not.toContain("worker-repo-b");
  });
});

describe("launchWorkers", () => {
  // Build a typed but minimal DeployConfig — only `repos` is read inside
  // `launchWorkers`; the other fields are required by the type but
  // irrelevant to its behavior. Cast keeps the test ergonomic without
  // resorting to `any`.
  function makeConfig(repoNames: string[]): DeployConfig {
    return {
      repos: repoNames.map((name) => ({
        name,
        url: `https://github.com/x/${name}.git`,
        workerPort: 5561,
      })),
    } as unknown as DeployConfig;
  }

  // The `ordered` log captures both channels in invocation order with a
  // channel tag so cross-channel ordering invariants (e.g. mkdir on `sshRun`
  // BEFORE compose-up on `sshRunStreaming`) can be asserted directly.
  // Without this, sshRun/sshRunStreaming land in two separate arrays and
  // a refactor that swapped them would still produce the same per-array
  // contents — making ordering bugs invisible to tests.
  type OrderedCall = { channel: "run" | "streaming"; cmd: string };
  function captureRemote(): {
    calls: string[];
    streamingCalls: string[];
    ordered: OrderedCall[];
    remote: RemoteHost;
  } {
    const calls: string[] = [];
    const streamingCalls: string[] = [];
    const ordered: OrderedCall[] = [];
    const remote = {
      sshRun: (cmd: string) => {
        calls.push(cmd);
        ordered.push({ channel: "run", cmd });
      },
      sshRunStreaming: (cmd: string) => {
        streamingCalls.push(cmd);
        ordered.push({ channel: "streaming", cmd });
      },
    } as unknown as RemoteHost;
    return { calls, streamingCalls, ordered, remote };
  }

  // Regression guard for Trello cjAyJpgr — silent prod failure mode.
  // Pre-fix, every worker mounted the SHARED `/danxbot/claude-projects`
  // and the deploy created that one dir. Per-repo dirs were never created
  // anywhere, and Docker's auto-create-as-root behavior on first compose
  // up would mint them owned by root, blocking the in-container `danxbot`
  // user (UID 1000) from writing JSONL. Without this test, a refactor
  // could drop the new sudo-mkdir+chown step and the symptom (empty
  // dashboard timelines for every non-danxbot dispatch) would only
  // surface in production.
  it("creates each repo's claude-projects host dir owned by UID 1000 BEFORE the per-repo compose up (Trello cjAyJpgr)", () => {
    const { calls, ordered, remote } = captureRemote();
    launchWorkers(remote, makeConfig(["danxbot", "gpt-manager"]), {
      workerImage: "img",
      claudeAuthDir: "/danxbot/claude-auth",
    });

    // Per-repo mkdir+chown line, exact UID 1000:1000 (matches the
    // Dockerfile's `useradd -m danxbot` first non-system uid). A flexible
    // chown (e.g. ubuntu:ubuntu) would silently re-break on hosts where
    // ubuntu != UID 1000, so we pin the literal numeric form.
    expect(calls).toContain(
      "sudo mkdir -p /danxbot/repos/danxbot/claude-projects && sudo chown 1000:1000 /danxbot/repos/danxbot/claude-projects",
    );
    expect(calls).toContain(
      "sudo mkdir -p /danxbot/repos/gpt-manager/claude-projects && sudo chown 1000:1000 /danxbot/repos/gpt-manager/claude-projects",
    );

    // Cross-channel ordering: chown MUST run before compose-up. If compose
    // runs first, Docker auto-creates the bind source as root-owned and the
    // chown can't catch up before the first JSONL write fails. We assert
    // the mkdir's index in the unified log is strictly less than its
    // corresponding compose-up's index, per repo. A swap of the two
    // `remote.*` calls in launchWorkers would flip the indices and fail
    // this assertion — the previous shape (separate `calls`/`streamingCalls`
    // arrays) couldn't catch that swap because each call still landed in
    // its own array.
    for (const repoName of ["danxbot", "gpt-manager"]) {
      const mkdirIdx = ordered.findIndex(
        (c) =>
          c.channel === "run" &&
          c.cmd.includes(`mkdir -p /danxbot/repos/${repoName}/claude-projects`),
      );
      const composeIdx = ordered.findIndex(
        (c) =>
          c.channel === "streaming" &&
          c.cmd.includes(`worker-${repoName} up -d`),
      );
      expect(mkdirIdx, `mkdir for ${repoName} not found in ordered log`).toBeGreaterThanOrEqual(0);
      expect(composeIdx, `compose-up for ${repoName} not found in ordered log`).toBeGreaterThanOrEqual(0);
      expect(
        mkdirIdx < composeIdx,
        `mkdir for ${repoName} (index ${mkdirIdx}) must precede its compose-up (index ${composeIdx})`,
      ).toBe(true);
    }
  });

  it("never creates the legacy shared /danxbot/claude-projects dir — that path is gone (Trello cjAyJpgr)", () => {
    const { calls, remote } = captureRemote();
    launchWorkers(remote, makeConfig(["danxbot"]), {
      workerImage: "img",
      claudeAuthDir: "/danxbot/claude-auth",
    });
    for (const c of calls) {
      // Match only the LEGACY exact source — `/danxbot/repos/<name>/claude-projects`
      // is the new, valid form and must not trigger this guard.
      expect(c).not.toMatch(/mkdir -p \/danxbot\/claude-projects(\s|$)/);
    }
  });
});
