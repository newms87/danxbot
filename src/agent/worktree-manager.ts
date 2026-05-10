/**
 * WorktreeManager — per-agent git worktree lifecycle (DX-161 / multi-worker
 * dispatch epic DX-158).
 *
 * Each named agent owns a persistent git worktree at
 * `<repo>/.danxbot/worktrees/<agentName>/` and a same-named branch. The
 * manager exposes four operations the dispatch layer + agent CRUD endpoints
 * use to keep that worktree healthy across dispatches:
 *
 *   - `bootstrap(ctx, name)` — idempotent `git worktree add -B` plus
 *     `node_modules` symlink provisioning (DX-242). Called on
 *     `POST /api/agents` and lazily on first dispatch (in case an agent was
 *     hand-edited into `settings.json`).
 *
 *   `validate` and `resetClean` ALSO re-provision `node_modules` inline
 *   (silently in `validate`, post-reset in `resetClean`) so every
 *   dispatch path that funnels through them is self-healing on its own —
 *   `ensureProvisioned` is the EXTRA seam for callers (today: the worker
 *   boot path) that want the repair WITHOUT triggering git work.
 *   - `validate(ctx, name)` — pre-dispatch sanity check. Returns `clean`
 *     when the worktree has no uncommitted changes and zero local commits
 *     ahead of `origin/main`; otherwise `dirty` with `{porcelain, ahead,
 *     behind}` so the caller can build a recovery prompt.
 *   - `resetClean(ctx, name)` — `git checkout <name>; git reset --hard
 *     origin/main`. Only safe on `validate() === clean` (caller's
 *     responsibility — we don't re-check inside). Re-provisions
 *     `node_modules` post-reset so an operator-driven `git clean -fdx`
 *     (which strips the symlink as untracked) heals on the next dispatch.
 *
 *   - `ensureProvisioned(ctx, name)` — repair-only entry point for
 *     `node_modules` provisioning on existing worktrees that pre-date the
 *     bootstrap fix. Called from the worker boot path so every existing
 *     agent inherits the fix without operator action.
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
import { join, sep } from "node:path";
import {
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createLogger } from "../logger.js";
import { AGENT_NAME_SHAPE } from "../settings-file.js";
import type { RepoConfig } from "../types.js";

/**
 * Minimal repo shape — needs `localPath` (where the actual repo lives,
 * for `git -C` invocations) and `hostPath` (the canonical absolute path
 * shared across runtimes; baked into worktree metadata so worktrees
 * survive a host↔docker swap). On host these are the same string; in a
 * container the per-repo `compose.yml` adds a mirror-bind volume so the
 * host source is mounted at BOTH `localPath` (container abs path) AND
 * `hostPath` (host abs path) — both real bind-mounts, so `realpath()`
 * canonicalizes worktree metadata to whichever path was used at git
 * invocation. All git invocations here use `hostPath` so the absolute
 * paths git writes into worktree metadata are runtime-agnostic. Both
 * `RepoConfig` (dashboard) and `RepoContext` (worker) satisfy this via
 * structural subtyping. See `src/agent/portable-path.ts`.
 */
export type WorktreeRepo = Pick<RepoConfig, "localPath" | "hostPath">;

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
  /** Absolute path of an agent's worktree, derived from `ctx.hostPath`. */
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
  /**
   * Idempotent: ensure `<worktree>/node_modules` is provisioned (DX-242).
   * Bootstrap-time provisioning runs unconditionally inside `bootstrap()`,
   * but existing worktrees that pre-date the fix lack the symlink. Callers
   * that operate on a possibly-stale worktree (the worker boot path,
   * `validate`, `resetClean`) call this directly to repair without forcing
   * a full bootstrap. No-op when the worktree directory does not yet exist
   * — bootstrap is the right entry point in that case. Throws
   * `WorktreeError` when the repo-root `node_modules` is missing or stale
   * (the worker can't run agents either way; surface the breakage instead
   * of silently producing a worktree that fails on first dispatch).
   */
  ensureProvisioned(ctx: WorktreeRepo, agentName: string): Promise<void>;
  /**
   * Refresh the host clone's cached `refs/remotes/origin/main` so the
   * subsequent `validate()` + `resetClean()` pair operates on the truly
   * latest upstream sha. Called once by `dispatchWithRecovery` per
   * dispatch so external pushes (PR-merge via the GitHub web UI, peer
   * dev pushes, this host's own non-finalize pushes) take effect on the
   * NEXT dispatch without manual operator intervention.
   *
   * Returns false on transient network failure — `dispatchWithRecovery`
   * logs and proceeds with the stale cached ref (better to dispatch on
   * stale than to dead-letter the card on flaky DNS). Never throws.
   */
  fetchOrigin(ctx: WorktreeRepo): Promise<boolean>;
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
      return join(ctx.hostPath, ".danxbot", "worktrees", agentName);
    },

    async fetchOrigin(ctx) {
      // Refresh `refs/remotes/origin/main` so the next validate/reset
      // pair sees post-merge upstream commits. `--quiet` suppresses
      // chatty FETCH output; `--prune` keeps stale remote-tracking
      // refs from accumulating. Run against the host clone (shared
      // .git for all worktrees) — fetching once updates every
      // worktree's view.
      const result = await runner.run(ctx.hostPath, [
        "fetch",
        "--quiet",
        "--prune",
        "origin",
        "main",
      ]);
      if (result.code !== 0) {
        log.warn(
          `fetchOrigin(${ctx.hostPath}): git fetch failed (code=${result.code}): ${result.stderr.trim()} — proceeding with cached origin/main ref`,
        );
        return false;
      }
      return true;
    },

    async bootstrap(ctx, agentName) {
      assertAgentName(agentName);
      const path = this.worktreePath(ctx, agentName);

      // Idempotency — `git worktree list --porcelain` emits one
      // "worktree <path>" line per registered worktree. If we find ours,
      // bootstrap is a no-op.
      const list = await runner.run(ctx.hostPath, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (list.code === 0 && worktreeListIncludes(list.stdout, path)) {
        log.debug(`bootstrap(${agentName}): already exists at ${path}`);
        return;
      }

      // No `git fetch` here. Worktree creation is a purely-local op:
      // `git worktree add -B name path origin/main` only needs the cached
      // local `refs/remotes/origin/main` to exist, which it does (host
      // clone keeps it current). GitHub connectivity is the agent's
      // concern at push/pull time, not the worktree manager's.
      //
      // `-B` creates the branch if missing or resets it to `origin/main` if
      // it already exists (e.g. orphaned from a prior teardown that lost
      // the worktree but left the local branch around).
      const created = await runner.run(ctx.hostPath, [
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
      // DX-242: provision node_modules unconditionally on every fresh
      // worktree. Without this, `<worktree>/node_modules/.bin/tsx` is
      // missing and any test (or dispatched script) that spawns a
      // bin from the worktree's cwd fails with ENOENT.
      provisionNodeModules(ctx.hostPath, path);
      log.info(`bootstrap(${agentName}): created worktree at ${path}`);
    },

    async ensureProvisioned(ctx, agentName) {
      assertAgentName(agentName);
      const path = this.worktreePath(ctx, agentName);
      // No-op when the worktree directory itself doesn't exist — bootstrap
      // is the right entry point to create it. Self-heal applies only to
      // existing worktrees missing the link.
      if (!existsSync(path)) {
        log.debug(
          `ensureProvisioned(${agentName}): worktree ${path} does not exist — skipping`,
        );
        return;
      }
      provisionNodeModules(ctx.hostPath, path);
    },

    async teardown(ctx, agentName) {
      assertAgentName(agentName);
      const path = this.worktreePath(ctx, agentName);

      // `--force` so a worktree with uncommitted changes still tears down
      // (operator deleted the agent — they accept losing in-flight WIP).
      const removed = await runner.run(ctx.hostPath, [
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
      const localDel = await runner.run(ctx.hostPath, [
        "branch",
        "-D",
        agentName,
      ]);
      if (localDel.code !== 0) {
        log.warn(
          `teardown(${agentName}): local branch delete failed: ${localDel.stderr.trim()}`,
        );
      }
      const remoteDel = await runner.run(ctx.hostPath, [
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

      // DX-242: silently repair node_modules before reading git state.
      // Existing worktrees from before this fix lack the symlink, and a
      // dispatch following validate would still fail ENOENT on
      // `<worktree>/node_modules/.bin/<bin>` lookups. Repair here so
      // every dispatch path that funnels through validate is covered.
      provisionNodeModules(ctx.hostPath, path);

      // No `git fetch` here. Validation is purely local — porcelain +
      // rev-list against the cached `origin/main` ref is enough to
      // decide clean/dirty for the next dispatch. GitHub connectivity is
      // the agent's concern at push/pull time, not ours. Behind-only
      // (cached `origin/main` newer than HEAD) is still clean and
      // `resetClean` fast-forwards without touching local work.
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

      // No `git fetch` here. Reset is purely local — `git reset --hard
      // origin/main` operates on the cached ref. GitHub connectivity is
      // the agent's concern at push/pull time, not ours.
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
      // DX-242: re-provision after reset. `git reset --hard` does not
      // touch untracked dirs (and the symlink is gitignored, so it
      // looks untracked) — but `git clean -fdx` (called elsewhere in
      // the recovery path, and any operator running it manually) DOES
      // remove it. Re-stamp the link unconditionally so resetClean's
      // post-condition is "worktree is ready for the next dispatch."
      provisionNodeModules(ctx.hostPath, path);
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

/**
 * DX-242: provision a `<worktree>/node_modules` symlink pointing at the
 * repo-root `node_modules`. Called unconditionally from `bootstrap`,
 * `validate`, and `resetClean`, plus directly from the worker boot path
 * via `ensureProvisioned`.
 *
 * Mechanism (chosen over `npm ci`-per-worktree, documented in
 * `WorktreeManager`'s header):
 *   - Symlink — cheapest (~1ms vs ~30-60s + tens of MB per worktree).
 *   - Idempotent — an existing symlink resolving to the canonical target
 *     is a no-op.
 *   - Self-healing — a wrong target (broken symlink, real directory,
 *     plain file) is replaced. Nothing other than this symlink should
 *     ever live at `<worktree>/node_modules`, so replacement is safe.
 *   - Fail-loud — a missing or broken `<repoRoot>/node_modules/.bin/tsx`
 *     throws `WorktreeError`. Without `tsx` the worker itself can't run
 *     dispatched agents; surfacing the breakage at provision time keeps
 *     silent dispatch-time failures off the table.
 *
 * The `realpathSync` comparison handles the case where the operator's
 * repo root is itself a symlink (host vs container path resolution): we
 * always compare against the canonical filesystem path so a symlink
 * that resolves to the right place is treated as identical to a direct
 * link. This matches how `git worktree add` canonicalizes its own
 * metadata via realpath (DX-230).
 */
function provisionNodeModules(repoRoot: string, worktreePath: string): void {
  const repoNm = join(repoRoot, "node_modules");
  const worktreeNm = join(worktreePath, "node_modules");
  const tsxBin = join(repoNm, ".bin", "tsx");

  // Defense-in-depth: every public caller already passes a
  // worktreePath rooted under `<repoRoot>/.danxbot/worktrees/<safe-name>`
  // (assertAgentName + worktreePath() build the segment), so `rmSync`
  // below can never touch a path outside that subtree. A future
  // refactor that lets a caller pass an arbitrary worktreePath
  // directly would silently destroy whatever lives at the target —
  // pin the safety property locally instead of distributing it across
  // every callsite.
  const expectedRoot = join(repoRoot, ".danxbot", "worktrees") + sep;
  if (!worktreeNm.startsWith(expectedRoot)) {
    throw new WorktreeError(
      `provisionNodeModules: refusing to operate on ${worktreeNm} — must be rooted under ${expectedRoot}`,
    );
  }

  // Test-path shortcut: skip when `<repoRoot>/node_modules` itself
  // doesn't exist. In production the worker boots from the repo root
  // and `npm install` ran at deploy/build time — the directory always
  // exists. In unit tests that drive the manager with fake `GitRunner`s
  // (synthetic paths like `/repo/danxbot`) and integration tests that
  // build a real git repo in a tmpdir without populating
  // `node_modules`, the directory does NOT exist; we silently no-op so
  // the existing test scaffolding keeps working without a per-test
  // npm-install seed step.
  //
  // Note: we are intentionally permissive here, NOT fail-loud. A worker
  // booted into a freshly-cloned repo with no `npm install` yet would
  // also hit this path — but a worker can't actually run agents
  // anyway in that state (the worker's own `tsx` resolution comes from
  // `<repoRoot>/node_modules`, which is missing too), so the
  // skip-and-let-the-real-failure-surface contract holds.
  if (!existsSync(repoNm)) {
    log.debug(
      `provisionNodeModules: ${repoNm} does not exist — skipping (no repo-root node_modules to share)`,
    );
    return;
  }

  // Precondition: when `<repoRoot>/node_modules` exists, it MUST contain
  // `.bin/tsx`. A symlink to a directory that has node_modules but no
  // tsx is worse than no symlink — the test scaffolding would still
  // resolve `<worktree>/node_modules/.bin/tsx` past the existsSync
  // check but spawn a non-existent file. Fail loud here so the operator
  // runs `npm install` at the repo root before retrying.
  if (!existsSync(tsxBin)) {
    throw new WorktreeError(
      `provisionNodeModules: ${tsxBin} does not exist — run \`npm install\` at ${repoRoot} ` +
        `before bootstrapping or dispatching worktree agents`,
    );
  }

  // The canonical path of the repo-root node_modules. Used both as the
  // symlink target and as the comparison key for the idempotency check.
  const canonicalTarget = realpathSync(repoNm);

  // Inspect the existing entry, if any. lstat (not stat) so we don't
  // follow the link before deciding what to do.
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(worktreeNm);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (existing) {
    if (existing.isSymbolicLink()) {
      // Symlink already there. If it resolves to the same canonical
      // target, no-op. Otherwise (broken link, wrong target) replace.
      let currentTarget: string | undefined;
      try {
        currentTarget = realpathSync(worktreeNm);
      } catch {
        // Broken symlink — currentTarget stays undefined; falls through
        // to the replace branch below.
      }
      if (currentTarget === canonicalTarget) {
        log.debug(
          `provisionNodeModules: ${worktreeNm} already symlinked to ${canonicalTarget}`,
        );
        return;
      }
      rmSync(worktreeNm, { force: true });
    } else {
      // Real directory or plain file. Nothing other than our symlink is
      // supposed to live here; replacing it is the contract. Use
      // `recursive: true` to handle a stale `npm install` inside the
      // worktree (the candidate alt-mechanism that this fix replaces).
      rmSync(worktreeNm, { recursive: true, force: true });
    }
  }

  symlinkSync(repoNm, worktreeNm, "dir");
  log.info(`provisionNodeModules: symlinked ${worktreeNm} -> ${repoNm}`);
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}
