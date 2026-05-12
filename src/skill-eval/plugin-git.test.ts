import { describe, expect, it, vi } from "vitest";
import {
  PluginGitError,
  commitAndPushDescription,
  type GitExecFn,
} from "./plugin-git.js";

function makeExec(responses: Array<{ stdout?: string; stderr?: string; code?: number }>): GitExecFn {
  let i = 0;
  return vi.fn(async (cmd: string, args: readonly string[]) => {
    const r = responses[i++];
    if (!r) {
      throw new Error(`unexpected exec call #${i} for ${cmd} ${args.join(" ")}`);
    }
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.code ?? 0,
      cmd,
      args: [...args],
    };
  });
}

describe("commitAndPushDescription", () => {
  it("runs add -> commit -> rev-parse -> push in order, returns the commit sha", async () => {
    const calls: string[][] = [];
    const exec = vi.fn(async (cmd: string, args: readonly string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes("rev-parse")) {
        return { stdout: "abc123def\n", stderr: "", exitCode: 0, cmd, args: [...args] };
      }
      return { stdout: "", stderr: "", exitCode: 0, cmd, args: [...args] };
    });
    const result = await commitAndPushDescription(
      {
        sourceRepoRoot: "/plugins",
        relativeSkillPath: "dev/skills/debugging/SKILL.md",
        pluginSkill: "dev:debugging",
        iteration: 2,
      },
      exec,
    );
    expect(result.sha).toBe("abc123def");
    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/plugins",
      "add",
      "--",
      "dev/skills/debugging/SKILL.md",
    ]);
    expect(calls[1].slice(0, 5)).toEqual([
      "git",
      "-C",
      "/plugins",
      "commit",
      "-m",
    ]);
    expect(calls[1][5]).toMatch(/iter 2/);
    expect(calls[1][5]).toMatch(/dev:debugging/);
    expect(calls[2]).toEqual(["git", "-C", "/plugins", "rev-parse", "HEAD"]);
    expect(calls[3]).toEqual([
      "git",
      "-C",
      "/plugins",
      "push",
      "origin",
      "HEAD",
    ]);
  });

  it("throws if git add fails", async () => {
    const exec = makeExec([{ stderr: "fatal: not a git repo", code: 128 }]);
    await expect(
      commitAndPushDescription(
        {
          sourceRepoRoot: "/plugins",
          relativeSkillPath: "dev/skills/debugging/SKILL.md",
          pluginSkill: "dev:debugging",
          iteration: 1,
        },
        exec,
      ),
    ).rejects.toThrow(PluginGitError);
  });

  it("throws if git commit fails (e.g. nothing to commit)", async () => {
    const exec = makeExec([
      { code: 0 },                                      // add
      { stderr: "nothing to commit, working tree clean", code: 1 },  // commit
    ]);
    await expect(
      commitAndPushDescription(
        {
          sourceRepoRoot: "/plugins",
          relativeSkillPath: "dev/skills/debugging/SKILL.md",
          pluginSkill: "dev:debugging",
          iteration: 1,
        },
        exec,
      ),
    ).rejects.toThrow(/commit/);
  });

  it("throws if git rev-parse fails (cannot resolve sha)", async () => {
    const exec = makeExec([
      { code: 0 },   // add
      { code: 0 },   // commit
      { stderr: "fatal: ambiguous", code: 128 },  // rev-parse
    ]);
    await expect(
      commitAndPushDescription(
        {
          sourceRepoRoot: "/plugins",
          relativeSkillPath: "dev/skills/debugging/SKILL.md",
          pluginSkill: "dev:debugging",
          iteration: 1,
        },
        exec,
      ),
    ).rejects.toThrow(/rev-parse/);
  });

  it("throws if git push fails (network / auth)", async () => {
    const exec = makeExec([
      { code: 0 },                              // add
      { code: 0 },                              // commit
      { stdout: "abc\n", code: 0 },             // rev-parse
      { stderr: "fatal: unable to access", code: 128 },  // push
    ]);
    await expect(
      commitAndPushDescription(
        {
          sourceRepoRoot: "/plugins",
          relativeSkillPath: "dev/skills/debugging/SKILL.md",
          pluginSkill: "dev:debugging",
          iteration: 1,
        },
        exec,
      ),
    ).rejects.toThrow(/push/);
  });

  it("validates required args (rejects empty sourceRepoRoot)", async () => {
    const exec = makeExec([]);
    await expect(
      commitAndPushDescription(
        {
          sourceRepoRoot: "",
          relativeSkillPath: "dev/skills/debugging/SKILL.md",
          pluginSkill: "dev:debugging",
          iteration: 1,
        },
        exec,
      ),
    ).rejects.toThrow(/sourceRepoRoot/);
  });

  it("trims trailing whitespace from the sha", async () => {
    const exec = makeExec([
      { code: 0 },                                  // add
      { code: 0 },                                  // commit
      { stdout: "deadbeef\r\n", code: 0 },          // rev-parse
      { code: 0 },                                  // push
    ]);
    const result = await commitAndPushDescription(
      {
        sourceRepoRoot: "/plugins",
        relativeSkillPath: "dev/skills/debugging/SKILL.md",
        pluginSkill: "dev:debugging",
        iteration: 0,
      },
      exec,
    );
    expect(result.sha).toBe("deadbeef");
  });

  it("includes the iteration index in the commit message", async () => {
    const exec = makeExec([
      { code: 0 },
      { code: 0 },
      { stdout: "abc\n", code: 0 },
      { code: 0 },
    ]);
    await commitAndPushDescription(
      {
        sourceRepoRoot: "/plugins",
        relativeSkillPath: "dev/skills/debugging/SKILL.md",
        pluginSkill: "dev:debugging",
        iteration: 4,
      },
      exec,
    );
    const commitCall = (exec as unknown as { mock: { calls: unknown[][] } }).mock.calls[1];
    const args = commitCall[1] as string[];
    const message = args[args.indexOf("-m") + 1];
    expect(message).toContain("iter 4");
    expect(message).toContain("dev:debugging");
  });
});
