import { describe, it, expect } from "vitest";
import { buildLaunchCommand, buildStopCommand } from "./workers.js";

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

  it("injects CLAUDE_PROJECTS_DIR pointing at the shared host dir so worker JSONL is readable by the dashboard", () => {
    const cmd = buildLaunchCommand(
      { name: "app", url: "x", workerPort: 5561 },
      ENV,
    );
    expect(cmd).toContain("CLAUDE_PROJECTS_DIR='/danxbot/claude-projects'");
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
