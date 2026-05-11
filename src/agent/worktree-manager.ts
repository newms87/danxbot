/**
 * WorktreeManager — per-agent git worktree lifecycle (DX-161 / multi-worker
 * dispatch epic DX-158).
 *
 * Each named agent owns a persistent git worktree at
 * `<repo>/.danxbot/worktrees/<agentName>/` and a same-named branch. The
 * manager exposes operations the dispatch layer + agent CRUD endpoints
 * use to keep that worktree healthy across dispatches:
 *
 *   - `bootstrap(ctx, name)` — idempotent `git worktree add -B` plus
 *     `node_modules` (DX-242) + `.env` (DX-244) symlink provisioning.
 *     Called on `POST /api/agents` and lazily on first dispatch (in
 *     case an agent was hand-edited into `settings.json`).
 *   - `validate` and `syncWorktree` ALSO re-provision both symlinks
 *     (silently in `validate`, post-sync in `syncWorktree`) via the
 *     `provisionWorktreeArtifacts` umbrella so every dispatch path
 *     that funnels through them is self-healing on its own —
 *     `ensureProvisioned` is the EXTRA seam for callers (today: the
 *     worker boot path) that want the repair WITHOUT triggering git
 *     work.
 *   - `validate(ctx, name)` — pre-dispatch sanity check. Returns `clean`
 *     when the worktree has no uncommitted changes and zero local commits
 *     ahead of `origin/main`; otherwise `dirty` with `{porcelain, ahead,
 *     behind}` so the caller can build a recovery prompt.
 *   - `syncWorktree(ctx, name)` — non-destructive branch sync (DX-293).
 *     Fetches origin, then either no-ops, fast-forwards via `git pull
 *     --ff-only`, or rebases the agent branch onto `origin/main`. On
 *     rebase conflict the rebase is aborted and the worktree is left
 *     at HEAD (no destructive cleanup). Replaces the retired
 *     `resetClean` (which used `git reset --hard origin/main` and
 *     could destroy uncommitted work if the caller's `validate()`
 *     raced with a concurrent writer). Re-provisions `node_modules` +
 *     `.env` after a successful sync so an operator-driven `git clean
 *     -fdx` heals on the next dispatch. See `SyncResult` for the
 *     returned shape.
 *
 *   - `ensureProvisioned(ctx, name)` — repair-only entry point for
 *     `node_modules` + `.env` provisioning on existing worktrees that
 *     pre-date a bootstrap fix. Called from the worker boot path so
 *     every existing agent inherits the fixes without operator action.
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
 *   `origin/main`. Behind-only is still clean (caller's `syncWorktree`
 *   will fast-forward without losing work).
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

/**
 * Result of `syncWorktree` (DX-293).
 *
 * Replaces the retired `resetClean` which used `git reset --hard
 * origin/main` and could destroy uncommitted work if a caller's
 * `validate()` raced with a concurrent writer. `syncWorktree` uses ONLY
 * non-destructive git ops: `fetch`, `pull --ff-only`, and `rebase`. On
 * rebase conflict the rebase is aborted (returning the working tree to
 * its pre-rebase state at HEAD) and the kind=`abort` shape is returned
 * for the caller to route.
 *
 * - `noop` — already at `origin/main`. Nothing to do.
 * - `ff` — branch was behind-only; fast-forwarded via `git pull
 *   --ff-only`. `from` and `to` are the HEAD shas before and after.
 * - `rebased` — branch had local commits; rebased cleanly onto
 *   `origin/main`. `commits` is the count of agent-branch commits that
 *   were replayed.
 * - `abort` — sync could not complete (rebase conflict, ff-only pull
 *   rejected, or fetch network failure). `reason` is a short human
 *   label; `details` is the verbatim git stderr (or a code-only
 *   string when stderr was empty). The worktree is left at HEAD —
 *   no destructive cleanup. Caller routes abort to the verdict path
 *   that flips `agents.<name>.broken` (Phase 3+); until P3 ships, the
 *   `dispatchWithRecovery` clean-validate branch throws
 *   `WorktreeError` so the dispatch fails loud.
 */
export type SyncResult =
  | { kind: "noop" }
  | { kind: "ff"; from: string; to: string }
  | { kind: "rebased"; commits: number }
  | { kind: "abort"; reason: string; details: string };

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
  /**
   * Never throws on a recoverable git state — returns `dirty` instead.
   * MAY throw `WorktreeError` when `<repoRoot>/node_modules` exists
   * but lacks `.bin/tsx` (half-installed repo); the worker can't run
   * agents in that state regardless, so surfacing here keeps silent
   * dispatch-time failures off the table.
   */
  validate(ctx: WorktreeRepo, agentName: string): Promise<ValidationResult>;
  /**
   * Non-destructive branch sync (DX-293). Replaces the retired
   * `resetClean` (which used `git reset --hard origin/main`). Fetches
   * origin, then either no-ops, fast-forwards via `git pull --ff-only`,
   * rebases the agent branch onto `origin/main`, or aborts a rebase
   * conflict. Never invokes `git reset`, `git checkout <ref>`, `git
   * restore`, or `git clean -f`. See `SyncResult` for the shape +
   * abort semantics. Re-provisions `node_modules` + `.env` after a
   * non-abort sync so an operator-driven `git clean -fdx` heals on
   * the next dispatch.
   *
   * Caller decides whether to proceed on `abort` — for the current
   * `dispatchWithRecovery` path (P2), abort throws `WorktreeError`
   * because the caller has no agent-broken plumbing yet. P3+ routes
   * abort through the prep-verdict flow that flips `agents.<name>.broken`.
   */
  syncWorktree(ctx: WorktreeRepo, agentName: string): Promise<SyncResult>;
  /**
   * Idempotent: ensure both `<worktree>/node_modules` (DX-242) and
   * `<worktree>/.env` (DX-244) symlinks exist. Bootstrap-time
   * provisioning runs unconditionally inside `bootstrap()`, but
   * existing worktrees that pre-date a fix lack the corresponding
   * symlink. Callers that operate on a possibly-stale worktree (the
   * worker boot path, `validate`, `syncWorktree`) call this directly
   * to repair without forcing a full bootstrap. No-op when the
   * worktree directory does not yet exist — bootstrap is the right
   * entry point in that case. Silent skip when a corresponding source
   * (`<repoRoot>/node_modules`, `<repoRoot>/.env`) is missing (CI /
   * fresh-clone path). Throws `WorktreeError` only when
   * `<repoRoot>/node_modules` exists but lacks `.bin/tsx` —
   * half-installed repo state where the worker can't run agents
   * either way, so surfacing the breakage at provision time keeps
   * silent dispatch-time failures off the table.
   */
  ensureProvisioned(ctx: WorktreeRepo, agentName: string): Promise<void>;
  /**
   * Refresh the host clone's cached `refs/remotes/origin/main` so the
   * subsequent `validate()` + `syncWorktree()` pair operates on the
   * truly latest upstream sha. Called once by `dispatchWithRecovery`
   * per dispatch so external pushes (PR-merge via the GitHub web UI,
   * peer dev pushes, this host's own non-finalize pushes) take effect
   * on the NEXT dispatch without manual operator intervention.
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
      // DX-242 + DX-244: provision node_modules + .env unconditionally
      // on every fresh worktree. Without node_modules,
      // `<worktree>/node_modules/.bin/tsx` is missing and any test
      // (or dispatched script) spawning a bin from the worktree's
      // cwd fails with ENOENT. Without .env, `npx vitest run` from
      // the worktree's cwd throws "Missing required environment
      // variable: DANXBOT_DB_USER" at module-load time. Both
      // symlinks are gitignored so they never appear in `git
      // status`.
      provisionWorktreeArtifacts(ctx.hostPath, path);
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
      provisionWorktreeArtifacts(ctx.hostPath, path);
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

      // DX-242 + DX-244: silently repair node_modules + .env before
      // reading git state. Existing worktrees from before each fix
      // lack the corresponding symlink, and a dispatch following
      // validate would still fail (ENOENT on tsx lookups, or
      // module-load env-var errors). Repair here so every dispatch
      // path that funnels through validate is covered.
      provisionWorktreeArtifacts(ctx.hostPath, path);

      // No `git fetch` here. Validation is purely local — porcelain +
      // rev-list against the cached `origin/main` ref is enough to
      // decide clean/dirty for the next dispatch. GitHub connectivity is
      // the agent's concern at push/pull time, not ours. Behind-only
      // (cached `origin/main` newer than HEAD) is still clean and
      // `syncWorktree` fast-forwards without touching local work.
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
      // Behind-only is clean — `syncWorktree` will fast-forward without
      // touching local work.
      return { state: "clean" };
    },

    async syncWorktree(ctx, agentName) {
      assertAgentName(agentName);
      const path = this.worktreePath(ctx, agentName);

      // Step 1 — refresh refs/remotes/origin/main from the worktree's
      // own .git (shared across all worktrees of this clone). The host-
      // clone fetch in `fetchOrigin` runs once per dispatch from
      // `dispatchWithRecovery`; this second fetch is a fast no-op when
      // the cache is already current AND a recovery path when the
      // caller skipped fetchOrigin (e.g. the prep skill in DX-291 P3+
      // that bypasses the legacy dispatchWithRecovery).
      const fetchResult = await runner.run(path, ["fetch", "origin"]);
      if (fetchResult.code !== 0) {
        return buildAbort("git fetch failed", "git fetch", fetchResult);
      }

      // Step 2 — inspect ahead/behind in one shot. `--left-right
      // --count origin/main...HEAD` emits "<behind>\t<ahead>".
      const counts = await runner.run(path, [
        "rev-list",
        "--left-right",
        "--count",
        "origin/main...HEAD",
      ]);
      if (counts.code !== 0) {
        return buildAbort("rev-list failed", "git rev-list", counts);
      }
      const [behindStr, aheadStr] = counts.stdout.trim().split(/\s+/);
      const behind = parseCount(behindStr ?? "");
      const ahead = parseCount(aheadStr ?? "");

      // Step 3 — pure-noop: already at origin/main, nothing to do.
      if (ahead === 0 && behind === 0) {
        provisionWorktreeArtifacts(ctx.hostPath, path);
        return { kind: "noop" };
      }

      // Step 4 — pure-behind: fast-forward via `git pull --ff-only`.
      // No `git reset` anywhere — `pull --ff-only` refuses to move HEAD
      // if a non-ff would be required, so the worktree state cannot be
      // destroyed by this path.
      if (ahead === 0) {
        return fastForward(runner, ctx, path);
      }

      // Step 5 — ahead > 0: rebase agent branch onto origin/main. On
      // conflict, abort the rebase to return the worktree to its
      // pre-rebase state at HEAD.
      return rebaseOnto(runner, ctx, path, ahead);
    },
  };
}

/**
 * Build a structured `abort` SyncResult from a failed `GitRunner`
 * result. Preserves stderr verbatim (trimmed) when present; falls back
 * to a `git <cmd> exited with code N` string when stderr was empty
 * (some git ops emit nothing on stdout/stderr and just exit non-zero).
 */
function buildAbort(
  reason: string,
  cmdLabel: string,
  result: { stderr: string; code: number },
): SyncResult {
  return {
    kind: "abort",
    reason,
    details:
      result.stderr.trim() || `${cmdLabel} exited with code ${result.code}`,
  };
}

/**
 * Step 4 of `syncWorktree` — pure-behind branch: capture HEAD shas
 * before + after `git pull --ff-only`. `--ff-only` refuses any
 * non-ff move, so the worktree is never destroyed by this path.
 */
async function fastForward(
  runner: GitRunner,
  ctx: WorktreeRepo,
  path: string,
): Promise<SyncResult> {
  const fromHead = await runner.run(path, ["rev-parse", "HEAD"]);
  const pull = await runner.run(path, ["pull", "--ff-only", "origin", "main"]);
  if (pull.code !== 0) {
    return buildAbort("ff-only pull rejected", "git pull", pull);
  }
  const toHead = await runner.run(path, ["rev-parse", "HEAD"]);
  provisionWorktreeArtifacts(ctx.hostPath, path);
  return {
    kind: "ff",
    from: fromHead.stdout.trim(),
    to: toHead.stdout.trim(),
  };
}

/**
 * Step 5 of `syncWorktree` — ahead-branch: rebase onto `origin/main`.
 * On conflict we capture the original rebase stderr BEFORE invoking
 * `git rebase --abort` (so `details` carries the conflict context,
 * not the abort confirmation) and surface a structured `abort`. The
 * `--abort` itself is best-effort — even on its non-zero exit the
 * working tree returns to HEAD because `--abort` only fails when
 * there is no rebase in progress, which means we never moved off HEAD
 * in the first place.
 */
async function rebaseOnto(
  runner: GitRunner,
  ctx: WorktreeRepo,
  path: string,
  ahead: number,
): Promise<SyncResult> {
  const rebase = await runner.run(path, ["rebase", "origin/main"]);
  if (rebase.code !== 0) {
    const aborted = buildAbort(
      "rebase conflict against origin/main",
      "git rebase",
      rebase,
    );
    await runner.run(path, ["rebase", "--abort"]);
    return aborted;
  }
  provisionWorktreeArtifacts(ctx.hostPath, path);
  return { kind: "rebased", commits: ahead };
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
 * Provision both worktree symlinks (DX-242 + DX-244) — node_modules
 * for binary resolution, .env for vitest module-load env vars. Single
 * entry point so callers don't track which artifacts exist; adding a
 * new artifact (a future `.npmrc`, etc.) is one entry here, not
 * touch-ups across four callsites.
 */
function provisionWorktreeArtifacts(
  repoRoot: string,
  worktreePath: string,
): void {
  provisionNodeModules(repoRoot, worktreePath);
  provisionEnvFile(repoRoot, worktreePath);
}

/**
 * DX-242: provision a `<worktree>/node_modules` symlink pointing at the
 * repo-root `node_modules`.
 *
 * Adds a fail-loud precondition on `.bin/tsx` (a symlink to a
 * `node_modules` that doesn't have tsx is worse than no symlink — the
 * test scaffolding would resolve `<worktree>/node_modules/.bin/tsx`
 * past existsSync but spawn a non-existent file). Otherwise delegates
 * to `provisionSymlink`.
 *
 * Test-path silent skip: `<repoRoot>/node_modules` may not exist in
 * unit tests that drive the manager with fake `GitRunner`s and in
 * integration tests that build a real git repo in a tmpdir without
 * populating `node_modules`. Skip rather than throw so existing test
 * scaffolding keeps working without a per-test `npm install` seed
 * step. A worker booted into a fresh clone with no `npm install` would
 * also hit this path, but it can't actually run agents anyway in that
 * state — the worker's own tsx resolution comes from
 * `<repoRoot>/node_modules` — so the skip-and-let-the-real-failure-
 * surface contract holds.
 */
function provisionNodeModules(repoRoot: string, worktreePath: string): void {
  const repoNm = join(repoRoot, "node_modules");
  if (!existsSync(repoNm)) {
    log.debug(
      `provisionNodeModules: ${repoNm} does not exist — skipping (no repo-root node_modules to share)`,
    );
    return;
  }
  const tsxBin = join(repoNm, ".bin", "tsx");
  if (!existsSync(tsxBin)) {
    throw new WorktreeError(
      `provisionNodeModules: ${tsxBin} does not exist — run \`npm install\` at ${repoRoot} ` +
        `before bootstrapping or dispatching worktree agents`,
    );
  }
  provisionSymlink(repoRoot, worktreePath, "node_modules", "dir", "provisionNodeModules");
}

/**
 * DX-244: provision a `<worktree>/.env` symlink pointing at the repo-
 * root `.env`. Pairs with `vitest.setup.ts` — setup file calls
 * `loadEnvFile(<cwd>/.env)`, the symlink is the resolution path that
 * lets `npx vitest run` from the worktree's cwd see DANXBOT_DB_*
 * without operator preamble.
 *
 * No precondition (the file is opaque content; vitest will surface a
 * clear "Missing required environment variable: <NAME>" if a needed
 * key is absent — that's actionable on its own). Test-path silent
 * skip when the repo-root `.env` is missing (CI / fresh clones / the
 * existing integration-test fixtures with synthetic repos).
 */
function provisionEnvFile(repoRoot: string, worktreePath: string): void {
  provisionSymlink(repoRoot, worktreePath, ".env", "file", "provisionEnvFile");
}

/**
 * Generic worktree-artifact symlink provisioner used by
 * `provisionNodeModules` (DX-242) + `provisionEnvFile` (DX-244).
 *
 * - Idempotent — an existing symlink resolving to the canonical
 *   target is a no-op.
 * - Self-healing — a wrong target (broken symlink, real directory,
 *   plain file) is replaced. Nothing other than the canonical
 *   symlink is supposed to live at `<worktree>/<relName>`, so
 *   replacement is safe.
 * - Silent skip when source missing — caller decides whether that's
 *   acceptable (both current callers say yes; node_modules adds a
 *   prior fail-loud check on `.bin/tsx`).
 * - NOT concurrency-safe — two callers racing on the same worktree
 *   would have the second `symlinkSync` fail with EEXIST. Today
 *   only one worker per repo and per-agent ops are sequential, so
 *   unreachable; do not call concurrently from a future test
 *   harness without serializing per-agent.
 *
 * The `realpathSync` comparison handles the case where the operator's
 * repo root is itself a symlink (host vs container path resolution):
 * always compare against the canonical filesystem path so a symlink
 * that resolves to the right place is treated as identical to a
 * direct link. This matches how `git worktree add` canonicalizes its
 * own metadata via realpath (DX-230).
 *
 * Exported for unit-test access to the defense-in-depth
 * `expectedRoot` check (which can't fire through the public surface
 * because `worktreePath()` always builds a safe path). Production
 * callers stay inside `provisionNodeModules` / `provisionEnvFile`.
 */
export function provisionSymlink(
  repoRoot: string,
  worktreePath: string,
  relName: string,
  type: "dir" | "file",
  logTag: string,
): void {
  const sourceAbs = join(repoRoot, relName);
  const linkAbs = join(worktreePath, relName);

  // Defense-in-depth: every public caller already passes a
  // worktreePath rooted under `<repoRoot>/.danxbot/worktrees/<safe-name>`
  // (assertAgentName + worktreePath() build the segment), so `rmSync`
  // below can never touch a path outside that subtree. A future
  // refactor that lets a caller pass an arbitrary worktreePath
  // directly would silently destroy whatever lives at the target —
  // pin the safety property locally instead of distributing it across
  // every callsite.
  const expectedRoot = join(repoRoot, ".danxbot", "worktrees") + sep;
  if (!linkAbs.startsWith(expectedRoot)) {
    throw new WorktreeError(
      `${logTag}: refusing to operate on ${linkAbs} — must be rooted under ${expectedRoot}`,
    );
  }

  if (!existsSync(sourceAbs)) {
    log.debug(`${logTag}: ${sourceAbs} does not exist — skipping`);
    return;
  }

  // Canonical target (used as both symlink target and idempotency key).
  const canonicalTarget = realpathSync(sourceAbs);

  // Inspect the existing entry, if any. lstat (not stat) so we don't
  // follow the link before deciding what to do.
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(linkAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (existing) {
    if (existing.isSymbolicLink()) {
      let currentTarget: string | undefined;
      try {
        currentTarget = realpathSync(linkAbs);
      } catch {
        // Broken symlink — currentTarget stays undefined; falls through
        // to the replace branch below.
      }
      if (currentTarget === canonicalTarget) {
        log.debug(
          `${logTag}: ${linkAbs} already symlinked to ${canonicalTarget}`,
        );
        return;
      }
      rmSync(linkAbs, { force: true });
    } else {
      // Real directory or plain file. Nothing other than our symlink is
      // supposed to live here; replacing it is the contract. `recursive`
      // covers an unexpected directory landing here (e.g. a stale
      // `npm install` inside the worktree).
      rmSync(linkAbs, { recursive: true, force: true });
    }
  }

  symlinkSync(sourceAbs, linkAbs, type);
  log.info(`${logTag}: symlinked ${linkAbs} -> ${sourceAbs}`);
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}
