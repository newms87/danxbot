import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReloadPropagationError,
  reloadAndVerify,
  type GitExecFn,
} from "./reload-propagation.js";

function makeExec(
  fn?: (cmd: string, args: readonly string[]) => Promise<{ stdout?: string; stderr?: string; code?: number }>,
): GitExecFn {
  return vi.fn(async (cmd: string, args: readonly string[]) => {
    const r = (await fn?.(cmd, args)) ?? {};
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.code ?? 0,
      cmd,
      args: [...args],
    };
  });
}

describe("reloadAndVerify", () => {
  let tmpRoot: string;
  let cacheRoot: string;
  let cacheSkillPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "reload-prop-"));
    cacheRoot = join(tmpRoot, "marketplace");
    mkdirSync(join(cacheRoot, "dev", "skills", "debugging"), {
      recursive: true,
    });
    cacheSkillPath = join(cacheRoot, "dev", "skills", "debugging", "SKILL.md");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("pulls the marketplace + verifies the cache description matches expected", async () => {
    writeFileSync(
      cacheSkillPath,
      "---\nname: debugging\ndescription: 'NEW DESC'\n---\nbody",
    );
    const exec = makeExec();
    await reloadAndVerify(
      {
        cacheRepoRoot: cacheRoot,
        cacheSkillPath,
        expectedDescription: "NEW DESC",
      },
      exec,
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect((exec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual([
      "git",
      ["-C", cacheRoot, "pull", "--ff-only"],
    ]);
  });

  it("throws if pull fails (non-zero exit)", async () => {
    writeFileSync(
      cacheSkillPath,
      "---\nname: debugging\ndescription: 'old'\n---\nbody",
    );
    const exec = makeExec(async () => ({
      stderr: "fatal: not a git repo",
      code: 128,
    }));
    await expect(
      reloadAndVerify(
        {
          cacheRepoRoot: cacheRoot,
          cacheSkillPath,
          expectedDescription: "new",
        },
        exec,
      ),
    ).rejects.toThrow(ReloadPropagationError);
    await expect(
      reloadAndVerify(
        {
          cacheRepoRoot: cacheRoot,
          cacheSkillPath,
          expectedDescription: "new",
        },
        exec,
      ),
    ).rejects.toThrow(/pull/);
  });

  it("throws if cache description STILL matches the OLD value (propagation drift)", async () => {
    writeFileSync(
      cacheSkillPath,
      "---\nname: debugging\ndescription: 'old'\n---\nbody",
    );
    const exec = makeExec();
    await expect(
      reloadAndVerify(
        {
          cacheRepoRoot: cacheRoot,
          cacheSkillPath,
          expectedDescription: "new desc",
        },
        exec,
      ),
    ).rejects.toThrow(/drift|mismatch|propagation/i);
  });

  it("throws if the cache SKILL.md is missing after pull", async () => {
    const exec = makeExec();
    await expect(
      reloadAndVerify(
        {
          cacheRepoRoot: cacheRoot,
          cacheSkillPath: join(cacheRoot, "missing", "SKILL.md"),
          expectedDescription: "new",
        },
        exec,
      ),
    ).rejects.toThrow(/missing|not found/i);
  });

  it("throws if the cache SKILL.md is malformed (no frontmatter)", async () => {
    writeFileSync(cacheSkillPath, "no frontmatter here");
    const exec = makeExec();
    await expect(
      reloadAndVerify(
        {
          cacheRepoRoot: cacheRoot,
          cacheSkillPath,
          expectedDescription: "new",
        },
        exec,
      ),
    ).rejects.toThrow();
  });

  it("returns the verified description on success", async () => {
    writeFileSync(
      cacheSkillPath,
      "---\nname: debugging\ndescription: 'matches'\n---\nbody",
    );
    const result = await reloadAndVerify(
      {
        cacheRepoRoot: cacheRoot,
        cacheSkillPath,
        expectedDescription: "matches",
      },
      makeExec(),
    );
    expect(result.cacheDescription).toBe("matches");
  });
});
