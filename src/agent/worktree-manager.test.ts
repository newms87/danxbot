/**
 * Unit tests for WorktreeManager — uses a fake `GitRunner` so we can assert
 * the exact argv shape passed to git without spawning a process. The real
 * `defaultGitRunner` (backed by `child_process.execFile`) is exercised by
 * the integration suite at `src/__tests__/integration/worktree-manager.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
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

    it("does not call `git fetch` (validation is purely local against cached refs)", async () => {
      const runner = fakeRunner();
      const wm = createWorktreeManager(runner);

      await wm.validate(ctx, "alice");

      expect(
        runner.calls.some((c) => c.args[0] === "fetch"),
      ).toBe(false);
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
        await expect(wm.validate(ctx, name)).rejects.toThrow(WorktreeError);
        await expect(wm.syncWorktree(ctx, name)).rejects.toThrow(WorktreeError);
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

    it("validate runs git with cwd=worktreePath (rooted under hostPath)", async () => {
      const runner = fakeRunner();
      const wm = createWorktreeManager(runner);
      await wm.validate(splitCtx, "alice");
      for (const call of runner.calls) {
        expect(call.cwd).toBe(splitWorktree);
      }
    });
  });
});
