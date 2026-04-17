import { describe, it, expect } from "vitest";
import { buildCloneOrPullCommand } from "./bootstrap-repos.js";

describe("buildCloneOrPullCommand", () => {
  it("emits clone-or-pull with token substituted into URL", () => {
    const cmd = buildCloneOrPullCommand(
      { name: "app", url: "https://github.com/x/app.git" },
      "ghp_xxx",
    );
    expect(cmd).toContain("if [ -d /danxbot/repos/app ]");
    expect(cmd).toContain(
      "https://x-access-token:ghp_xxx@github.com/x/app.git",
    );
    expect(cmd).toContain("git -C /danxbot/repos/app fetch origin main");
    expect(cmd).toContain(
      "git -C /danxbot/repos/app reset --hard origin/main",
    );
    expect(cmd).toContain("git clone");
  });

  it("rejects non-https github URLs (we only support github.com HTTPS)", () => {
    expect(() =>
      buildCloneOrPullCommand(
        { name: "app", url: "git@github.com:x/app.git" },
        "t",
      ),
    ).toThrow("Unsupported repo URL");
  });

  it("rejects non-github HTTPS URLs", () => {
    expect(() =>
      buildCloneOrPullCommand(
        { name: "app", url: "https://gitlab.com/x/app.git" },
        "t",
      ),
    ).toThrow("Unsupported repo URL");
  });

  it("chains fetch + reset with && so either failure short-circuits", () => {
    const cmd = buildCloneOrPullCommand(
      { name: "app", url: "https://github.com/x/app.git" },
      "t",
    );
    expect(cmd).toMatch(/fetch origin main && git -C .* reset --hard/);
  });
});
