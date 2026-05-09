/**
 * Unit tests for WorktreeManager — uses a fake `GitRunner` so we can assert
 * the exact argv shape passed to git without spawning a process. The real
 * `defaultGitRunner` (backed by `child_process.execFile`) is exercised by
 * the integration suite at `src/__tests__/integration/worktree-manager.test.ts`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import {
  createWorktreeManager,
  WorktreeError,
  type GitRunner,
} from "./worktree-manager.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";

interface RecordedCall {
  cwd: string;
  args: readonly string[];
}

interface FakeRunnerOptions {
  /**
   * Per-prefix response programmer. Lookup is by stringified args (joined
   * with " "); first matching prefix wins. Unmatched calls return
   * `{stdout: "", stderr: "", code: 0}` by default.
   */
  responses?: Array<{
    match: string | RegExp;
    response: { stdout?: string; stderr?: string; code?: number };
  }>;
}

function fakeRunner(opts: FakeRunnerOptions = {}): GitRunner & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async run(cwd, args) {
      calls.push({ cwd, args });
      const joined = args.join(" ");
      for (const { match, response } of opts.responses ?? []) {
        if (typeof match === "string" ? joined.startsWith(match) : match.test(joined)) {
          return {
            stdout: response.stdout ?? "",
            stderr: response.stderr ?? "",
            code: response.code ?? 0,
          };
        }
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

describe("WorktreeManager", () => {
  const ctx = makeRepoContext({ localPath: "/repo/danxbot" });
  const expectedPath = "/repo/danxbot/.danxbot/worktrees/alice";

  describe("worktreePath", () => {
    it("returns <localPath>/.danxbot/worktrees/<name>", () => {
      const wm = createWorktreeManager(fakeRunner());
      expect(wm.worktreePath(ctx, "alice")).toBe(expectedPath);
    });
  });

  // ============================================================
  // bootstrap
  // ============================================================

  describe("bootstrap", () => {
    it("first run executes `git worktree add -B <name> <path> origin/main`", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "worktree list --porcelain", response: { stdout: "" } },
        ],
      });
      const wm = createWorktreeManager(runner);

      await wm.bootstrap(ctx, "alice");

      expect(runner.calls).toEqual([
        { cwd: ctx.localPath, args: ["worktree", "list", "--porcelain"] },
        { cwd: ctx.localPath, args: ["fetch", "origin"] },
        {
          cwd: ctx.localPath,
          args: ["worktree", "add", "-B", "alice", expectedPath, "origin/main"],
        },
      ]);
    });

    it("does NOT match a sibling-prefix worktree path (regression guard for worktreeListIncludes)", async () => {
      // The line scanner must do an exact-equality compare on the path.
      // A naive `.includes(path)` would match `alice-evil` against `alice`.
      // Verify by giving stdout that lists ONLY the sibling — bootstrap
      // must NOT short-circuit to no-op.
      const runner = fakeRunner({
        responses: [
          {
            match: "worktree list --porcelain",
            response: {
              stdout: [
                "worktree /repo/danxbot",
                "HEAD abc",
                "branch refs/heads/main",
                "",
                "worktree /repo/danxbot/.danxbot/worktrees/alice-evil",
                "HEAD def",
                "branch refs/heads/alice-evil",
                "",
              ].join("\n"),
            },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      await wm.bootstrap(ctx, "alice");

      // Three calls: list, fetch, add — proving bootstrap proceeded past
      // the idempotency check despite the lookalike sibling.
      expect(runner.calls).toHaveLength(3);
      expect(runner.calls[2].args).toEqual([
        "worktree",
        "add",
        "-B",
        "alice",
        expectedPath,
        "origin/main",
      ]);
    });

    it("second run on existing worktree is a no-op (detected via worktree list)", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "worktree list --porcelain",
            response: {
              stdout: [
                "worktree /repo/danxbot",
                "HEAD abc",
                "branch refs/heads/main",
                "",
                `worktree ${expectedPath}`,
                "HEAD def",
                "branch refs/heads/alice",
                "",
              ].join("\n"),
            },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      await wm.bootstrap(ctx, "alice");

      expect(runner.calls).toEqual([
        { cwd: ctx.localPath, args: ["worktree", "list", "--porcelain"] },
      ]);
    });

    it("throws WorktreeError when `git fetch origin` fails", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "worktree list", response: { stdout: "" } },
          {
            match: "fetch origin",
            response: { code: 128, stderr: "fatal: unable to access" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      await expect(wm.bootstrap(ctx, "alice")).rejects.toBeInstanceOf(
        WorktreeError,
      );
    });

    it("throws WorktreeError when `git worktree add` fails", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "worktree list", response: { stdout: "" } },
          {
            match: "worktree add",
            response: {
              code: 128,
              stderr: "fatal: 'origin/main' is not a commit",
            },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      await expect(wm.bootstrap(ctx, "alice")).rejects.toBeInstanceOf(
        WorktreeError,
      );
    });
  });

  // ============================================================
  // validate
  // ============================================================

  describe("validate", () => {
    it("returns clean on a clean tree on origin/main", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "fetch origin", response: { stdout: "" } },
          { match: "status --porcelain", response: { stdout: "" } },
          {
            match: "rev-list --count origin/main..HEAD",
            response: { stdout: "0\n" },
          },
          {
            match: "rev-list --count HEAD..origin/main",
            response: { stdout: "0\n" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.validate(ctx, "alice");
      expect(result).toEqual({ state: "clean" });
    });

    it("returns dirty with reason 'uncommitted changes' on porcelain output", async () => {
      const porcelain = " M src/file.ts\n?? newfile.txt";
      const runner = fakeRunner({
        responses: [
          { match: "fetch origin", response: { stdout: "" } },
          { match: "status --porcelain", response: { stdout: porcelain } },
          {
            match: "rev-list --count origin/main..HEAD",
            response: { stdout: "0\n" },
          },
          {
            match: "rev-list --count HEAD..origin/main",
            response: { stdout: "0\n" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.validate(ctx, "alice");
      expect(result).toMatchObject({
        state: "dirty",
        reason: "uncommitted changes",
        details: { porcelain: porcelain.trim(), ahead: 0, behind: 0 },
      });
    });

    it("returns dirty with reason 'branch has unmerged commits' when ahead > 0", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "fetch origin", response: { stdout: "" } },
          { match: "status --porcelain", response: { stdout: "" } },
          {
            match: "rev-list --count origin/main..HEAD",
            response: { stdout: "3\n" },
          },
          {
            match: "rev-list --count HEAD..origin/main",
            response: { stdout: "1\n" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.validate(ctx, "alice");
      expect(result).toMatchObject({
        state: "dirty",
        reason: "branch has unmerged commits",
        details: { porcelain: "", ahead: 3, behind: 1 },
      });
    });

    it("returns clean when only behind origin/main (reset will fast-forward)", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "fetch origin", response: { stdout: "" } },
          { match: "status --porcelain", response: { stdout: "" } },
          {
            match: "rev-list --count origin/main..HEAD",
            response: { stdout: "0\n" },
          },
          {
            match: "rev-list --count HEAD..origin/main",
            response: { stdout: "5\n" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.validate(ctx, "alice");
      expect(result).toEqual({ state: "clean" });
    });

    it("returns dirty (with empty details) when fetch fails — defers to recovery rather than risk a wrong reset", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "fetch origin",
            response: { code: 128, stderr: "fatal: network unreachable" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.validate(ctx, "alice");
      expect(result.state).toBe("dirty");
      if (result.state === "dirty") {
        expect(result.reason).toMatch(/git fetch origin failed/);
        expect(result.details).toEqual({ porcelain: "", ahead: 0, behind: 0 });
      }
    });
  });

  // ============================================================
  // resetClean
  // ============================================================

  describe("resetClean", () => {
    it("fetches origin, checks out the agent branch, then `git reset --hard origin/main`", async () => {
      const runner = fakeRunner();
      const wm = createWorktreeManager(runner);

      await wm.resetClean(ctx, "alice");

      expect(runner.calls).toEqual([
        { cwd: expectedPath, args: ["fetch", "origin"] },
        { cwd: expectedPath, args: ["checkout", "alice"] },
        { cwd: expectedPath, args: ["reset", "--hard", "origin/main"] },
      ]);
    });

    it("throws WorktreeError when fetch fails", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "fetch origin",
            response: { code: 128, stderr: "fatal: network unreachable" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      await expect(wm.resetClean(ctx, "alice")).rejects.toBeInstanceOf(
        WorktreeError,
      );
    });

    it("throws WorktreeError when checkout fails", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "checkout alice",
            response: { code: 1, stderr: "error: pathspec did not match" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      await expect(wm.resetClean(ctx, "alice")).rejects.toBeInstanceOf(
        WorktreeError,
      );
    });

    it("throws WorktreeError when reset fails", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "reset --hard",
            response: { code: 1, stderr: "fatal: ambiguous argument" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      await expect(wm.resetClean(ctx, "alice")).rejects.toBeInstanceOf(
        WorktreeError,
      );
    });
  });

  // ============================================================
  // teardown
  // ============================================================

  describe("teardown", () => {
    it("executes `git worktree remove --force` then best-effort branch deletes", async () => {
      const runner = fakeRunner();
      const wm = createWorktreeManager(runner);

      await wm.teardown(ctx, "alice");

      expect(runner.calls).toEqual([
        {
          cwd: ctx.localPath,
          args: ["worktree", "remove", "--force", expectedPath],
        },
        { cwd: ctx.localPath, args: ["branch", "-D", "alice"] },
        { cwd: ctx.localPath, args: ["push", "origin", "--delete", "alice"] },
      ]);
    });

    it("treats missing-worktree as success (cleans branch anyway)", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "worktree remove",
            response: {
              code: 128,
              stderr: `fatal: '${expectedPath}' is not a working tree`,
            },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      // Should not throw — missing worktree is a recoverable state.
      await wm.teardown(ctx, "alice");

      // Branch deletes still attempted.
      expect(
        runner.calls.some((c) => c.args[0] === "branch" && c.args[1] === "-D"),
      ).toBe(true);
      expect(
        runner.calls.some((c) => c.args[0] === "push" && c.args[2] === "--delete"),
      ).toBe(true);
    });

    it("throws WorktreeError on real worktree-remove failures (lock contention)", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "worktree remove",
            response: { code: 1, stderr: "fatal: worktree is locked" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      await expect(wm.teardown(ctx, "alice")).rejects.toBeInstanceOf(
        WorktreeError,
      );
    });

    it("swallows local + remote branch delete failures (best-effort)", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "branch -D", response: { code: 1, stderr: "branch not found" } },
          { match: "push origin --delete", response: { code: 1, stderr: "remote rejected" } },
        ],
      });
      const wm = createWorktreeManager(runner);

      // Should not throw — both deletes are best-effort.
      await expect(wm.teardown(ctx, "alice")).resolves.toBeUndefined();
    });
  });

  // ============================================================
  // Path injection sanity — bootstrap path uses join, not string concat
  // ============================================================

  // ============================================================
  // Defense-in-depth: AGENT_NAME_SHAPE re-validation
  // ============================================================

  describe("AGENT_NAME_SHAPE defense-in-depth (L1 fix)", () => {
    it("rejects an invalid agent name on every method", async () => {
      const wm = createWorktreeManager(fakeRunner());
      const bad = ["Alice", "1leadnumber", "has space", "has/slash", "--upload-pack=evil"];
      for (const name of bad) {
        await expect(wm.bootstrap(ctx, name)).rejects.toThrow(WorktreeError);
        await expect(wm.teardown(ctx, name)).rejects.toThrow(WorktreeError);
        await expect(wm.validate(ctx, name)).rejects.toThrow(WorktreeError);
        await expect(wm.resetClean(ctx, name)).rejects.toThrow(WorktreeError);
        expect(() => wm.worktreePath(ctx, name)).toThrow(WorktreeError);
      }
    });
  });

  describe("worktreePath construction", () => {
    it("places worktrees under .danxbot/worktrees/ regardless of trailing slashes", () => {
      const wm = createWorktreeManager(fakeRunner());
      expect(wm.worktreePath(makeRepoContext({ localPath: "/foo" }), "x")).toBe(
        join("/foo", ".danxbot", "worktrees", "x"),
      );
      expect(
        wm.worktreePath(makeRepoContext({ localPath: "/foo/" }), "x"),
      ).toBe(join("/foo/", ".danxbot", "worktrees", "x"));
    });
  });
});
