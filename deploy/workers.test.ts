import { describe, it, expect } from "vitest";
import { buildLaunchCommand, buildStopCommand } from "./workers.js";

const ENV = {
  workerImage: "123.dkr.ecr.us-east-1.amazonaws.com/prod:latest",
  claudeAuthDir: "/danxbot/claude-auth",
};

describe("worker commands", () => {
  it("builds a compose up command scoped to the repo", () => {
    expect(buildLaunchCommand({ name: "app", url: "x" }, ENV)).toContain(
      "-f /danxbot/repos/app/.danxbot/config/compose.yml -p worker-app up -d --remove-orphans",
    );
  });

  it("injects DANXBOT_WORKER_IMAGE + CLAUDE_AUTH_DIR env vars", () => {
    const cmd = buildLaunchCommand({ name: "app", url: "x" }, ENV);
    expect(cmd).toContain(
      `DANXBOT_WORKER_IMAGE='123.dkr.ecr.us-east-1.amazonaws.com/prod:latest'`,
    );
    expect(cmd).toContain(`CLAUDE_AUTH_DIR='/danxbot/claude-auth'`);
  });

  it("uses --env-file /danxbot/.env so worker compose sees shared vars", () => {
    const cmd = buildLaunchCommand({ name: "app", url: "x" }, ENV);
    expect(cmd).toContain("--env-file /danxbot/.env");
  });

  it("builds a matching stop command", () => {
    expect(buildStopCommand({ name: "app", url: "x" })).toBe(
      "docker compose -p worker-app down",
    );
  });

  it("two repos get independently-named compose projects", () => {
    const a = buildLaunchCommand({ name: "repo-a", url: "x" }, ENV);
    const b = buildLaunchCommand({ name: "repo-b", url: "x" }, ENV);
    expect(a).toContain("-p worker-repo-a");
    expect(b).toContain("-p worker-repo-b");
    expect(a).not.toContain("worker-repo-b");
  });
});
