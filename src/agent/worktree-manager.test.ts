/**
 * Unit tests for WorktreeManager — uses a fake `GitRunner` so we can assert
 * the exact argv shape passed to git without spawning a process. The real
 * `defaultGitRunner` (backed by `child_process.execFile`) is exercised by
 * the integration suite at `src/__tests__/integration/worktree-manager.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as worktreeDatabase from "./worktree-database.js";
import { join } from "node:path";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

      // Two calls: list + add — proving bootstrap proceeded past the
      // idempotency check despite the lookalike sibling. (No fetch —
      // worktree mgmt is purely local.)
      expect(runner.calls).toHaveLength(2);
      expect(runner.calls[1].args).toEqual([
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

    it("does not call `git fetch` (worktree mgmt is purely local — no GitHub round-trip)", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "worktree list", response: { stdout: "" } },
          { match: "worktree add", response: { stdout: "" } },
        ],
      });
      const wm = createWorktreeManager(runner);

      await wm.bootstrap(ctx, "alice");

      expect(
        runner.calls.some((c) => c.args[0] === "fetch"),
      ).toBe(false);
    });

    it("self-heals an orphan worktree dir (present on disk, not registered) by pruning + removing before `worktree add`", async () => {
      // Repro for the operator-reported failure:
      //   "Failed to bootstrap worktree for agent 'phil':
      //    git worktree add failed: fatal: '.../worktrees/phil' already exists"
      // The dir survived a prior teardown / runtime-path mismatch, so the
      // worktree registry no longer lists it, but the directory + dangling
      // `.git` pointer remain on disk. `git worktree add` refuses. Bootstrap
      // must detect the orphan, prune dangling registry entries, rm the dir,
      // then succeed.
      const tmp = mkdtempSync(join(tmpdir(), "wm-orphan-"));
      const orphanPath = join(tmp, ".danxbot", "worktrees", "alice");
      mkdirSync(orphanPath, { recursive: true });
      writeFileSync(
        join(orphanPath, ".git"),
        "gitdir: /nonexistent/.git/worktrees/alice\n",
      );

      const orphanCtx = makeRepoContext({ localPath: tmp, hostPath: tmp });
      const runner = fakeRunner({
        responses: [
          { match: "worktree list --porcelain", response: { stdout: "" } },
        ],
      });
      // Wrap `run` to snapshot whether the orphan dir still exists at the
      // moment `git worktree add` would have been invoked — guards the
      // ordering invariant (rm BEFORE add, never after).
      const realRun = runner.run.bind(runner);
      let orphanPresentAtAddTime: boolean | null = null;
      runner.run = async (cwd, args) => {
        if (args[0] === "worktree" && args[1] === "add") {
          orphanPresentAtAddTime = existsSync(orphanPath);
        }
        return realRun(cwd, args);
      };
      const wm = createWorktreeManager(runner);

      try {
        await wm.bootstrap(orphanCtx, "alice");

        expect(runner.calls.map((c) => c.args.join(" "))).toEqual([
          "worktree list --porcelain",
          "worktree prune",
          `worktree add -B alice ${orphanPath} origin/main`,
        ]);
        expect(orphanPresentAtAddTime).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
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
  // syncWorktree (DX-293) — non-destructive replacement for resetClean
  // ============================================================

  describe("syncWorktree", () => {
    function syncRunner(
      counts: string,
      extra: FakeRunnerOptions["responses"] = [],
    ): GitRunner & { calls: RecordedCall[] } {
      // `git rev-list --left-right --count origin/main...HEAD` →
      // "<behind>\t<ahead>\n" by default. Tests pass the literal
      // string they want returned.
      return fakeRunner({
        responses: [
          { match: "fetch origin", response: { stdout: "" } },
          {
            match: "rev-list --left-right --count",
            response: { stdout: counts },
          },
          ...(extra ?? []),
        ],
      });
    }

    it("returns {kind: 'noop'} when ahead=0 and behind=0", async () => {
      const runner = syncRunner("0\t0\n");
      const wm = createWorktreeManager(runner);

      const result = await wm.syncWorktree(ctx, "alice");

      expect(result).toEqual({ kind: "noop" });
      // fetch + rev-list only — no pull, no rebase.
      expect(runner.calls.map((c) => c.args[0])).toEqual([
        "fetch",
        "rev-list",
      ]);
    });

    it("ff path: pure-behind branch fast-forwards via `git pull --ff-only`, returns {kind: 'ff', from, to}", async () => {
      // We need rev-parse HEAD to return DIFFERENT shas before vs after
      // the pull (otherwise from === to and the test can't distinguish a
      // real ff from a no-op). Drive an ordered queue keyed on argv.
      const headValues = ["aaaaaaa\n", "bbbbbbb\n"];
      const runner = fakeRunner({
        responses: [
          { match: "fetch origin", response: { stdout: "" } },
          {
            match: "rev-list --left-right --count",
            response: { stdout: "2\t0\n" },
          },
          { match: "pull --ff-only origin main", response: { stdout: "" } },
        ],
      });
      const origRun = runner.run;
      runner.run = async (cwd, args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          runner.calls.push({ cwd, args });
          return {
            stdout: headValues.shift() ?? "",
            stderr: "",
            code: 0,
          };
        }
        return origRun.call(runner, cwd, args);
      };
      const wm = createWorktreeManager(runner);

      const result = await wm.syncWorktree(ctx, "alice");

      expect(result).toEqual({
        kind: "ff",
        from: "aaaaaaa",
        to: "bbbbbbb",
      });
      // No `reset`, no `checkout <ref>`, no `restore`, no `clean -f`.
      expect(
        runner.calls.some(
          (c) =>
            c.args[0] === "reset" ||
            c.args[0] === "checkout" ||
            c.args[0] === "restore" ||
            (c.args[0] === "clean" && c.args.includes("-f")),
        ),
      ).toBe(false);
    });

    it("rebased path: ahead>0 with clean rebase, returns {kind: 'rebased', commits: N}", async () => {
      const runner = syncRunner("0\t3\n", [
        { match: "rebase origin/main", response: { stdout: "" } },
      ]);
      const wm = createWorktreeManager(runner);

      const result = await wm.syncWorktree(ctx, "alice");

      expect(result).toEqual({ kind: "rebased", commits: 3 });
      // Rebase ran without `--abort` follow-up (no conflict).
      expect(
        runner.calls.some(
          (c) => c.args[0] === "rebase" && c.args[1] === "--abort",
        ),
      ).toBe(false);
    });

    it("abort path: rebase conflict → `git rebase --abort` is invoked AND worktree stays at HEAD (no destructive cleanup)", async () => {
      const runner = syncRunner("1\t2\n", [
        {
          match: "rebase origin/main",
          response: {
            code: 1,
            stderr: "CONFLICT (content): Merge conflict in src/foo.ts",
          },
        },
        { match: "rebase --abort", response: { stdout: "" } },
      ]);
      const wm = createWorktreeManager(runner);

      const result = await wm.syncWorktree(ctx, "alice");

      expect(result).toMatchObject({
        kind: "abort",
        reason: "rebase conflict against origin/main",
      });
      if (result.kind === "abort") {
        expect(result.details).toContain("CONFLICT");
      }
      // Critical: `rebase --abort` ran AFTER the failed rebase to
      // restore HEAD. No `git reset`, no `git checkout <ref>`, no
      // `git restore`, no `git clean -f` — those would be destructive.
      const argv0s = runner.calls.map((c) => c.args.join(" "));
      expect(argv0s.some((a) => a.startsWith("rebase --abort"))).toBe(true);
      expect(argv0s.some((a) => a.startsWith("reset"))).toBe(false);
      expect(argv0s.some((a) => a.startsWith("restore"))).toBe(false);
      expect(argv0s.some((a) => /^clean( |\b)/.test(a) && a.includes("-f"))).toBe(
        false,
      );
      // No `checkout <ref>` either — the only checkout we'd allow is the
      // retired `checkout <branch-name>`, which is also not in this flow.
      expect(argv0s.some((a) => a.startsWith("checkout"))).toBe(false);
    });

    it("abort path: ff-only pull rejected → {kind: 'abort', reason: 'ff-only pull rejected'}", async () => {
      const runner = syncRunner("1\t0\n", [
        { match: "rev-parse HEAD", response: { stdout: "aaaaaaa\n" } },
        {
          match: "pull --ff-only origin main",
          response: {
            code: 1,
            stderr: "fatal: Not possible to fast-forward, aborting.",
          },
        },
      ]);
      const wm = createWorktreeManager(runner);

      const result = await wm.syncWorktree(ctx, "alice");

      expect(result).toMatchObject({
        kind: "abort",
        reason: "ff-only pull rejected",
      });
      if (result.kind === "abort") {
        expect(result.details).toContain("fast-forward");
      }
    });

    it("abort path: fetch failure → {kind: 'abort', reason: 'git fetch failed'}", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "fetch origin",
            response: { code: 128, stderr: "fatal: unable to access remote" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.syncWorktree(ctx, "alice");

      expect(result).toMatchObject({
        kind: "abort",
        reason: "git fetch failed",
      });
    });

    it("ABSOLUTE RULE (DX-291): no `git reset`, `git checkout <ref> -- <path>`, `git restore`, or `git clean -f` invocations anywhere in syncWorktree", async () => {
      // Exhaustive ban-assertion across the four interesting branches —
      // noop, ff, rebased, abort. Run each branch and accumulate
      // every git argv shape the runner saw. None of the banned shapes
      // may appear.
      const observed: string[] = [];
      const recordingRunner = (counts: string, extra: FakeRunnerOptions["responses"]) => {
        const r = fakeRunner({
          responses: [
            { match: "fetch origin", response: { stdout: "" } },
            {
              match: "rev-list --left-right --count",
              response: { stdout: counts },
            },
            ...(extra ?? []),
          ],
        });
        const origRun = r.run;
        r.run = async (cwd, args) => {
          observed.push(args.join(" "));
          return origRun.call(r, cwd, args);
        };
        return r;
      };

      // noop
      let wm = createWorktreeManager(recordingRunner("0\t0\n", []));
      await wm.syncWorktree(ctx, "alice");

      // ff
      wm = createWorktreeManager(
        recordingRunner("1\t0\n", [
          { match: "rev-parse HEAD", response: { stdout: "h\n" } },
          { match: "pull --ff-only", response: { stdout: "" } },
        ]),
      );
      await wm.syncWorktree(ctx, "alice");

      // rebased
      wm = createWorktreeManager(
        recordingRunner("0\t1\n", [
          { match: "rebase origin/main", response: { stdout: "" } },
        ]),
      );
      await wm.syncWorktree(ctx, "alice");

      // abort (rebase conflict)
      wm = createWorktreeManager(
        recordingRunner("1\t1\n", [
          {
            match: "rebase origin/main",
            response: { code: 1, stderr: "CONFLICT" },
          },
          { match: "rebase --abort", response: { stdout: "" } },
        ]),
      );
      await wm.syncWorktree(ctx, "alice");

      // Banned: any `reset`, any `checkout <ref>` other than agent-branch
      // checkout (which syncWorktree never calls; retired with resetClean),
      // any `restore`, any `clean -f`.
      const banned = observed.filter(
        (cmd) =>
          cmd.startsWith("reset") ||
          cmd.startsWith("checkout") ||
          cmd.startsWith("restore") ||
          /^clean\b.*\s-f/.test(cmd),
      );
      expect(banned).toEqual([]);
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
        await expect(wm.syncWorktree(ctx, name)).rejects.toThrow(WorktreeError);
        expect(() => wm.worktreePath(ctx, name)).toThrow(WorktreeError);
      }
    });
  });

  // ============================================================
  // snapshotIfDirty (DX-359) — commit WIP before sync to prevent
  // ff-only pull abort + agents.<name>.broken stamp when prior
  // dispatch died mid-write.
  // ============================================================

  describe("snapshotIfDirty", () => {
    it("returns {kind: 'clean'} when working tree has no uncommitted changes (no commit attempted)", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "status --porcelain", response: { stdout: "" } },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.snapshotIfDirty(ctx, "alice");

      expect(result).toEqual({ kind: "clean" });
      // No add / commit / rev-parse — clean path is single-call.
      expect(runner.calls.map((c) => c.args[0])).toEqual(["status"]);
    });

    it("commits a wip(autosave) snapshot on the agent branch and returns {kind: 'snapshotted', sha} when tree dirty", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "status --porcelain",
            response: { stdout: " M src/foo.ts\n?? src/new.ts\n" },
          },
          {
            match: "rev-parse --abbrev-ref HEAD",
            response: { stdout: "alice\n" },
          },
          { match: "add -A", response: { stdout: "" } },
          { match: "commit -m", response: { stdout: "ok" } },
          {
            match: "rev-parse HEAD",
            response: { stdout: "deadbeefcafe1234\n" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.snapshotIfDirty(ctx, "alice");

      expect(result).toEqual({
        kind: "snapshotted",
        sha: "deadbeefcafe1234",
      });
      // Exact call sequence: status → branch check → add → commit → head sha.
      const argvs = runner.calls.map((c) => c.args.join(" "));
      expect(argvs).toEqual([
        "status --porcelain",
        "rev-parse --abbrev-ref HEAD",
        "add -A",
        "commit -m wip(autosave): pre-sync snapshot of prior-dispatch residue",
        "rev-parse HEAD",
      ]);
      // Forbidden destructive ops MUST not appear.
      expect(
        argvs.some(
          (a) =>
            a.startsWith("reset") ||
            a.startsWith("checkout") ||
            a.startsWith("restore") ||
            a.startsWith("stash") ||
            (a.startsWith("clean") && a.includes("-f")),
        ),
      ).toBe(false);
    });

    it("returns {kind: 'abort'} when HEAD is detached (refuses to commit on no-branch)", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "status --porcelain",
            response: { stdout: " M src/foo.ts\n" },
          },
          {
            match: "rev-parse --abbrev-ref HEAD",
            response: { stdout: "HEAD\n" }, // git uses literal "HEAD" for detached
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.snapshotIfDirty(ctx, "alice");

      expect(result).toMatchObject({
        kind: "abort",
        reason: "worktree HEAD not on agent branch",
      });
      if (result.kind === "abort") {
        expect(result.details).toContain("expected branch alice");
      }
      // No add, no commit — refuses to mutate a wrong-branch tree.
      expect(runner.calls.some((c) => c.args[0] === "add")).toBe(false);
      expect(runner.calls.some((c) => c.args[0] === "commit")).toBe(false);
    });

    it("returns {kind: 'abort'} when HEAD points at a different branch", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "status --porcelain",
            response: { stdout: " M src/foo.ts\n" },
          },
          {
            match: "rev-parse --abbrev-ref HEAD",
            response: { stdout: "bob\n" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.snapshotIfDirty(ctx, "alice");

      expect(result).toMatchObject({
        kind: "abort",
        reason: "worktree HEAD not on agent branch",
      });
      if (result.kind === "abort") {
        expect(result.details).toContain("got bob");
      }
    });

    it("returns {kind: 'abort'} when git commit fails (e.g. missing identity)", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "status --porcelain",
            response: { stdout: " M src/foo.ts\n" },
          },
          {
            match: "rev-parse --abbrev-ref HEAD",
            response: { stdout: "alice\n" },
          },
          { match: "add -A", response: { stdout: "" } },
          {
            match: "commit -m",
            response: {
              code: 1,
              stderr:
                "*** Please tell me who you are.\nfatal: empty ident name",
            },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.snapshotIfDirty(ctx, "alice");

      expect(result).toMatchObject({
        kind: "abort",
        reason: "wip snapshot commit failed",
      });
      if (result.kind === "abort") {
        expect(result.details).toContain("empty ident name");
      }
    });

    it("returns {kind: 'abort'} when git status itself fails (corrupt worktree)", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "status --porcelain",
            response: {
              code: 128,
              stderr: "fatal: not a git repository",
            },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const result = await wm.snapshotIfDirty(ctx, "alice");

      expect(result).toMatchObject({
        kind: "abort",
        reason: "git status failed",
      });
    });

    it("rejects an invalid agent name (defense-in-depth — same as syncWorktree)", async () => {
      const wm = createWorktreeManager(fakeRunner());
      await expect(wm.snapshotIfDirty(ctx, "../evil")).rejects.toThrow(
        WorktreeError,
      );
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

  // DX-230 — every git invocation MUST run with cwd=hostPath (canonical
  // absolute path), never localPath. A regression that re-reads
  // localPath would corrupt worktree metadata across host↔docker swaps.
  describe("fetchOrigin", () => {
    it("runs `git fetch --quiet --prune origin main` in the host clone", async () => {
      const runner = fakeRunner();
      const wm = createWorktreeManager(runner);

      const ok = await wm.fetchOrigin(ctx);

      expect(ok).toBe(true);
      expect(runner.calls).toEqual([
        { cwd: ctx.hostPath, args: ["fetch", "--quiet", "--prune", "origin", "main"] },
      ]);
    });

    it("returns false (does not throw) on non-zero exit", async () => {
      const runner = fakeRunner({
        responses: [
          {
            match: "fetch",
            response: { code: 128, stderr: "fatal: unable to access remote" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);

      const ok = await wm.fetchOrigin(ctx);

      expect(ok).toBe(false);
    });
  });

  describe("provisionNodeModules / ensureProvisioned (DX-242)", () => {
    let workArea: string;
    let repoRoot: string;
    let worktreeRoot: string;

    function writeRepoPkg(deps: Record<string, string>): void {
      writeFileSync(
        join(repoRoot, "package.json"),
        JSON.stringify({ name: "test-repo", devDependencies: deps }),
      );
    }

    function makeRepoNm(): void {
      // Lay out a minimal repo-root node_modules with .bin/tsx + a
      // package.json declaring tsx so the sentinel-based fail-loud
      // precondition passes. The file just needs to exist — the helper
      // only checks existence, not exec rights.
      writeRepoPkg({ tsx: "^4.0.0" });
      mkdirSync(join(repoRoot, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(repoRoot, "node_modules", ".bin", "tsx"), "#!fake\n");
    }

    beforeEach(() => {
      workArea = mkdtempSync(join(tmpdir(), "danxbot-prov-"));
      repoRoot = join(workArea, "repo");
      worktreeRoot = join(repoRoot, ".danxbot", "worktrees", "alice");
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });
    });

    afterEach(() => {
      rmSync(workArea, { recursive: true, force: true });
    });

    it("creates the symlink when the worktree has no node_modules", async () => {
      makeRepoNm();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, "node_modules");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(repoRoot, "node_modules")));
    });

    it("is idempotent — running twice leaves the same valid symlink", async () => {
      makeRepoNm();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, "node_modules");
      const inodeBefore = lstatSync(link).ino;
      await wm.ensureProvisioned(ctx, "alice");
      // Same inode = exact same symlink, not recreated.
      expect(lstatSync(link).ino).toBe(inodeBefore);
    });

    it("replaces a broken symlink (target missing) with a fresh one", async () => {
      makeRepoNm();
      const link = join(worktreeRoot, "node_modules");
      symlinkSync(join(workArea, "does-not-exist"), link, "dir");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(repoRoot, "node_modules")));
    });

    it("replaces a real node_modules directory with the symlink", async () => {
      makeRepoNm();
      const real = join(worktreeRoot, "node_modules");
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, "stale.txt"), "stale\n");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(real).isSymbolicLink()).toBe(true);
      expect(existsSync(join(real, "stale.txt"))).toBe(false);
    });

    it("fails loud when repo declares tsx in package.json but node_modules lacks .bin/tsx (broken install)", async () => {
      // package.json declares tsx → sentinel resolves to .bin/tsx →
      // missing file trips the fail-loud check. Simulates a
      // half-installed repo (npm install ran partially, or someone
      // manually deleted .bin/tsx).
      writeRepoPkg({ tsx: "^4.0.0" });
      mkdirSync(join(repoRoot, "node_modules", ".bin"), { recursive: true });
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).rejects.toThrow(
        WorktreeError,
      );
      await expect(wm.ensureProvisioned(ctx, "alice")).rejects.toThrow(
        /node_modules.*\.bin.*tsx/,
      );
    });

    it("skips the sentinel gate when repo has no package.json (non-Node repo with vendor node_modules)", async () => {
      // Connected repos like gpt-manager (Laravel + Vue) have a
      // node_modules at the repo root but no tsx dep. Earlier DX-242
      // form hardcoded `.bin/tsx` and false-positive-failed every such
      // repo. The package.json-aware sentinel skips the gate entirely
      // when there's no package.json to read deps from, so the symlink
      // is still provisioned.
      mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(join(worktreeRoot, "node_modules")).isSymbolicLink()).toBe(true);
    });

    it("skips the sentinel gate when package.json declares no deps", async () => {
      writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "x" }));
      mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(join(worktreeRoot, "node_modules")).isSymbolicLink()).toBe(true);
    });

    it("uses first declared dep as sentinel when neither tsx nor vitest are declared", async () => {
      // Repo declares lodash but not tsx/vitest → sentinel = lodash
      // package dir. Present → passes. Missing → throws.
      writeRepoPkg({ lodash: "^4.0.0" });
      mkdirSync(join(repoRoot, "node_modules", "lodash"), { recursive: true });
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(join(worktreeRoot, "node_modules")).isSymbolicLink()).toBe(true);
    });

    it("fails loud when first declared dep is missing from node_modules", async () => {
      writeRepoPkg({ lodash: "^4.0.0" });
      mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).rejects.toThrow(
        /node_modules.*lodash/,
      );
    });

    it("is a no-op when repo-root has no node_modules (fresh clone, no npm install yet)", async () => {
      // No `node_modules` directory at all in the repo root —
      // permissive path. The worker can't actually run agents in this
      // state (its own tsx resolution would fail) so the real failure
      // surfaces upstream; the worktree-provisioning step doesn't add
      // a redundant fail-loud here.
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).resolves.toBeUndefined();
      expect(existsSync(join(worktreeRoot, "node_modules"))).toBe(false);
    });

    it("is a no-op when the worktree directory does not exist (bootstrap path covers that)", async () => {
      makeRepoNm();
      // Remove the worktree dir created in beforeEach.
      rmSync(worktreeRoot, { recursive: true, force: true });
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).resolves.toBeUndefined();
      expect(existsSync(join(worktreeRoot, "node_modules"))).toBe(false);
    });

    it("ensureProvisioned re-validates agent name against AGENT_NAME_SHAPE", async () => {
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "Bad Name")).rejects.toThrow(
        WorktreeError,
      );
    });

    it("symlink target is the canonical (realpath) repo-root node_modules", async () => {
      // When the operator's repo root is itself a symlink (host vs
      // container path), the canonical comparison still works and the
      // helper does not loop creating + replacing on every call.
      makeRepoNm();
      const symlinkedRoot = join(workArea, "repo-via-symlink");
      symlinkSync(repoRoot, symlinkedRoot, "dir");
      const wm = createWorktreeManager(fakeRunner());
      // Use the symlinked path as hostPath; worktree is still at the
      // canonical repoRoot path, but the manager is asked to provision
      // via the symlinked one.
      const ctx = makeRepoContext({
        localPath: symlinkedRoot,
        hostPath: symlinkedRoot,
      });
      const linkPath = join(
        symlinkedRoot,
        ".danxbot",
        "worktrees",
        "alice",
        "node_modules",
      );
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      // Idempotent on the second run despite the realpath canonicalization.
      const inodeBefore = lstatSync(linkPath).ino;
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(linkPath).ino).toBe(inodeBefore);
    });

    it("readlink target points at <repoRoot>/node_modules (the literal path stored in the link)", async () => {
      makeRepoNm();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, "node_modules");
      // The symlink target stored on disk is the literal path we passed
      // in (not the realpath). This matches how `git worktree add`
      // bakes the canonical path into worktree metadata — both stay
      // runtime-agnostic on host↔docker swaps as long as the operator
      // configures a mirror-bind (DX-230).
      expect(readlinkSync(link)).toBe(join(repoRoot, "node_modules"));
    });
  });

  describe("provisionEnvFile / ensureProvisioned (DX-244)", () => {
    let workArea: string;
    let repoRoot: string;
    let worktreeRoot: string;

    function seedRepoEnv(content = "DANXBOT_DB_USER=fake\n"): void {
      writeFileSync(join(repoRoot, ".env"), content);
    }

    beforeEach(() => {
      workArea = mkdtempSync(join(tmpdir(), "danxbot-prov-env-"));
      repoRoot = join(workArea, "repo");
      worktreeRoot = join(repoRoot, ".danxbot", "worktrees", "alice");
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });
    });

    afterEach(() => {
      rmSync(workArea, { recursive: true, force: true });
    });

    it("creates the .env symlink when the worktree has none", async () => {
      seedRepoEnv();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, ".env");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(repoRoot, ".env")));
    });

    it("is idempotent — running twice leaves the same valid symlink", async () => {
      seedRepoEnv();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, ".env");
      const inodeBefore = lstatSync(link).ino;
      await wm.ensureProvisioned(ctx, "alice");
      // Same inode = exact same symlink, not recreated.
      expect(lstatSync(link).ino).toBe(inodeBefore);
    });

    it("replaces a broken .env symlink (target missing) with a fresh one", async () => {
      seedRepoEnv();
      const link = join(worktreeRoot, ".env");
      symlinkSync(join(workArea, "does-not-exist"), link, "file");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(repoRoot, ".env")));
    });

    it("replaces a real .env file with the symlink (operator left a stale copy)", async () => {
      seedRepoEnv("DANXBOT_DB_USER=fresh\n");
      const real = join(worktreeRoot, ".env");
      writeFileSync(real, "DANXBOT_DB_USER=stale\n");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(real).isSymbolicLink()).toBe(true);
      // realpath resolves through the symlink to the canonical file
      expect(realpathSync(real)).toBe(realpathSync(join(repoRoot, ".env")));
    });

    it("is a no-op when repo-root has no .env (CI / fresh-clone path)", async () => {
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).resolves.toBeUndefined();
      expect(existsSync(join(worktreeRoot, ".env"))).toBe(false);
    });

    it("is a no-op when the worktree directory does not exist", async () => {
      seedRepoEnv();
      rmSync(worktreeRoot, { recursive: true, force: true });
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).resolves.toBeUndefined();
      expect(existsSync(join(worktreeRoot, ".env"))).toBe(false);
    });

    it("symlink target is the canonical (realpath) repo-root .env", async () => {
      // When the operator's repo root is itself a symlink (host vs
      // container path), the canonical comparison still works and the
      // helper does not loop creating + replacing on every call.
      seedRepoEnv();
      const symlinkedRoot = join(workArea, "repo-via-symlink");
      symlinkSync(repoRoot, symlinkedRoot, "dir");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({
        localPath: symlinkedRoot,
        hostPath: symlinkedRoot,
      });
      const linkPath = join(
        symlinkedRoot,
        ".danxbot",
        "worktrees",
        "alice",
        ".env",
      );
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      const inodeBefore = lstatSync(linkPath).ino;
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(linkPath).ino).toBe(inodeBefore);
    });

    it("readlink target points at <repoRoot>/.env (the literal path stored in the link)", async () => {
      seedRepoEnv();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, ".env");
      // The symlink target stored on disk is the literal path we passed
      // in (not the realpath). DX-230 portability — same contract as
      // node_modules: runtime-agnostic on host↔docker swaps as long as
      // the operator configures a mirror-bind.
      expect(readlinkSync(link)).toBe(join(repoRoot, ".env"));
    });

    it("bootstrap + ensureProvisioned land BOTH symlinks atomically (umbrella guarantee)", async () => {
      // Single-call coverage for `provisionWorktreeArtifacts` —
      // protects against a future refactor that drops one of the two
      // `provision*` calls from the umbrella.
      mkdirSync(join(repoRoot, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(repoRoot, "node_modules", ".bin", "tsx"), "#!fake\n");
      seedRepoEnv();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(
        lstatSync(join(worktreeRoot, "node_modules")).isSymbolicLink(),
      ).toBe(true);
      expect(lstatSync(join(worktreeRoot, ".env")).isSymbolicLink()).toBe(true);
    });

    it("host-mode override: DANXBOT_PLATFORM_DB_{HOST,PORT} flow to the admin pg client", async () => {
      // Parent .env carries the docker-network DB_HOST (`pgsql`) the
      // shared sail network resolves. On host-mode the operator's
      // `make launch-worker-host` exports DANXBOT_PLATFORM_DB_HOST /
      // DANXBOT_PLATFORM_DB_PORT after sniffing `docker port`; the
      // umbrella MUST honour those so the admin client opens against
      // the host-mapped port. Without the override, the connect targets
      // an unresolvable docker name and boot hangs (real symptom on
      // 2026-05-16 — `ensureWorktreesProvisioned` timed out 3/3).
      writeFileSync(
        join(repoRoot, ".env"),
        "DB_CONNECTION=pgsql\nDB_DATABASE=laravel\nDB_USERNAME=sail\nDB_PASSWORD=p\nDB_HOST=pgsql\n",
      );
      const prevHost = process.env.DANXBOT_PLATFORM_DB_HOST;
      const prevPort = process.env.DANXBOT_PLATFORM_DB_PORT;
      process.env.DANXBOT_PLATFORM_DB_HOST = "127.0.0.1";
      process.env.DANXBOT_PLATFORM_DB_PORT = "15432";
      const spy = vi
        .spyOn(worktreeDatabase, "provisionWorktreeDatabase")
        .mockResolvedValue({ kind: "skipped", reason: "test-stub" });
      try {
        const wm = createWorktreeManager(fakeRunner());
        const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
        await wm.ensureProvisioned(ctx, "alice");
        expect(spy).toHaveBeenCalledTimes(1);
        const call = spy.mock.calls[0][0];
        expect(call.pgHostOverride).toBe("127.0.0.1");
        expect(call.pgPortOverride).toBe(15432);
      } finally {
        spy.mockRestore();
        if (prevHost === undefined) delete process.env.DANXBOT_PLATFORM_DB_HOST;
        else process.env.DANXBOT_PLATFORM_DB_HOST = prevHost;
        if (prevPort === undefined) delete process.env.DANXBOT_PLATFORM_DB_PORT;
        else process.env.DANXBOT_PLATFORM_DB_PORT = prevPort;
      }
    });

    it("DX-571: skips the .env symlink when the consumer repo is Laravel-pgsql", async () => {
      // Laravel-pgsql consumer repos own a REAL per-worktree .env written
      // by `provisionWorktreeDatabase` — `provisionEnvFile` MUST NOT
      // symlink over it. Seeding the parent .env with `DB_CONNECTION=pgsql`
      // routes the umbrella's call to `provisionWorktreeDatabase` first
      // (which throws here without a real Postgres) — the assertion is
      // that `provisionEnvFile`'s own work is gated AND the umbrella
      // surfaces the DB-step failure rather than silently re-coupling
      // the worktree to the parent .env.
      writeFileSync(
        join(repoRoot, ".env"),
        "DB_CONNECTION=pgsql\nDB_DATABASE=laravel\nDB_USERNAME=sail\nDB_PASSWORD=p\nDB_HOST=does-not-resolve.invalid\n",
      );
      const wm = createWorktreeManager(fakeRunner());
      const ctxWithLaravel = makeRepoContext({
        localPath: repoRoot,
        hostPath: repoRoot,
      });
      // The DB step throws against the unresolvable host — that is the
      // expected fail-loud behavior. Assert it propagates AND that no
      // symlink got created in the meantime.
      await expect(
        wm.ensureProvisioned(ctxWithLaravel, "alice"),
      ).rejects.toBeDefined();
      expect(existsSync(join(worktreeRoot, ".env"))).toBe(false);
    });
  });

  describe("provisionSafeResetScript / ensureProvisioned (DX-572)", () => {
    // Phase 2 of DX-570 — copy the consumer repo's
    // <repoRoot>/.danxbot/safe-reset-db.sh into the worktree and
    // chmod +x it. Idempotent. Missing template = silent skip
    // (non-DB consumer repos see no behavior change).
    let workArea: string;
    let repoRoot: string;
    let worktreeRoot: string;
    const TEMPLATE_REL = join(".danxbot", "safe-reset-db.sh");
    const TEMPLATE_CONTENT = "#!/usr/bin/env bash\necho safe-reset-stub\n";

    function seedRootRepo(): void {
      // node_modules sentinel so provisionNodeModules does not throw.
      writeFileSync(
        join(repoRoot, "package.json"),
        JSON.stringify({ name: "test-repo", devDependencies: { tsx: "^4.0.0" } }),
      );
      mkdirSync(join(repoRoot, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(repoRoot, "node_modules", ".bin", "tsx"), "#!fake\n");
      writeFileSync(join(repoRoot, ".env"), "FAKE_KEY=1\n");
    }

    function seedTemplate(content = TEMPLATE_CONTENT): void {
      mkdirSync(join(repoRoot, ".danxbot"), { recursive: true });
      writeFileSync(join(repoRoot, TEMPLATE_REL), content);
    }

    beforeEach(() => {
      workArea = mkdtempSync(join(tmpdir(), "danxbot-prov-safe-reset-"));
      repoRoot = join(workArea, "repo");
      worktreeRoot = join(repoRoot, ".danxbot", "worktrees", "alice");
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });
      seedRootRepo();
    });

    afterEach(() => {
      rmSync(workArea, { recursive: true, force: true });
    });

    it("copies the template into the worktree and chmods it executable", async () => {
      seedTemplate();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const dest = join(worktreeRoot, TEMPLATE_REL);
      expect(existsSync(dest)).toBe(true);
      // Real file (not a symlink) — the script must be edit-safe per
      // worktree without rippling back into the consumer repo template.
      expect(lstatSync(dest).isSymbolicLink()).toBe(false);
      expect(readFileSync(dest, "utf8")).toBe(TEMPLATE_CONTENT);
      expect((statSync(dest).mode & 0o111) !== 0).toBe(true);
    });

    it("silently skips when the consumer repo has no template (non-DB repo path)", async () => {
      // No seedTemplate() call — non-DB consumer repos see no behavior
      // change AND boot does not fail.
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).resolves.toBeUndefined();
      expect(existsSync(join(worktreeRoot, TEMPLATE_REL))).toBe(false);
    });

    it("is idempotent and propagates template edits on re-provision", async () => {
      seedTemplate("#!/usr/bin/env bash\necho v1\n");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const dest = join(worktreeRoot, TEMPLATE_REL);
      expect(readFileSync(dest, "utf8")).toBe("#!/usr/bin/env bash\necho v1\n");

      // Edit the template — re-provisioning replaces the worktree copy
      // (the AC's "edit the template, re-run provisioning, change
      // propagates" contract).
      writeFileSync(join(repoRoot, TEMPLATE_REL), "#!/usr/bin/env bash\necho v2\n");
      await wm.ensureProvisioned(ctx, "alice");
      expect(readFileSync(dest, "utf8")).toBe("#!/usr/bin/env bash\necho v2\n");
      expect((statSync(dest).mode & 0o111) !== 0).toBe(true);
    });

    it("replaces a stale worktree copy whose exec bit was stripped", async () => {
      // Operator hand-runs `chmod -x` (or a previous provisioner bug
      // wrote without the exec bit) — the post-condition stat catches
      // it AND the re-provision restores the bit. Asserts the
      // validator surface from AC #6.
      seedTemplate();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const dest = join(worktreeRoot, TEMPLATE_REL);
      chmodSync(dest, 0o644);
      expect((statSync(dest).mode & 0o111) === 0).toBe(true);
      await wm.ensureProvisioned(ctx, "alice");
      expect((statSync(dest).mode & 0o111) !== 0).toBe(true);
    });
  });

  describe("provisionDashboardNodeModules / ensureProvisioned (DX-314)", () => {
    let workArea: string;
    let repoRoot: string;
    let worktreeRoot: string;

    function seedRootRepo(): void {
      // Root node_modules + package.json so provisionNodeModules's
      // sentinel-gated step does not throw or skip — its branch is
      // covered elsewhere; this block focuses on the dashboard branch.
      writeFileSync(
        join(repoRoot, "package.json"),
        JSON.stringify({ name: "test-repo", devDependencies: { tsx: "^4.0.0" } }),
      );
      mkdirSync(join(repoRoot, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(repoRoot, "node_modules", ".bin", "tsx"), "#!fake\n");
    }

    function seedDashboard(): void {
      // Dashboard subpackage with its own package.json AND its own
      // node_modules shipping @vitejs/plugin-vue (the AC1 sentinel
      // that proves the symlink resolves into the dashboard tree).
      mkdirSync(join(repoRoot, "dashboard"), { recursive: true });
      writeFileSync(
        join(repoRoot, "dashboard", "package.json"),
        JSON.stringify({ name: "dashboard", dependencies: { vue: "^3.0.0" } }),
      );
      mkdirSync(
        join(repoRoot, "dashboard", "node_modules", "@vitejs", "plugin-vue"),
        { recursive: true },
      );
      writeFileSync(
        join(
          repoRoot,
          "dashboard",
          "node_modules",
          "@vitejs",
          "plugin-vue",
          "package.json",
        ),
        JSON.stringify({ name: "@vitejs/plugin-vue", version: "5.0.0" }),
      );
      // Worktree's dashboard subdir — `git worktree add` creates this
      // from the checked-in dashboard tree; mkdir mimics that here.
      mkdirSync(join(worktreeRoot, "dashboard"), { recursive: true });
    }

    beforeEach(() => {
      workArea = mkdtempSync(join(tmpdir(), "danxbot-prov-dashboard-"));
      repoRoot = join(workArea, "repo");
      worktreeRoot = join(repoRoot, ".danxbot", "worktrees", "alice");
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });
      seedRootRepo();
    });

    afterEach(() => {
      rmSync(workArea, { recursive: true, force: true });
    });

    it("creates dashboard/node_modules symlink when dashboard/package.json is present", async () => {
      seedDashboard();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, "dashboard", "node_modules");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(
        realpathSync(join(repoRoot, "dashboard", "node_modules")),
      );
    });

    it("dashboard/@vitejs/plugin-vue is reachable through the symlink (AC1 sentinel)", async () => {
      seedDashboard();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(
        existsSync(
          join(
            worktreeRoot,
            "dashboard",
            "node_modules",
            "@vitejs",
            "plugin-vue",
          ),
        ),
      ).toBe(true);
    });

    it("is a no-op when repo has no dashboard/package.json (connected repo without dashboard subpackage)", async () => {
      // No seedDashboard() — repo has no dashboard subdir. The
      // existing root provisioning still runs; only the dashboard
      // branch is gated off.
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(
        existsSync(join(worktreeRoot, "dashboard", "node_modules")),
      ).toBe(false);
    });

    it("is idempotent — running twice leaves the same dashboard/node_modules symlink", async () => {
      seedDashboard();
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, "dashboard", "node_modules");
      const inodeBefore = lstatSync(link).ino;
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(link).ino).toBe(inodeBefore);
    });

    it("replaces a broken dashboard/node_modules symlink with a fresh one", async () => {
      seedDashboard();
      const link = join(worktreeRoot, "dashboard", "node_modules");
      symlinkSync(join(workArea, "does-not-exist"), link, "dir");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(
        realpathSync(join(repoRoot, "dashboard", "node_modules")),
      );
    });

    it("replaces a real dashboard/node_modules directory with the symlink", async () => {
      seedDashboard();
      const real = join(worktreeRoot, "dashboard", "node_modules");
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, "stale.txt"), "stale\n");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(real).isSymbolicLink()).toBe(true);
      expect(existsSync(join(real, "stale.txt"))).toBe(false);
    });

    it("is a no-op when the worktree has no dashboard/ subdir (no parent for the symlink — worktree predates dashboard subpackage or operator deleted it)", async () => {
      // Source-side fully populated, but `<worktreeRoot>/dashboard` is
      // absent. `symlinkSync` would ENOENT on a missing parent;
      // production bootstrap creates the dir via `git worktree add`,
      // but a defensive skip keeps the umbrella from throwing in the
      // edge case (operator-deleted dir, branch predating the
      // dashboard subpackage). Mirrors how `provisionIssuesSymlink`
      // handles a missing `<worktree>/.danxbot` parent.
      mkdirSync(join(repoRoot, "dashboard", "node_modules", "@vitejs", "plugin-vue"), { recursive: true });
      writeFileSync(
        join(repoRoot, "dashboard", "package.json"),
        JSON.stringify({ name: "dashboard" }),
      );
      // Intentionally NOT mkdir-ing <worktreeRoot>/dashboard.
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).resolves.toBeUndefined();
      expect(
        existsSync(join(worktreeRoot, "dashboard", "node_modules")),
      ).toBe(false);
    });

    it("umbrella: ensureProvisioned lands ALL provisioned artifacts in one call (root nm + dashboard nm + .env)", async () => {
      // Regression guard for `provisionWorktreeArtifacts` — protects
      // against a future refactor that drops any single provisioner
      // from the umbrella. Extends the DX-244 atomicity test to cover
      // the new DX-314 dashboard slot.
      seedDashboard();
      writeFileSync(join(repoRoot, ".env"), "DANXBOT_DB_USER=fake\n");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(
        lstatSync(join(worktreeRoot, "node_modules")).isSymbolicLink(),
      ).toBe(true);
      expect(
        lstatSync(join(worktreeRoot, "dashboard", "node_modules")).isSymbolicLink(),
      ).toBe(true);
      expect(lstatSync(join(worktreeRoot, ".env")).isSymbolicLink()).toBe(true);
    });

    it("is a no-op when dashboard/package.json is present but dashboard/node_modules is absent (operator has not run npm install in dashboard yet)", async () => {
      // package.json present, source node_modules absent — silent
      // skip mirrors how provisionNodeModules handles a missing
      // repo-root node_modules. Worker can't run dashboard tests in
      // this state either way, so no fail-loud is added here.
      mkdirSync(join(repoRoot, "dashboard"), { recursive: true });
      writeFileSync(
        join(repoRoot, "dashboard", "package.json"),
        JSON.stringify({ name: "dashboard" }),
      );
      mkdirSync(join(worktreeRoot, "dashboard"), { recursive: true });
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).resolves.toBeUndefined();
      expect(
        existsSync(join(worktreeRoot, "dashboard", "node_modules")),
      ).toBe(false);
    });
  });

  describe("provisionWorktreeWorkspaces — symlinks inside workspaces", () => {
    let workArea: string;
    let repoRoot: string;
    let worktreeRoot: string;

    beforeEach(() => {
      workArea = mkdtempSync(join(tmpdir(), "danxbot-prov-ws-"));
      repoRoot = join(workArea, "repo");
      worktreeRoot = join(repoRoot, ".danxbot", "worktrees", "alice");
      mkdirSync(worktreeRoot, { recursive: true });
    });

    afterEach(() => {
      rmSync(workArea, { recursive: true, force: true });
    });

    it("copies a mcp-servers symlink verbatim, does not trip cpSync circularity guard", async () => {
      // Regression: without `verbatimSymlinks: true`, Node's cpSync
      // realpath-resolves a symlink-to-dir target and trips its own
      // circularity guard (`ERR_FS_CP_EINVAL` — "Cannot copy <target>
      // to a subdirectory of self <target>") when src + dest tree share
      // an ancestor with the symlink target. Repro geometry: workspace
      // dir contains a `mcp-servers` symlink to an external dir under
      // the same `workArea`.
      const mcpServersHost = join(workArea, "mcp-servers");
      mkdirSync(mcpServersHost, { recursive: true });
      writeFileSync(join(mcpServersHost, "server.js"), "// real\n");
      const wsSrc = join(repoRoot, ".danxbot", "workspaces", "board-chat");
      mkdirSync(wsSrc, { recursive: true });
      writeFileSync(join(wsSrc, "workspace.yml"), "name: board-chat\n");
      symlinkSync(mcpServersHost, join(wsSrc, "mcp-servers"), "dir");

      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      // First call — fresh provisioning.
      await wm.ensureProvisioned(ctx, "alice");
      // Second call — idempotent re-run. Production hits this every
      // dispatch (every `ensureProvisioned`); the old cpSync path
      // ERR_FS_CP_EINVAL'd here because dest mcp-servers symlink
      // already existed and its realpath collided with src.
      await wm.ensureProvisioned(ctx, "alice");

      const link = join(
        worktreeRoot,
        ".danxbot",
        "workspaces",
        "board-chat",
        "mcp-servers",
      );
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(mcpServersHost);
      // Non-symlink content mirrors normally.
      expect(
        existsSync(
          join(worktreeRoot, ".danxbot", "workspaces", "board-chat", "workspace.yml"),
        ),
      ).toBe(true);
    });
  });

  describe("provisionIssuesSymlink (DX-309)", () => {
    let workArea: string;
    let repoRoot: string;
    let worktreeRoot: string;

    beforeEach(() => {
      workArea = mkdtempSync(join(tmpdir(), "danxbot-prov-issues-"));
      repoRoot = join(workArea, "repo");
      worktreeRoot = join(repoRoot, ".danxbot", "worktrees", "alice");
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(join(repoRoot, ".danxbot", "issues", "open"), {
        recursive: true,
      });
      mkdirSync(join(worktreeRoot, ".danxbot"), { recursive: true });
    });

    afterEach(() => {
      rmSync(workArea, { recursive: true, force: true });
    });

    it("symlinks <worktree>/.danxbot/issues → <main>/.danxbot/issues", async () => {
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, ".danxbot", "issues");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(
        realpathSync(join(repoRoot, ".danxbot", "issues")),
      );
    });

    it("is idempotent — running twice leaves the same symlink", async () => {
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const link = join(worktreeRoot, ".danxbot", "issues");
      const inodeBefore = lstatSync(link).ino;
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(link).ino).toBe(inodeBefore);
    });

    it("preserves a real issues/ dir with orphan YAMLs under <link>.pre-symlink-<ts>", async () => {
      const realIssues = join(worktreeRoot, ".danxbot", "issues");
      mkdirSync(join(realIssues, "open"), { recursive: true });
      // Orphan = a YAML absent from main.
      writeFileSync(
        join(realIssues, "open", "DX-WORKTREE-ONLY.yml"),
        "id: orphan\n",
      );
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");

      // Link is in place.
      expect(lstatSync(realIssues).isSymbolicLink()).toBe(true);

      // Backup carries the orphan.
      const parent = join(worktreeRoot, ".danxbot");
      const entries = readdirSync(parent);
      const backup = entries.find((e) => e.startsWith("issues.pre-symlink-"));
      expect(backup).toBeDefined();
      expect(
        existsSync(join(parent, backup!, "open", "DX-WORKTREE-ONLY.yml")),
      ).toBe(true);
    });

    it("materializes <worktree>/.danxbot/workspaces/<name>/ on bootstrap (no race with poller tick)", async () => {
      // DX-309 blocker #2: dispatch after bootstrap but before the
      // poller tick mirrored workspaces would WorkspaceNotFoundError.
      // provisionWorktreeArtifacts runs from bootstrap/syncWorktree/
      // ensureProvisioned, so the worktree is dispatch-ready
      // immediately.
      mkdirSync(join(repoRoot, ".danxbot", "workspaces", "issue-worker"), {
        recursive: true,
      });
      writeFileSync(
        join(repoRoot, ".danxbot", "workspaces", "issue-worker", "workspace.yml"),
        "name: issue-worker\n",
      );
      mkdirSync(
        join(repoRoot, ".danxbot", "workspaces", "issue-worker", ".claude"),
        { recursive: true },
      );
      writeFileSync(
        join(
          repoRoot,
          ".danxbot",
          "workspaces",
          "issue-worker",
          ".claude",
          "settings.json",
        ),
        "{}",
      );
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");

      const dest = join(
        worktreeRoot,
        ".danxbot",
        "workspaces",
        "issue-worker",
      );
      expect(existsSync(join(dest, "workspace.yml"))).toBe(true);
      expect(existsSync(join(dest, ".claude", "settings.json"))).toBe(true);
      // Real dir, NOT a symlink (load-bearing — symlink would make
      // claude's cwd resolve back to main).
      expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    });

    it("drops an empty issues/ dir without backup (nothing to preserve)", async () => {
      const realIssues = join(worktreeRoot, ".danxbot", "issues");
      mkdirSync(realIssues, { recursive: true });
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");

      expect(lstatSync(realIssues).isSymbolicLink()).toBe(true);
      const parent = join(worktreeRoot, ".danxbot");
      const entries = readdirSync(parent);
      expect(
        entries.some((e) => e.startsWith("issues.pre-symlink-")),
      ).toBe(false);
    });
  });

  describe("provisionSymlink defense-in-depth (DX-244)", () => {
    // The `expectedRoot` check in `provisionSymlink` exists to stop a
    // future refactor that lets a caller pass an arbitrary worktree
    // path from silently destroying whatever lives at the target. The
    // public surface (`bootstrap` / `ensureProvisioned` / etc.) always
    // routes through `worktreePath()` which builds a path under
    // `<repoRoot>/.danxbot/worktrees/<safe-name>`, so the throw is
    // unreachable through normal paths. Test the helper directly so a
    // regression that REMOVES the guard fails CI loudly.
    let workArea: string;
    let repoRoot: string;
    let outsideDir: string;

    beforeEach(() => {
      workArea = mkdtempSync(join(tmpdir(), "danxbot-prov-guard-"));
      repoRoot = join(workArea, "repo");
      outsideDir = join(workArea, "outside-the-worktree-tree");
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(workArea, { recursive: true, force: true });
    });

    it("throws when the link path is outside <repoRoot>/.danxbot/worktrees/", async () => {
      // Use require() inside the test scope so we keep the import
      // surface at the top of the file uncluttered.
      const { provisionSymlink } = await import("./worktree-manager.js");
      expect(() =>
        provisionSymlink(repoRoot, outsideDir, ".env", "file", "test"),
      ).toThrow(WorktreeError);
      expect(() =>
        provisionSymlink(repoRoot, outsideDir, ".env", "file", "test"),
      ).toThrow(/refusing to operate on .* must be rooted under/);
    });

    it("throws even when the link path is a sibling of the worktrees subtree (not just any outside path)", async () => {
      // E.g. `<repoRoot>/.danxbot/something-else/alice` — close but
      // not under `worktrees/`. The `startsWith` guard must catch it.
      const { provisionSymlink } = await import("./worktree-manager.js");
      const sibling = join(repoRoot, ".danxbot", "something-else", "alice");
      expect(() =>
        provisionSymlink(repoRoot, sibling, ".env", "file", "test"),
      ).toThrow(WorktreeError);
    });
  });

  describe("provisionLaravelStorageDirs (DX-500)", () => {
    let workArea: string;
    let repoRoot: string;
    let worktreeRoot: string;

    const laravelDirs = [
      "storage/framework/cache/data",
      "storage/framework/sessions",
      "storage/framework/testing",
      "storage/framework/views",
      "storage/logs",
      "bootstrap/cache",
    ];

    beforeEach(() => {
      workArea = mkdtempSync(join(tmpdir(), "danxbot-prov-laravel-"));
      repoRoot = join(workArea, "repo");
      worktreeRoot = join(repoRoot, ".danxbot", "worktrees", "alice");
      mkdirSync(worktreeRoot, { recursive: true });
    });

    afterEach(() => {
      rmSync(workArea, { recursive: true, force: true });
    });

    it("pre-creates Laravel storage dirs when worktree has artisan", async () => {
      writeFileSync(join(worktreeRoot, "artisan"), "#!/usr/bin/env php\n");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      for (const rel of laravelDirs) {
        const abs = join(worktreeRoot, rel);
        expect(existsSync(abs)).toBe(true);
        expect(lstatSync(abs).isDirectory()).toBe(true);
      }
    });

    it("is a no-op when worktree has no artisan (non-Laravel repo)", async () => {
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      for (const rel of laravelDirs) {
        expect(existsSync(join(worktreeRoot, rel))).toBe(false);
      }
    });

    it("is idempotent — second call leaves dirs intact (same inode)", async () => {
      writeFileSync(join(worktreeRoot, "artisan"), "#!/usr/bin/env php\n");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      const probe = join(worktreeRoot, "storage/framework/testing");
      const inodeBefore = lstatSync(probe).ino;
      await wm.ensureProvisioned(ctx, "alice");
      expect(lstatSync(probe).ino).toBe(inodeBefore);
    });

    it("preserves pre-existing dir contents (no clobber on second run)", async () => {
      writeFileSync(join(worktreeRoot, "artisan"), "#!/usr/bin/env php\n");
      mkdirSync(join(worktreeRoot, "storage/logs"), { recursive: true });
      const sentinel = join(worktreeRoot, "storage/logs/laravel.log");
      writeFileSync(sentinel, "sail-wrote-this\n");
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await wm.ensureProvisioned(ctx, "alice");
      expect(existsSync(sentinel)).toBe(true);
    });

    it("swallows mkdir failure on one dir, still creates the others", async () => {
      writeFileSync(join(worktreeRoot, "artisan"), "#!/usr/bin/env php\n");
      // Force ENOTDIR on storage/logs by planting a regular file at
      // `storage` so the recursive mkdir of `storage/logs` fails.
      mkdirSync(join(worktreeRoot, "storage/framework/cache/data"), {
        recursive: true,
      });
      // Replace `storage/logs`'s parent dir for a single dir to be a
      // file blocker: put a file at storage/framework/views to fail
      // its own mkdir, but leave bootstrap/cache reachable.
      writeFileSync(
        join(worktreeRoot, "storage/framework/views"),
        "blocker\n",
      );
      const wm = createWorktreeManager(fakeRunner());
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      await expect(wm.ensureProvisioned(ctx, "alice")).resolves.toBeUndefined();
      // Unaffected dirs still landed.
      expect(existsSync(join(worktreeRoot, "bootstrap/cache"))).toBe(true);
      expect(
        existsSync(join(worktreeRoot, "storage/framework/sessions")),
      ).toBe(true);
    });

    it("fires from syncWorktree path (wired into provisionWorktreeArtifacts umbrella)", async () => {
      // syncWorktree's noop branch (ahead=0, behind=0) still calls
      // provisionWorktreeArtifacts. Confirms the one-line registration
      // holds for sync callers, not only ensureProvisioned.
      writeFileSync(join(worktreeRoot, "artisan"), "#!/usr/bin/env php\n");
      const runner = fakeRunner({
        responses: [
          {
            match: "rev-list --left-right --count",
            response: { stdout: "0\t0\n" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);
      const ctx = makeRepoContext({ localPath: repoRoot, hostPath: repoRoot });
      const result = await wm.syncWorktree(ctx, "alice");
      expect(result.kind).toBe("noop");
      expect(
        existsSync(join(worktreeRoot, "storage/framework/testing")),
      ).toBe(true);
      expect(existsSync(join(worktreeRoot, "bootstrap/cache"))).toBe(true);
    });
  });

  describe("hostPath != localPath (DX-230 portability)", () => {
    const splitCtx = makeRepoContext({
      localPath: "/container/path",
      hostPath: "/host/canonical/path",
    });
    const splitWorktree = "/host/canonical/path/.danxbot/worktrees/alice";

    it("worktreePath roots under hostPath, not localPath", () => {
      const wm = createWorktreeManager(fakeRunner());
      expect(wm.worktreePath(splitCtx, "alice")).toBe(splitWorktree);
    });

    it("bootstrap runs git with cwd=hostPath", async () => {
      const runner = fakeRunner();
      const wm = createWorktreeManager(runner);
      await wm.bootstrap(splitCtx, "alice");
      for (const call of runner.calls) {
        expect(call.cwd).toBe(splitCtx.hostPath);
      }
    });

    it("teardown runs git with cwd=hostPath", async () => {
      const runner = fakeRunner();
      const wm = createWorktreeManager(runner);
      await wm.teardown(splitCtx, "alice");
      for (const call of runner.calls) {
        expect(call.cwd).toBe(splitCtx.hostPath);
      }
    });

    it("syncWorktree runs git with cwd=worktreePath (rooted under hostPath)", async () => {
      const runner = fakeRunner({
        responses: [
          { match: "fetch origin", response: { stdout: "" } },
          {
            match: "rev-list --left-right --count",
            response: { stdout: "0\t0\n" },
          },
        ],
      });
      const wm = createWorktreeManager(runner);
      await wm.syncWorktree(splitCtx, "alice");
      for (const call of runner.calls) {
        expect(call.cwd).toBe(splitWorktree);
      }
    });
  });
});
