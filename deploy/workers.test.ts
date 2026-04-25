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

  it("injects CLAUDE_PROJECTS_DIR pointing at the per-repo host dir so each worker writes JSONL under its OWN repo's claude-projects/ — the dashboard mounts each repo's dir under a namespaced alias for path-resolver lookups (Trello cjAyJpgr)", () => {
    // Pre-cjAyJpgr: every worker had `CLAUDE_PROJECTS_DIR=/danxbot/claude-projects` (one shared host dir).
    // The dashboard mounted that single source under multiple per-repo namespaces, but workers
    // landing in the same encoded-cwd subdir created cross-repo state visibility and complicated
    // dev parity (where workers wrote to repos/danxbot/claude-projects/ regardless of repo).
    // Per-repo paths fix both. The env var stays as a transitional bridge until every connected
    // repo's worker compose file switches to a static `../../claude-projects` mount; once that
    // ships, the var can be removed from this prefix entirely.
    const a = buildLaunchCommand({ name: "app", url: "x", workerPort: 5561 }, ENV);
    expect(a).toContain("CLAUDE_PROJECTS_DIR='/danxbot/repos/app/claude-projects'");
    const gpt = buildLaunchCommand({ name: "gpt-manager", url: "x", workerPort: 5562 }, ENV);
    expect(gpt).toContain("CLAUDE_PROJECTS_DIR='/danxbot/repos/gpt-manager/claude-projects'");
    // Regression guard: the old shared path must NOT appear.
    expect(a).not.toContain("CLAUDE_PROJECTS_DIR='/danxbot/claude-projects'");
    expect(gpt).not.toContain("CLAUDE_PROJECTS_DIR='/danxbot/claude-projects'");
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

  function captureRemote(): { calls: string[]; streamingCalls: string[]; remote: RemoteHost } {
    const calls: string[] = [];
    const streamingCalls: string[] = [];
    const remote = {
      sshRun: (cmd: string) => calls.push(cmd),
      sshRunStreaming: (cmd: string) => streamingCalls.push(cmd),
    } as unknown as RemoteHost;
    return { calls, streamingCalls, remote };
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
    const { calls, streamingCalls, remote } = captureRemote();
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

    // Order matters — chown must run BEFORE the worker compose `up`, otherwise
    // Docker auto-creates the bind source as root-owned and chown can't catch
    // up before the first JSONL write fails. We assert each repo's mkdir/chown
    // appears in `sshRun` AND its corresponding compose-up appears later in
    // `sshRunStreaming` (the two channels are separate; the cross-channel
    // sequence is implicit in the loop body).
    expect(streamingCalls.some((c) => c.includes("worker-danxbot up -d"))).toBe(true);
    expect(streamingCalls.some((c) => c.includes("worker-gpt-manager up -d"))).toBe(true);
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
