import { describe, it, expect } from "vitest";
import { buildLaunchCommand, buildStopCommand } from "./workers.js";

describe("worker commands", () => {
  it("builds a compose up command scoped to the repo", () => {
    expect(buildLaunchCommand({ name: "app", url: "x" })).toBe(
      "docker compose -f /danxbot/repos/app/.danxbot/config/compose.yml -p worker-app up -d --remove-orphans",
    );
  });

  it("builds a matching stop command", () => {
    expect(buildStopCommand({ name: "app", url: "x" })).toBe(
      "docker compose -p worker-app down",
    );
  });

  it("two repos get independently-named compose projects", () => {
    const a = buildLaunchCommand({ name: "repo-a", url: "x" });
    const b = buildLaunchCommand({ name: "repo-b", url: "x" });
    expect(a).toContain("-p worker-repo-a");
    expect(b).toContain("-p worker-repo-b");
    expect(a).not.toContain("worker-repo-b");
  });
});
