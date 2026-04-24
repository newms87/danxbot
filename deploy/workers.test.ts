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

  it("injects CLAUDE_CONFIG_FILE + CLAUDE_CREDS_FILE (derived from claudeAuthDir) so compose files using file-level binds find the right absolute paths", () => {
    // The danxbot repo's own worker uses file-level binds so the
    // container reads LIVE host bytes without a restart (Trello 9ZurZCK2).
    // Deploy must set both vars so prod's `/danxbot/claude-auth/` files are
    // bind-mounted correctly.
    const cmd = buildLaunchCommand({ name: "app", url: "x", workerPort: 5561 }, ENV);
    expect(cmd).toContain(`CLAUDE_CONFIG_FILE='/danxbot/claude-auth/.claude.json'`);
    expect(cmd).toContain(`CLAUDE_CREDS_FILE='/danxbot/claude-auth/.credentials.json'`);
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
