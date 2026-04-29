import { describe, it, expect } from "vitest";
import { buildCloneOrPullCommand } from "./bootstrap-repos.js";

describe("buildCloneOrPullCommand", () => {
  it("emits clone-or-pull with token substituted into URL", () => {
    const cmd = buildCloneOrPullCommand(
      { name: "app", url: "https://github.com/x/app.git", branch: "main" },
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

  it("uses the configured branch when not main (e.g. master)", () => {
    // Repos with non-main default branches silently failed before this
    // field existed because the hardcoded `origin/main` resolved to a
    // non-existent ref. The branch is threaded through both fetch and
    // reset so the deploy syncs to whatever branch the repo actually
    // tracks.
    const cmd = buildCloneOrPullCommand(
      {
        name: "legacy",
        url: "https://github.com/x/legacy.git",
        branch: "master",
      },
      "t",
    );
    expect(cmd).toContain("git -C /danxbot/repos/legacy fetch origin master");
    expect(cmd).toContain(
      "git -C /danxbot/repos/legacy reset --hard origin/master",
    );
    expect(cmd).not.toContain("origin/main");
  });

  it("threads branch through fetch and reset for slash-containing branch names", () => {
    // Git allows slashes in branch names (e.g. release branches).
    const cmd = buildCloneOrPullCommand(
      {
        name: "app",
        url: "https://github.com/x/app.git",
        branch: "release/2026.04",
      },
      "t",
    );
    expect(cmd).toContain("fetch origin release/2026.04");
    expect(cmd).toContain("reset --hard origin/release/2026.04");
  });

  it("rejects non-https github URLs (we only support github.com HTTPS)", () => {
    expect(() =>
      buildCloneOrPullCommand(
        { name: "app", url: "git@github.com:x/app.git", branch: "main" },
        "t",
      ),
    ).toThrow("Unsupported repo URL");
  });

  it("rejects non-github HTTPS URLs", () => {
    expect(() =>
      buildCloneOrPullCommand(
        { name: "app", url: "https://gitlab.com/x/app.git", branch: "main" },
        "t",
      ),
    ).toThrow("Unsupported repo URL");
  });

  it("chains fetch + reset with && so either failure short-circuits", () => {
    const cmd = buildCloneOrPullCommand(
      { name: "app", url: "https://github.com/x/app.git", branch: "main" },
      "t",
    );
    expect(cmd).toMatch(/fetch origin main && git -C .* reset --hard/);
  });

  it("rejects tokens containing shell-special characters (single-quote injection guard)", () => {
    expect(() =>
      buildCloneOrPullCommand(
        { name: "app", url: "https://github.com/x/app.git", branch: "main" },
        "ghp_'injection",
      ),
    ).toThrow("unsupported characters");
    expect(() =>
      buildCloneOrPullCommand(
        { name: "app", url: "https://github.com/x/app.git", branch: "main" },
        "ghp_$(evil)",
      ),
    ).toThrow("unsupported characters");
  });

  it("rejects branches containing shell-special characters (single-quote injection guard)", () => {
    // Branch text ends up inside the same single-quoted SSH wrapper as the
    // token, so it must be vetted with the same restraint. Real git refs
    // can't contain `'`, `$`, backticks, etc anyway — this is a defense-in-
    // depth guard against a misconfigured deploy yml.
    expect(() =>
      buildCloneOrPullCommand(
        {
          name: "app",
          url: "https://github.com/x/app.git",
          branch: "main'; rm -rf /",
        },
        "t",
      ),
    ).toThrow("unsupported characters");
  });

  it.each([
    ["dollar-paren substitution", "main$(whoami)"],
    ["backtick substitution", "main`whoami`"],
    ["semicolon command chaining", "main;ls"],
    ["ampersand background", "main&pwd"],
    ["pipe", "main|cat"],
    ["asterisk glob", "main*"],
    ["space", "main branch"],
    ["newline", "main\n"],
  ])(
    "rejects branch with %s (regex char-class regression guard)",
    (_label, branch) => {
      // The accept-list `^[A-Za-z0-9._/-]+$` is the load-bearing piece
      // here — broaden it carelessly and any of these slip into the
      // single-quoted SSH wrapper. Sweep the full set so the test fails
      // loud if anyone widens the regex.
      expect(() =>
        buildCloneOrPullCommand(
          {
            name: "app",
            url: "https://github.com/x/app.git",
            branch,
          },
          "t",
        ),
      ).toThrow("unsupported characters");
    },
  );
});
