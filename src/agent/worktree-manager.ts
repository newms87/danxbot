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
 *   - `syncWorktree(ctx, name)` — non-destructive branch sync (DX-293).
 *     Fetches origin, then either no-ops, fast-forwards via `git pull
 *     --ff-only`, or rebases the agent branch onto `origin/main`. On
 *     rebase conflict the rebase is aborted and the worktree is left
 *     at HEAD (no destructive cleanup). Replaces the retired
 *     `resetClean` (which used `git reset --hard origin/main` and
 *     could destroy uncommitted work under concurrent-writer races).
 *     Re-provisions `node_modules` + `.env` after a successful sync
 *     (via the `provisionWorktreeArtifacts` umbrella) so an operator-
 *     driven `git clean -fdx` heals on the next dispatch. See
 *     `SyncResult` for the returned shape.
 *   - `ensureProvisioned(ctx, name)` — repair-only entry point for
 *     `node_modules` + `.env` provisioning on existing worktrees that
 *     pre-date a bootstrap fix. Called from the worker boot path so
 *     every existing agent inherits the fixes without operator action.
 *     The EXTRA seam for callers that want the repair WITHOUT
 *     triggering git work; `bootstrap` and `syncWorktree` already run
 *     the same umbrella as part of their normal flow.
 *   - `teardown(ctx, name)` — `git worktree remove --force <path>` plus
 *     best-effort branch deletion (local + remote). Called on
 *     `DELETE /api/agents/:name`.
 *
 * Branch-state recovery — owned by the prep skill (`danxbot:danx-prep`)
 * since DX-297, NOT this module. Every multi-agent dispatch runs the
 * prep agent first on the worktree; it commits uncommitted WIP, syncs
 * the branch against `origin/main`, and emits a `verdict: "abort"`
 * via `mcp__danxbot__danxbot_prep_verdict` when the worktree is wedged
 * (the worker route then stamps `agents.<name>.broken` on
 * `<repo>/.danxbot/settings.json` so the picker excludes the agent on
 * subsequent ticks). The retired alternative (`dispatchInRecoveryMode`
 * with a separate recovery prompt and a post-completion `validate()`
 * re-check) was deleted in DX-297; the `validate()` method itself
 * was retired in DX-333 — do NOT reintroduce either.
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
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { mirrorWorkspaceTree } from "../inject/workspaces.js";
import { createLogger } from "../logger.js";
import { AGENT_NAME_SHAPE } from "../settings-file.js";
import type { RepoConfig } from "../types.js";
import {
  isLaravelPgsqlRepo,
  provisionWorktreeDatabase,
} from "./worktree-database.js";

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
 * Result of `syncWorktree` (DX-293).
 *
 * Replaces the retired `resetClean` which used `git reset --hard
 * origin/main` and could destroy uncommitted work under concurrent-
 * writer races. `syncWorktree` uses ONLY non-destructive git ops:
 * `fetch`, `pull --ff-only`, and `rebase`. On rebase conflict the
 * rebase is aborted (returning the working tree to its pre-rebase
 * state at HEAD) and the kind=`abort` shape is returned for the
 * caller to route.
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
 *   no destructive cleanup. `dispatchWithRecovery` (DX-297 / DX-291
 *   P6) routes abort through the prep-verdict flow that flips
 *   `agents.<name>.broken` on settings.json + throws so the multi-
 *   agent caller's dispatch-cleanup bookkeeping fires.
 */
export type SyncResult =
  | { kind: "noop" }
  | { kind: "ff"; from: string; to: string }
  | { kind: "rebased"; commits: number }
  | { kind: "abort"; reason: string; details: string };

/**
 * Result of `snapshotIfDirty` (DX-359).
 *
 * - `clean` — working tree had no uncommitted changes; no commit was
 *   created.
 * - `snapshotted` — working tree was dirty; one `wip(autosave): pre-
 *   sync snapshot of prior-dispatch residue` commit was created on the
 *   agent branch. `sha` is the resulting HEAD.
 * - `abort` — could not snapshot (HEAD not on the agent branch, commit
 *   failed). `dispatchWithRecovery` routes this through the same
 *   `agents.<name>.broken` stamp + throw as a `syncWorktree` abort.
 */
export type SnapshotResult =
  | { kind: "clean" }
  | { kind: "snapshotted"; sha: string }
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
   * `dispatchWithRecovery` (DX-297 / DX-291 P6) routes abort through
   * the prep-verdict flow that flips `agents.<name>.broken` on
   * settings.json so the picker excludes the agent until the operator
   * clears the field.
   */
  syncWorktree(ctx: WorktreeRepo, agentName: string): Promise<SyncResult>;
  /**
   * Idempotent: ensure both `<worktree>/node_modules` (DX-242) and
   * `<worktree>/.env` (DX-244) symlinks exist. Bootstrap-time
   * provisioning runs unconditionally inside `bootstrap()`, but
   * existing worktrees that pre-date a fix lack the corresponding
   * symlink. Callers that operate on a possibly-stale worktree (the
   * worker boot path, `syncWorktree`) call this directly to repair
   * without forcing a full bootstrap. No-op when the
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
   * subsequent `syncWorktree()` operates on the truly latest upstream
   * sha. Called once by `dispatchWithRecovery` per dispatch so external
   * pushes (PR-merge via the GitHub web UI, peer dev pushes, this
   * host's own non-finalize pushes) take effect on the NEXT dispatch
   * without manual operator intervention.
   *
   * Returns false on transient network failure — `dispatchWithRecovery`
   * logs and proceeds with the stale cached ref (better to dispatch on
   * stale than to dead-letter the card on flaky DNS). Never throws.
   */
  fetchOrigin(ctx: WorktreeRepo): Promise<boolean>;
  /**
   * Snapshot any uncommitted working-tree changes on the agent's branch
   * as a single `wip(autosave): pre-sync snapshot of prior-dispatch
   * residue` commit (DX-359).
   *
   * Background: the prep skill (`danxbot:danx-prep`) is the steady-state
   * owner of WIP recovery — but it runs INSIDE the dispatched agent's
   * session. When the prior dispatch died unclean (worker OOM, host
   * reboot, terminal close), its WIP sits in the worktree and the NEXT
   * dispatch's pre-flight `syncWorktree` ff-only pull aborts on the
   * dirty tree before any prep skill can run. The result is
   * `agents.<name>.broken` stamping the agent out of the rotation —
   * exactly the failure mode this method exists to prevent.
   *
   * Called once by `dispatchWithRecovery` AFTER `fetchOrigin` and
   * BEFORE `syncWorktree`. Same commit-first primitive the prep skill
   * uses — the WIP is preserved on the agent branch (recoverable via
   * git log later), the tree is clean, and `syncWorktree` proceeds
   * through its normal ff / rebase path.
   *
   * Safety: refuses to commit unless HEAD is on the agent's own branch
   * (defends against an unexpected detached HEAD or wrong-branch
   * checkout — both of which mean something else has corrupted the
   * worktree and committing would obscure the problem). On either
   * branch-check failure or commit failure, returns `abort` so the
   * caller can stamp `broken` exactly the same way as a `syncWorktree`
   * abort.
   */
  snapshotIfDirty(
    ctx: WorktreeRepo,
    agentName: string,
  ): Promise<SnapshotResult>;
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

/**
 * Single source of truth for the agent worktree path string. Both the
 * `WorktreeManager.worktreePath` method and `buildPersonaPrefix`
 * (`src/agent/persona.ts`) route through this helper so the persona
 * block, the task body, and the worktree-guard hook all advertise the
 * IDENTICAL string (DX-309 follow-up). Drift between producers used to
 * let the agent Read at one spelling then fail Edit at another because
 * Claude's read-before-edit gate keys on the literal path string.
 *
 * Uses `hostPath` (canonical, non-symlinked) — never `localPath`, which
 * on a host whose `repos/<name>` is a symlink would produce a second
 * spelling of the same inode.
 */
export function agentWorktreePath(hostPath: string, agentName: string): string {
  assertAgentName(agentName);
  return join(hostPath, ".danxbot", "worktrees", agentName);
}

/** Construct a manager. Defaults to the real git runner. */
export function createWorktreeManager(
  runner: GitRunner = defaultGitRunner,
): WorktreeManager {
  return {
    worktreePath(ctx, agentName) {
      return agentWorktreePath(ctx.hostPath, agentName);
    },

    async fetchOrigin(ctx) {
      // Refresh `refs/remotes/origin/main` so the next syncWorktree
      // sees post-merge upstream commits. `--quiet` suppresses
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

      // Orphan-dir self-heal. The idempotency check above only consults
      // git's worktree registry; a directory can survive on disk without
      // being registered (prior teardown that lost the registry entry but
      // left the dir; a `.git` pointer baked with a stale absolute path
      // from a different runtime; manual operator cleanup). `git worktree
      // add` refuses with `fatal: '<path>' already exists`, which used to
      // surface to the operator as a hard failure on `POST /api/agents`.
      // Prune dangling registry entries and rm the dir so the add can
      // proceed. Both ops are safe no-ops when there's nothing to clean.
      if (existsSync(path)) {
        log.warn(
          `bootstrap(${agentName}): orphan dir at ${path} (on disk but not registered as a worktree) — pruning + removing before recreate`,
        );
        await runner.run(ctx.hostPath, ["worktree", "prune"]);
        rmSync(path, { recursive: true, force: true });
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
      await provisionWorktreeArtifacts(ctx.hostPath, path);
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
      await provisionWorktreeArtifacts(ctx.hostPath, path);
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

    async snapshotIfDirty(ctx, agentName) {
      assertAgentName(agentName);
      const path = this.worktreePath(ctx, agentName);

      const status = await runner.run(path, ["status", "--porcelain"]);
      if (status.code !== 0) {
        return buildSnapshotAbort(
          "git status failed",
          "git status",
          status,
        );
      }
      if (status.stdout.trim().length === 0) {
        return { kind: "clean" };
      }

      // Guard: refuse to commit unless HEAD points at the agent's own
      // branch. A detached HEAD or wrong-branch checkout means something
      // else has corrupted the worktree state; committing on top would
      // obscure that. Surface as an abort so the caller stamps broken
      // and the operator investigates.
      const branch = await runner.run(path, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      const branchName = branch.stdout.trim();
      if (branch.code !== 0 || branchName !== agentName) {
        return {
          kind: "abort",
          reason: "worktree HEAD not on agent branch",
          details:
            branch.code !== 0
              ? branch.stderr.trim() ||
                `git rev-parse exited with code ${branch.code}`
              : `expected branch ${agentName}, got ${branchName || "(detached)"}`,
        };
      }

      const add = await runner.run(path, ["add", "-A"]);
      if (add.code !== 0) {
        return buildSnapshotAbort("git add failed", "git add", add);
      }

      const commit = await runner.run(path, [
        "commit",
        "-m",
        "wip(autosave): pre-sync snapshot of prior-dispatch residue",
      ]);
      if (commit.code !== 0) {
        return buildSnapshotAbort(
          "wip snapshot commit failed",
          "git commit",
          commit,
        );
      }

      const head = await runner.run(path, ["rev-parse", "HEAD"]);
      const sha = head.code === 0 ? head.stdout.trim() : "";
      log.info(
        `snapshotIfDirty(${ctx.hostPath}, ${agentName}): committed WIP snapshot ${sha.slice(0, 7)} on agent branch`,
      );
      return { kind: "snapshotted", sha };
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
        await provisionWorktreeArtifacts(ctx.hostPath, path);
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
 * Same shape as `buildAbort` but typed as `SnapshotResult` so
 * `snapshotIfDirty` can surface a structured abort identical in shape
 * to `syncWorktree`'s abort path. `dispatchWithRecovery` routes both
 * through the same `agents.<name>.broken` stamping logic.
 */
function buildSnapshotAbort(
  reason: string,
  cmdLabel: string,
  result: { stderr: string; code: number },
): SnapshotResult {
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
  await provisionWorktreeArtifacts(ctx.hostPath, path);
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
  await provisionWorktreeArtifacts(ctx.hostPath, path);
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
 * Provision every worktree-shared artifact in one place. Callers
 * (bootstrap / syncWorktree / ensureProvisioned) invoke this and
 * don't track which provisioners exist; adding a new artifact is
 * one line here, not touch-ups across three callsites. Current
 * artifacts:
 *
 *   - root `node_modules` symlink (DX-242)
 *   - `dashboard/node_modules` symlink (DX-314)
 *   - root `.env` symlink (DX-244)
 *   - `.danxbot/issues` symlink (DX-309)
 *   - `.danxbot/workspaces/<name>/` real-dir copies (DX-309)
 *   - Laravel storage dirs (DX-500)
 */
async function provisionWorktreeArtifacts(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  // DX-571: per-worktree Postgres DB + role for Laravel-pgsql consumer
  // repos. MUST run BEFORE provisionEnvFile — when it provisions, it
  // writes a REAL per-worktree .env file, and provisionEnvFile's
  // symlink path would then overwrite that real file with a symlink to
  // the parent (silently re-coupling the worktree to the primary DB).
  // For non-Laravel consumer repos this is a quick no-op skip.
  const worktreeName = basename(worktreePath);
  await provisionWorktreeDatabase({
    repoRoot,
    worktreePath,
    worktreeName,
  });
  provisionNodeModules(repoRoot, worktreePath);
  provisionDashboardNodeModules(repoRoot, worktreePath);
  provisionEnvFile(repoRoot, worktreePath);
  provisionSafeResetScript(repoRoot, worktreePath);
  provisionIssuesSymlink(repoRoot, worktreePath);
  provisionWorktreeWorkspaces(repoRoot, worktreePath);
  provisionLaravelStorageDirs(repoRoot, worktreePath);
}

/**
 * DX-572 (Phase 2 of DX-570): copy the consumer repo's
 * `<repoRoot>/.danxbot/safe-reset-db.sh` template into
 * `<worktreePath>/.danxbot/safe-reset-db.sh` and make it executable.
 *
 * The script itself is consumer-repo-specific (a Laravel + Sail recipe
 * differs from a future Node / Python / Rust consumer repo) and lives
 * in the consumer repo's tree under version control. Danxbot's role is
 * to ferry it into every worktree's `.danxbot/` dir at provisioning
 * time so the agent skill (DX-573) can invoke a stable per-worktree
 * absolute path.
 *
 * Silent skip when the consumer repo has no template — non-DB repos
 * see no behavior change. When the template DOES exist, the post-copy
 * verification throws a fail-loud `WorktreeError` if the destination
 * is missing or not executable; that surfaces in the boot
 * `ensureWorktreesProvisioned` system-error stream so the operator
 * sees a clear error instead of a silently-broken worktree.
 *
 * Idempotent — `copyFileSync` overwrites destination atomically, so
 * editing the consumer-repo template and re-running provisioning
 * propagates the change to every worktree's copy.
 */
function provisionSafeResetScript(
  repoRoot: string,
  worktreePath: string,
): void {
  const src = join(repoRoot, ".danxbot", "safe-reset-db.sh");
  if (!existsSync(src)) {
    log.debug(
      `provisionSafeResetScript: ${src} does not exist — skipping (consumer repo has no template)`,
    );
    return;
  }

  const destDir = join(worktreePath, ".danxbot");
  const dest = join(destDir, "safe-reset-db.sh");

  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);

  // Fail-loud post-condition. copyFileSync + chmodSync are throwing
  // calls, so this branch defends against an underlying fs that
  // silently no-ops (broken bind-mount, exotic union fs); cheap stat
  // catches any future provisioner regression that drops one of the
  // two calls without erroring.
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dest);
  } catch (err) {
    throw new WorktreeError(
      `provisionSafeResetScript: ${dest} missing after copy — ${(err as Error).message ?? err}`,
    );
  }
  // 0o111 = any of owner/group/other exec bit set. The script is
  // invoked via `bash <path>` so this check is belt-and-suspenders, but
  // it pins the chmod contract for the AC.
  if ((st.mode & 0o111) === 0) {
    throw new WorktreeError(
      `provisionSafeResetScript: ${dest} is not executable (mode=${(st.mode & 0o777).toString(8)})`,
    );
  }
  log.debug(`provisionSafeResetScript: copied ${src} -> ${dest}`);
}

/** Path basename without bringing in node:path's `basename` alias. */
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * DX-500: pre-create Laravel `storage/` + `bootstrap/cache` subdirs in
 * the worktree so sibling containers (sail, postgres, octane) the
 * dispatched agent spawns through `/var/run/docker.sock` can't write
 * `root:root` files there.
 *
 * Mechanism: sail's entrypoint runs as root and `mkdir -p`s the runtime
 * dirs before dropping privs. Bind-mounted host paths inherit whoever
 * created the dir first — pre-creating them as the host UID makes
 * sail's mkdir a no-op and preserves host ownership. Vapor's
 * `RecursiveDirectoryIterator` halts on the unreadable root-owned
 * `storage/framework/testing/` otherwise.
 *
 * Detect Laravel via `artisan` (cheap + reliable). Non-Laravel repos:
 * silent skip. Idempotent — `mkdirSync({recursive: true})` is a no-op
 * on existing dirs.
 */
function provisionLaravelStorageDirs(
  repoRoot: string,
  worktreePath: string,
): void {
  if (!existsSync(join(worktreePath, "artisan"))) return;
  const dirs = [
    "storage/framework/cache/data",
    "storage/framework/sessions",
    "storage/framework/testing",
    "storage/framework/views",
    "storage/logs",
    "bootstrap/cache",
  ];
  for (const rel of dirs) {
    const abs = join(worktreePath, rel);
    // Skip when the dir already exists: don't `chmod` it. A pre-existing
    // host-uid dir already wins the bind-mount ownership race (the
    // mechanism this function is here to enforce); a pre-existing root-
    // owned dir can't be chmod'd by the host UID anyway. Either way,
    // touch nothing.
    if (existsSync(abs)) continue;
    try {
      mkdirSync(abs, { recursive: true });
      // Explicit chmod — `mkdirSync({mode})` is subject to the process
      // umask (default 0o022 strips group-write → 0o755). Group-write
      // is required so sail's www-data user (host docker group) can
      // write inside these dirs at sibling-container runtime.
      chmodSync(abs, 0o775);
    } catch (err) {
      log.warn(
        `provisionLaravelStorageDirs: failed to provision ${abs}: ${(err as Error).message ?? err}`,
      );
    }
  }
}

/**
 * DX-314: symlink `<worktree>/dashboard/node_modules` ->
 * `<repoRoot>/dashboard/node_modules` so `cd <worktree>/dashboard &&
 * npx vitest run` resolves `@vitejs/plugin-vue` at vitest config-load
 * time. DX-301 verification used a manual `ln -s` workaround; this
 * provisions the link automatically. Mirrors `provisionNodeModules` —
 * symlink, not install, so every worktree shares one resolved tree.
 *
 * Silent skip when `<repoRoot>/dashboard/package.json` is absent
 * (connected repos without a dashboard subpackage) or when the
 * worktree's own `dashboard/` subdir is absent (no parent for the
 * link — `git worktree add origin/main` always creates it, but a
 * worktree predating the dashboard subpackage or one where the dir
 * was operator-deleted will hit this branch).
 *
 * No source-side `node_modules` sentinel like `provisionNodeModules`
 * has for `.bin/tsx`: the worker itself never invokes anything from
 * `dashboard/node_modules`, so a half-installed source produces a
 * clear vitest "Cannot find package '@vitejs/plugin-vue'" error at
 * first dashboard test run — actionable to the operator without
 * adding a second sentinel.
 */
function provisionDashboardNodeModules(
  repoRoot: string,
  worktreePath: string,
): void {
  if (!existsSync(join(repoRoot, "dashboard", "package.json"))) {
    log.debug(
      `provisionDashboardNodeModules: ${join(repoRoot, "dashboard", "package.json")} does not exist — skipping`,
    );
    return;
  }
  if (!existsSync(join(worktreePath, "dashboard"))) {
    log.debug(
      `provisionDashboardNodeModules: ${join(worktreePath, "dashboard")} does not exist — skipping (no parent for the symlink)`,
    );
    return;
  }
  provisionSymlink(
    repoRoot,
    worktreePath,
    join("dashboard", "node_modules"),
    "dir",
    "provisionDashboardNodeModules",
  );
}

/**
 * DX-309: copy `<repoRoot>/.danxbot/workspaces/<name>/` into
 * `<worktreePath>/.danxbot/workspaces/<name>/` for every workspace the
 * main checkout has. Real-dir copy (NOT symlink) — claude's spawn cwd
 * gets physically resolved by the kernel on attach, so a symlinked
 * workspaces dir would push the agent's git context back into the main
 * checkout and defeat the entire isolation contract.
 *
 * Called from `provisionWorktreeArtifacts` so every lifecycle hook
 * (bootstrap, syncWorktree, ensureProvisioned) leaves the worktree
 * dispatch-ready. Closes the race where `POST /api/agents`
 * creates a worktree and a dispatch fires before the poller's per-tick
 * `mirrorWorkspacesIntoWorktrees` step has copied the workspaces tree
 * in.
 *
 * Cost: idempotent via `mirrorWorkspaceTree` — symlink-aware via
 * lstat + `writeIfChanged` (content-checked idempotence); shares the
 * single implementation with the poller's per-tick
 * `mirrorWorkspacesIntoWorktrees` safety net, so the two layers don't
 * fight.
 */
function provisionWorktreeWorkspaces(
  repoRoot: string,
  worktreePath: string,
): void {
  const src = join(repoRoot, ".danxbot", "workspaces");
  if (!existsSync(src)) return;
  let entries: string[];
  try {
    entries = readdirSync(src);
  } catch {
    return;
  }
  const destRoot = join(worktreePath, ".danxbot", "workspaces");
  try {
    mkdirSync(destRoot, { recursive: true });
  } catch {
    return;
  }
  for (const name of entries) {
    const entrySrc = join(src, name);
    try {
      if (!statSync(entrySrc).isDirectory()) continue;
    } catch {
      continue;
    }
    const entryDest = join(destRoot, name);
    try {
      // `mirrorWorkspaceTree` is symlink-aware (mirrors symlinks as
      // symlinks via lstat) and idempotent via `writeIfChanged` — safe
      // to re-run on every `ensureProvisioned`. cpSync was previously
      // used here but trips `ERR_FS_CP_EINVAL` on the `mcp-servers`
      // symlink target's realpath-resolved circularity check OR EEXIST
      // on idempotent re-runs.
      mirrorWorkspaceTree(entrySrc, entryDest, []);
    } catch (err) {
      log.warn(
        `provisionWorktreeWorkspaces: failed to mirror ${entrySrc} → ${entryDest}: ${(err as Error).message ?? err}`,
      );
    }
  }
}

/**
 * DX-309: provision a `<worktree>/.danxbot/issues` symlink pointing at
 * `<repoRoot>/.danxbot/issues`. Issue YAMLs are the canonical state of
 * each card; per-worktree-branch issue divergence would split the
 * source of truth and break the chokidar mirror that keeps the DB +
 * tracker in sync. With the symlink, an agent dispatched into a
 * worktree edits `<worktree>/.danxbot/issues/...` and the write lands
 * on `<main>/.danxbot/issues/...` — single canonical store, no merge
 * conflicts on branch integration.
 *
 * `.danxbot/issues/` is gitignored so the symlink is invisible to git
 * (no working-tree noise on the agent's branch).
 *
 * Migration safety: an existing real `<worktree>/.danxbot/issues/` dir
 * with YAMLs that don't exist in main is preserved under
 * `<worktree>/.danxbot/issues.pre-symlink-<unix>/` BEFORE the rm so
 * operator can reconcile by hand. Identical (by mtime+size or by
 * content) snapshots of main → safe to remove. The MCP server reads
 * issues through the symlink at runtime, so once the link is in place
 * the dispatched agent never re-creates a divergent local copy.
 */
function provisionIssuesSymlink(repoRoot: string, worktreePath: string): void {
  const mainIssues = join(repoRoot, ".danxbot", "issues");
  if (!existsSync(mainIssues)) {
    log.debug(
      `provisionIssuesSymlink: ${mainIssues} does not exist — skipping`,
    );
    return;
  }
  const linkParent = join(worktreePath, ".danxbot");
  if (!existsSync(linkParent)) {
    // Worktree was created BEFORE this provisioning step shipped and
    // has no .danxbot/ at all. mkdir so the symlink has a home.
    // Cheaper than refusing — node_modules + .env paths above also
    // tolerate fresh worktrees.
    return;
  }
  const linkAbs = join(linkParent, "issues");

  // Existing-entry inspection. lstat so we don't follow into the
  // populated dir before deciding what to preserve.
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(linkAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (existing?.isSymbolicLink()) {
    let target: string | undefined;
    try {
      target = realpathSync(linkAbs);
    } catch {
      // Broken symlink — fall through to replace.
    }
    if (target === realpathSync(mainIssues)) {
      log.debug(`provisionIssuesSymlink: ${linkAbs} already linked`);
      return;
    }
    rmSync(linkAbs, { force: true });
  } else if (existing) {
    // Real dir/file. Move aside if it carries YAMLs not in main; else
    // safe to drop.
    const orphans = collectWorktreeOnlyYamls(linkAbs, mainIssues);
    if (orphans.length > 0) {
      const backup = `${linkAbs}.pre-symlink-${Date.now()}`;
      log.warn(
        `provisionIssuesSymlink: ${linkAbs} has ${orphans.length} YAML(s) absent from ${mainIssues} — preserving as ${backup} before symlink (orphans: ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? "..." : ""})`,
      );
      renameSync(linkAbs, backup);
    } else {
      rmSync(linkAbs, { recursive: true, force: true });
    }
  }

  symlinkSync(mainIssues, linkAbs, "dir");
  log.debug(`provisionIssuesSymlink: symlinked ${linkAbs} -> ${mainIssues}`);
}

/**
 * Return basenames of `.yml` files under `<dir>/{open,closed}/` that
 * are NOT present at the same relative path under `<reference>/`. Used
 * to detect worktree-local issue divergence before clobbering with a
 * symlink. Robust to a missing `open/` or `closed/` subdir (treats as
 * empty).
 */
function collectWorktreeOnlyYamls(dir: string, reference: string): string[] {
  const out: string[] = [];
  for (const bucket of ["open", "closed"]) {
    const localBucket = join(dir, bucket);
    if (!existsSync(localBucket)) continue;
    let entries: string[];
    try {
      entries = readdirSync(localBucket);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".yml") && !name.endsWith(".yml.migrated-to-v3")) {
        continue;
      }
      const refPath = join(reference, bucket, name);
      if (!existsSync(refPath)) out.push(`${bucket}/${name}`);
    }
  }
  return out;
}

/**
 * DX-242: provision a `<worktree>/node_modules` symlink pointing at the
 * repo-root `node_modules`.
 *
 * Adds a fail-loud precondition tied to the repo's OWN `package.json`
 * dependencies, not a hardcoded `tsx`. The original DX-242 form pinned
 * `.bin/tsx` because danxbot self-hosts agent worktrees that run
 * `npx vitest` (→ tsx). That precondition is wrong for connected repos
 * with no tsx dependency (gpt-manager = Laravel + Vue; platform = same
 * shape). The repo-aware check picks tsx OR vitest OR a sentinel that
 * the repo's own `package.json` actually declares, so a populated
 * `node_modules` always passes and a half-installed one still throws
 * loud.
 *
 * Test-path silent skip: `<repoRoot>/node_modules` may not exist in
 * unit tests that drive the manager with fake `GitRunner`s and in
 * integration tests that build a real git repo in a tmpdir without
 * populating `node_modules`. Skip rather than throw so existing test
 * scaffolding keeps working without a per-test `npm install` seed step.
 */
function provisionNodeModules(repoRoot: string, worktreePath: string): void {
  const repoNm = join(repoRoot, "node_modules");
  if (!existsSync(repoNm)) {
    log.debug(
      `provisionNodeModules: ${repoNm} does not exist — skipping (no repo-root node_modules to share)`,
    );
    return;
  }
  const sentinel = pickInstallSentinel(repoRoot);
  if (sentinel) {
    const sentinelPath = join(repoNm, sentinel.relPath);
    if (!existsSync(sentinelPath)) {
      throw new WorktreeError(
        `provisionNodeModules: ${sentinelPath} does not exist — run \`npm install\` at ${repoRoot} ` +
          `before bootstrapping or dispatching worktree agents (sentinel: ${sentinel.reason})`,
      );
    }
  }
  provisionSymlink(repoRoot, worktreePath, "node_modules", "dir", "provisionNodeModules");
}

/**
 * Pick a `node_modules`-relative sentinel path that proves `npm install`
 * ran for THIS repo. Reads `<repoRoot>/package.json` and prefers a
 * declared dep that ships a CLI binary (tsx, vitest), falling back to
 * the first declared dep's package dir. Returns null when the repo has
 * no package.json or no declared deps — caller skips the gate (a
 * present-but-empty `node_modules` is the same shape as a populated one
 * for a deps-less repo).
 */
function pickInstallSentinel(
  repoRoot: string,
): { relPath: string; reason: string } | null {
  let pkgRaw: string;
  try {
    pkgRaw = readFileSync(join(repoRoot, "package.json"), "utf8");
  } catch {
    return null;
  }
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    return null;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const binCli of ["tsx", "vitest"]) {
    if (deps[binCli]) return { relPath: join(".bin", binCli), reason: `${binCli} in deps` };
  }
  const first = Object.keys(deps)[0];
  if (first) return { relPath: first, reason: `${first} in deps` };
  return null;
}

/**
 * DX-244: provision a `<worktree>/.env` symlink pointing at the repo-
 * root `.env`. Pairs with `vitest.setup.ts` — setup file calls
 * `loadEnvFile(<cwd>/.env)`, the symlink is the resolution path that
 * lets `npx vitest run` from the worktree's cwd see DANXBOT_DB_*
 * without operator preamble.
 *
 * DX-571 retired the symlink path for Laravel-pgsql consumer repos —
 * `provisionWorktreeDatabase` writes a REAL per-worktree `.env` first
 * (with worktree-scoped DB_DATABASE / DB_USERNAME / DB_PASSWORD), and
 * symlinking over that real file would silently re-couple the worktree
 * to the primary DB. Non-Laravel consumer repos still get the symlink
 * — they don't have DB isolation to defend, and the symlink preserves
 * the cheap "edit parent .env, every worktree sees the change" model.
 *
 * No precondition (the file is opaque content; vitest will surface a
 * clear "Missing required environment variable: <NAME>" if a needed
 * key is absent — that's actionable on its own). Test-path silent
 * skip when the repo-root `.env` is missing (CI / fresh clones / the
 * existing integration-test fixtures with synthetic repos).
 */
function provisionEnvFile(repoRoot: string, worktreePath: string): void {
  if (isLaravelPgsqlRepo(repoRoot)) {
    // The DB provisioner already wrote a real per-worktree .env. The
    // umbrella's call order guarantees that ran first.
    return;
  }
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
  log.debug(`${logTag}: symlinked ${linkAbs} -> ${sourceAbs}`);
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}
