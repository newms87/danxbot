/**
 * WorktreeManager — per-agent git worktree lifecycle (DX-161 / multi-worker
 * dispatch epic DX-158).
 *
 * Each named agent owns a persistent git worktree at
 * `<repo>/.danxbot/worktrees/<agentName>/` and a same-named branch. The
 * manager exposes four operations the dispatch layer + agent CRUD endpoints
 * use to keep that worktree healthy across dispatches:
 *
 *   - `bootstrap(ctx, name)` — idempotent `git worktree add -B`. Called on
 *     `POST /api/agents` and lazily on first dispatch (in case an agent was
 *     hand-edited into `settings.json`).
 *   - `validate(ctx, name)` — pre-dispatch sanity check. Returns `clean`
 *     when the worktree has no uncommitted changes and zero local commits
 *     ahead of `origin/main`; otherwise `dirty` with `{porcelain, ahead,
 *     behind}` so the caller can build a recovery prompt.
 *   - `resetClean(ctx, name)` — `git checkout <name>; git reset --hard
 *     origin/main`. Only safe on `validate() === clean` (caller's
 *     responsibility — we don't re-check inside).
 *   - `teardown(ctx, name)` — `git worktree remove --force <path>` plus
 *     best-effort branch deletion (local + remote). Called on
 *     `DELETE /api/agents/:name`.
 *
 * Branch-recovery dispatch — when `validate()` returns dirty, the dispatch
 * layer spawns a recovery-mode prompt instead of the next normal `work`
 * card. The recovery agent reads the porcelain + ahead count, finishes any
 * WIP, commits, and exits. The worker re-runs `validate()` afterward; still
 * dirty → file a Needs Help comment on the last-modified card. See
 * `src/dispatch/recovery-mode.ts`.
 *
 * Git execution is injected via `GitRunner` so unit tests can stub commands
 * deterministically while integration tests run against real git tmpdirs.
 * The default runner uses `node:child_process.execFile` (no shell — argv-
 * shaped, immune to argument-injection in agent names).
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { AGENT_NAME_SHAPE } from "../settings-file.js";
import type { RepoConfig } from "../types.js";

/**
 * Minimal repo shape — just `localPath`. Both `RepoConfig` (dashboard) and
 * `RepoContext` (worker) satisfy this via structural subtyping, so callers
 * can pass whichever they have without an adapter layer.
 */
export type WorktreeRepo = Pick<RepoConfig, "localPath">;

const execFile = promisify(execFileCb);
const log = createLogger("worktree-manager");

/**
 * Validation outcome surfaced to the dispatch layer.
 *
 * - `clean` — worktree has no uncommitted changes AND zero commits ahead of
 *   `origin/main`. Behind-only is still clean (caller's `resetClean` will
 *   fast-forward without losing work).
 * - `dirty` — caller MUST NOT touch the working tree. The recovery-mode
 *   dispatch reads `details` to render the porcelain + ahead/behind context
 *   into the prompt so the agent knows exactly what to finish.
 */
export type ValidationResult =
  | { state: "clean" }
  | {
      state: "dirty";
      reason: string;
      details: {
        /** Verbatim `git status --porcelain` output (may be empty when ahead-only). */
        porcelain: string;
        /** Commits on the agent's branch not on `origin/main`. */
        ahead: number;
        /** Commits on `origin/main` not on the agent's branch. */
        behind: number;
      };
    };

export interface WorktreeManager {
  /** Absolute path of an agent's worktree, derived from `ctx.localPath`. */
  worktreePath(ctx: WorktreeRepo, agentName: string): string;
  /** Idempotent. Re-running on an existing worktree is a no-op. */
  bootstrap(ctx: WorktreeRepo, agentName: string): Promise<void>;
  /**
   * Best-effort. Worktree removal failures throw; branch deletion failures
   * (local + remote) are logged + swallowed because the worker may not have
   * push permission to a freshly-created remote branch.
   */
  teardown(ctx: WorktreeRepo, agentName: string): Promise<void>;
  /** Never throws on a recoverable git state — returns `dirty` instead. */
  validate(ctx: WorktreeRepo, agentName: string): Promise<ValidationResult>;
  /**
   * Caller's responsibility to call only when `validate() === clean`. We do
   * not re-validate; the caller usually does it as one combined gate.
   */
  resetClean(ctx: WorktreeRepo, agentName: string): Promise<void>;
}

/** Thin abstraction over `git` invocation so tests can stub command results. */
export interface GitRunner {
  /**
   * Run `git <args>` with cwd. Returns stdout/stderr/code regardless of exit
   * status — the manager decides per call whether non-zero is fatal.
   */
  run(
    cwd: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** Default runner — `node:child_process.execFile` with no shell. */
export const defaultGitRunner: GitRunner = {
  async run(cwd, args) {
    try {
      const { stdout, stderr } = await execFile("git", [...args], {
        cwd,
        // 10 MB ceiling — far above any porcelain or `worktree list` output.
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
      });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      // `execFile` rejects on non-zero exit; the rejected error carries
      // `code` + stdout/stderr per Node docs.
      const e = err as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      const code = typeof e.code === "number" ? e.code : 1;
      return {
        stdout: typeof e.stdout === "string" ? e.stdout : "",
        stderr: typeof e.stderr === "string" ? e.stderr : String(e.message),
        code,
      };
    }
  },
};

/**
 * Defense-in-depth: every method re-validates the agent name against
 * `AGENT_NAME_SHAPE` (the same regex `settings-file.ts` enforces on
 * agent CRUD). The shape is URL-safe, branch-name-safe, and shell-arg-
 * safe (no spaces, no `--` prefix, no path-traversal). Without this
 * check a manager-direct caller (Phase 5+ poller, future agent CRUD
 * paths) could pass a name that bypassed the dashboard validator.
 * `execFile` is shell-free so injection is impossible regardless, but
 * a malformed name still corrupts the worktree directory layout —
 * better to fail-loud at the boundary.
 */
function assertAgentName(agentName: string): void {
  if (!AGENT_NAME_SHAPE.test(agentName)) {
    throw new WorktreeError(
      `WorktreeManager: invalid agent name ${JSON.stringify(agentName)} — must match ${AGENT_NAME_SHAPE}`,
    );
  }
}

/** Construct a manager. Defaults to the real git runner. */
export function createWorktreeManager(
  runner: GitRunner = defaultGitRunner,
): WorktreeManager {
  return {
    worktreePath(ctx, agentName) {
      assertAgentName(agentName);
      return join(ctx.localPath, ".danxbot", "worktrees", agentName);
    },

    async bootstrap(ctx, agentName) {
      assertAgentName(agentName);
      const path = this.worktreePath(ctx, agentName);

      // Idempotency — `git worktree list --porcelain` emits one
      // "worktree <path>" line per registered worktree. If we find ours,
      // bootstrap is a no-op.
      const list = await runner.run(ctx.localPath, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (list.code === 0 && worktreeListIncludes(list.stdout, path)) {
        log.debug(`bootstrap(${agentName}): already exists at ${path}`);
        return;
      }

      // Refresh origin/main so the new branch tracks current upstream.
      // Failure here is fatal — without origin/main we can't create the
      // worktree at the right ref.
      const fetched = await runner.run(ctx.localPath, ["fetch", "origin"]);
      if (fetched.code !== 0) {
        throw new WorktreeError(
          `bootstrap(${agentName}): git fetch origin failed: ${fetched.stderr.trim()}`,
        );
      }

      // `-B` creates the branch if missing or resets it to `origin/main` if
      // it already exists (e.g. orphaned from a prior teardown that lost
      // the worktree but left the local branch around).
      const created = await runner.run(ctx.localPath, [
        "worktree",
        "add",
        "-B",
        agentName,
        path,
        "origin/main",
      ]);
      if (created.code !== 0) {
        throw new WorktreeError(
          `bootstrap(${agentName}): git worktree add failed: ${created.stderr.trim()}`,
        );
      }
      log.info(`bootstrap(${agentName}): created worktree at ${path}`);
    },

    async teardown(ctx, agentName) {
      assertAgentName(agentName);
      const path = this.worktreePath(ctx, agentName);

      // `--force` so a worktree with uncommitted changes still tears down
      // (operator deleted the agent — they accept losing in-flight WIP).
      const removed = await runner.run(ctx.localPath, [
        "worktree",
        "remove",
        "--force",
        path,
      ]);
      // Non-zero is acceptable when the worktree was already missing — we
      // still want to clean up the branch. Real failures (lock contention,
      // concurrent ops) surface as the manager's only thrown error.
      if (
        removed.code !== 0 &&
        !/not a working tree|does not exist/i.test(
          removed.stderr + removed.stdout,
        )
      ) {
        throw new WorktreeError(
          `teardown(${agentName}): git worktree remove failed: ${removed.stderr.trim()}`,
        );
      }

      // Best-effort branch deletion. A worker without push permission to
      // the agent's branch must not block the operator's DELETE — they
      // can clean up the orphan branch later. Local + remote both
      // best-effort; both log on failure.
      const localDel = await runner.run(ctx.localPath, [
        "branch",
        "-D",
        agentName,
      ]);
      if (localDel.code !== 0) {
        log.warn(
          `teardown(${agentName}): local branch delete failed: ${localDel.stderr.trim()}`,
        );
      }
      const remoteDel = await runner.run(ctx.localPath, [
        "push",
        "origin",
        "--delete",
        agentName,
      ]);
      if (remoteDel.code !== 0) {
        // Common case for never-pushed agent branches — downgrade to
        // debug to avoid spamming the worker log on every teardown.
        // Real failures (auth, network) still surface as warn.
        const stderr = remoteDel.stderr.trim();
        const isMissingRef = /remote ref does not exist|unable to delete .* remote ref does not exist/i.test(
          stderr,
        );
        if (isMissingRef) {
          log.debug(
            `teardown(${agentName}): remote branch never existed — skipping`,
          );
        } else {
          log.warn(
            `teardown(${agentName}): remote branch delete failed: ${stderr}`,
          );
        }
      }
      log.info(`teardown(${agentName}): removed worktree at ${path}`);
    },

    async validate(ctx, agentName) {
      assertAgentName(agentName);
      const path = this.worktreePath(ctx, agentName);

      // `git fetch origin` keeps `origin/main` current so ahead/behind
      // are measured against the latest upstream.
      const fetched = await runner.run(path, ["fetch", "origin"]);
      if (fetched.code !== 0) {
        // Network failure is treated as dirty — the recovery-mode prompt
        // will surface it and the agent can decide how to proceed (likely
        // re-try fetch and continue). Better to defer than risk a stale
        // origin/main causing a wrong-direction reset.
        return {
          state: "dirty",
          reason: `git fetch origin failed: ${fetched.stderr.trim()}`,
          details: { porcelain: "", ahead: 0, behind: 0 },
        };
      }

      const porcelainResult = await runner.run(path, [
        "status",
        "--porcelain",
      ]);
      const porcelain = porcelainResult.stdout.trim();

      const aheadResult = await runner.run(path, [
        "rev-list",
        "--count",
        "origin/main..HEAD",
      ]);
      const behindResult = await runner.run(path, [
        "rev-list",
        "--count",
        "HEAD..origin/main",
      ]);
      const ahead = parseCount(aheadResult.stdout);
      const behind = parseCount(behindResult.stdout);

      const details = { porcelain, ahead, behind };

      if (porcelain.length > 0) {
        return {
          state: "dirty",
          reason: "uncommitted changes",
          details,
        };
      }
      if (ahead > 0) {
        return {
          state: "dirty",
          reason: "branch has unmerged commits",
          details,
        };
      }
      // Behind-only is clean — `resetClean` will fast-forward without
      // touching local work.
      return { state: "clean" };
    },

    async resetClean(ctx, agentName) {
      assertAgentName(agentName);
      const path = this.worktreePath(ctx, agentName);

      // Fetch first so `origin/main` reflects the absolute latest. The
      // dispatch path's `validate` already fetched, but in production the
      // gap between validate and reset is non-zero; refreshing here keeps
      // `resetClean` self-sufficient for ad-hoc calls (e.g. recovery
      // dispatch's post-cleanup step).
      const fetched = await runner.run(path, ["fetch", "origin"]);
      if (fetched.code !== 0) {
        throw new WorktreeError(
          `resetClean(${agentName}): git fetch origin failed: ${fetched.stderr.trim()}`,
        );
      }
      const checkout = await runner.run(path, ["checkout", agentName]);
      if (checkout.code !== 0) {
        throw new WorktreeError(
          `resetClean(${agentName}): git checkout failed: ${checkout.stderr.trim()}`,
        );
      }
      const reset = await runner.run(path, [
        "reset",
        "--hard",
        "origin/main",
      ]);
      if (reset.code !== 0) {
        throw new WorktreeError(
          `resetClean(${agentName}): git reset --hard origin/main failed: ${reset.stderr.trim()}`,
        );
      }
    },
  };
}

/** Parse `git rev-list --count` stdout to an integer; 0 on parse failure. */
function parseCount(stdout: string): number {
  const trimmed = stdout.trim();
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * `git worktree list --porcelain` output groups one worktree per record,
 * with a leading `worktree <path>` line. We do a simple line scan rather
 * than a full parser — only the path matters here.
 */
function worktreeListIncludes(stdout: string, path: string): boolean {
  for (const line of stdout.split("\n")) {
    const m = line.match(/^worktree\s+(.+)$/);
    if (m && m[1].trim() === path) return true;
  }
  return false;
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}
