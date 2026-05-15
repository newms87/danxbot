/**
 * Inject pipeline — top-level orchestrator + worktree mirror.
 *
 * Extracted from the pre-DX-220 `src/poller/index.ts`; DX-319 split the
 * implementation across four files:
 *
 *   - `./workspaces.ts`      — static workspace mirror, repo-wide
 *                              script injection, per-workspace prune.
 *   - `./per-repo-render.ts` — per-repo rendered `.claude/` files,
 *                              compose-override + docs copies.
 *   - `./scrubs.ts`          — repo-root + legacy-workspace scrubs.
 *   - `./sync.ts` (this file) — orchestrator (`syncRepoFiles`) plus the
 *                               worktree mirror that re-uses workspace
 *                               mirror + per-repo render across every
 *                               agent worktree.
 *
 * Pipeline (see `syncRepoFiles` below):
 *   1. Static mirror — verbatim copy of `src/inject/workspaces/<name>/`.
 *   2. Per-repo render — `danx-*` rules + tool scripts written fresh
 *      from `RepoContext` every tick so cwd-relative skill references
 *      resolve locally.
 *   3. Scrubs — stale `danx-*` at repo-root `.claude/` + legacy
 *      singular workspace dir removed (agent-isolation contract).
 *
 * The cron sweep calls `syncRepoFiles` once per tick. The worker's boot
 * path also calls it (`src/index.ts`) so a Trello-disabled repo still
 * gets workspaces provisioned at start.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { recordSystemError } from "../dashboard/system-errors.js";
import { parseSimpleYaml } from "../poller/parse-yaml.js";
import { renderRepoConfigMarkdown } from "../poller/repo-config-rule.js";
import {
  ensureGitignoreEntry,
  ensureIssuesDirs,
} from "../poller/yaml-lifecycle.js";
import type { RepoContext } from "../types.js";
import { log, projectRoot } from "./_shared/inject-utils.js";
import { ensureWorkspaceGitignoreEntries } from "./gitignore-workspaces.js";
import { injectDanxIssueMcp } from "./inject-root-mcp.js";
import {
  copyComposeOverride,
  copyFeatures,
  copyRepoDocs,
  renderPerRepoFilesIntoWorkspaces,
} from "./per-repo-render.js";
import {
  scrubLegacySingularWorkspace,
  scrubRepoRootDanxArtifacts,
} from "./scrubs.js";
import {
  injectDanxWorkspaces,
  injectDanxbotScripts,
  mirrorWorkspaceTree,
} from "./workspaces.js";

/**
 * Sync danxbot config into every plural workspace's `.claude/` subtree.
 * Called on every cron tick. The body is the table of contents — each
 * numbered step is its own helper, see file header for the pipeline.
 */
export function syncRepoFiles(repo: RepoContext): void {
  const danxbotConfigDir = resolve(repo.localPath, ".danxbot/config");
  if (!existsSync(danxbotConfigDir)) return;

  const cfg = parseSimpleYaml(
    readFileSync(resolve(danxbotConfigDir, "config.yml"), "utf-8"),
  );

  // Validate the config upfront — `renderRepoConfigMarkdown` throws
  // fail-loud on a missing required field. Doing this BEFORE any disk
  // writes so a broken config aborts the sync without leaving the
  // workspace half-populated. The rendered markdown is discarded; the
  // actual write happens per-workspace in stage 2.
  renderRepoConfigMarkdown(cfg);

  // Stage 1: static workspace mirror.
  const workspacesDir = resolve(repo.localPath, ".danxbot/workspaces");
  injectDanxWorkspaces(workspacesDir);

  // Stage 1b: danxbot-shipped scripts -> <repo>/.danxbot/scripts/.
  // Scope is repo-wide (not per-workspace) because the agent invokes
  // these from inside a worktree at <repo>/.danxbot/worktrees/<agent>/,
  // not from a workspace dir — see `injectDanxbotScripts`.
  injectDanxbotScripts(repo.localPath);

  // Stage 2: per-repo render into every plural workspace.
  renderPerRepoFilesIntoWorkspaces(repo, danxbotConfigDir, cfg, workspacesDir);

  // Stage 2b (DX-309): mirror the fully-populated workspaces tree into
  // each agent worktree's `<worktree>/.danxbot/workspaces/`. Real-dir
  // copy, NOT symlink — a symlinked workspaces dir would make the
  // spawned agent's cwd resolve (via the kernel's physical-path swap)
  // back to the main checkout, defeating the per-agent git-context
  // isolation. `mirrorWorkspaceTree` + `writeIfChanged` keep the I/O
  // cost proportional to actual content changes between ticks.
  mirrorWorkspacesIntoWorktrees(repo, danxbotConfigDir, cfg);

  // Stage 3: scrubs. Remove the legacy singular `<repo>/.danxbot/workspace/`
  // (workspace-dispatch epic retired it) and any `danx-*` artifacts at
  // repo-root `.claude/` (dev-territory contract).
  scrubLegacySingularWorkspace(repo.localPath);
  scrubRepoRootDanxArtifacts(repo.localPath);

  // Stage 4: per-issue YAML on-disk skeleton (Phase 2 of
  // tracker-agnostic-agents, Trello ZDb7FOGO). Idempotent — both helpers
  // converge on identical disk state across repeated ticks. The setup
  // skill writes the gitignore once at install, but pre-existing connected
  // repos that don't have the `issues/` line need it appended without a
  // re-install.
  ensureIssuesDirs(repo.localPath);
  ensureGitignoreEntry(repo.localPath, "issues/");
  // DX-132 Phase 2: the on-disk Trello retry queue under
  // `<repo>/.danxbot/.trello-retry/` is local-only and must never be
  // committed (entries contain raw upstream tracker error strings).
  ensureGitignoreEntry(repo.localPath, ".trello-retry/");
  // DX-340: gitignore danxbot-owned workspace files so the per-tick
  // inject re-render never dirties a tracked working tree (which would
  // abort `syncWorktree`'s strict ff-only pull and stamp the agent
  // `agents.<name>.broken`). Universal patterns + per-templated-
  // workspace patterns; auto-grows when a new templated workspace is
  // added under `src/inject/workspaces/`.
  ensureWorkspaceGitignoreEntries(repo.localPath);

  // DX-201: ensure the connected repo's root `.mcp.json` advertises the
  // `danx-issue` MCP server so a host-session `claude` at the repo root
  // can atomically allocate `<PREFIX>-N` ids via `danx_issue_create`. Merge-
  // only — never clobbers other `mcpServers` entries or top-level keys.
  const mcpResult = injectDanxIssueMcp({ repoRoot: repo.localPath });
  if (mcpResult.changed) {
    log.info(`[${repo.name}] root .mcp.json updated with danx-issue server`);
  }

  copyComposeOverride(
    danxbotConfigDir,
    resolve(projectRoot, "repo-overrides"),
    cfg.name,
  );
  copyRepoDocs(danxbotConfigDir);
  copyFeatures(danxbotConfigDir);
}

/**
 * DX-309: for each agent worktree under `<repo>/.danxbot/worktrees/`,
 * ensure `<worktree>/.danxbot/workspaces/` mirrors `<repo>/.danxbot/
 * workspaces/`. The dispatch layer cwd-swaps agent-bound dispatches to
 * a worktree-rooted workspace dir; the dir MUST exist on disk before
 * `resolveWorkspace` runs or it throws `WorkspaceNotFoundError`.
 *
 * Cost: cron-tick I/O proportional to actual content change, not
 * worktree count — `writeIfChanged` short-circuits on byte-identical
 * writes and the inject sources are tiny.
 *
 * The per-repo render layer (`renderPerRepoFilesIntoWorkspaces`) is
 * re-run against each worktree's workspaces tree so worktree-scoped
 * skills + per-repo rules + tools docs resolve cwd-relatively when the
 * agent is sitting inside the worktree.
 *
 * DX-525: only registered git worktrees are mirrored. The producer of
 * stale root-owned orphans (sibling-package compose stacks that use
 * relative bind mounts) is external to danxbot; auditing against
 * `git worktree list --porcelain` ensures we never `mkdir` into a
 * non-registered subdir (root-owned EACCES warn-spam) and reaps empty
 * orphans the parent dir's permissions allow us to remove.
 */
function mirrorWorkspacesIntoWorktrees(
  repo: RepoContext,
  danxbotConfigDir: string,
  cfg: Record<string, string>,
): void {
  const worktreesRoot = resolve(repo.localPath, ".danxbot", "worktrees");
  if (!existsSync(worktreesRoot)) return;
  const mainWorkspaces = resolve(repo.localPath, ".danxbot", "workspaces");
  if (!existsSync(mainWorkspaces)) return;

  let agentDirs: string[];
  try {
    agentDirs = readdirSync(worktreesRoot);
  } catch {
    return;
  }

  const registered = listRegisteredWorktreeBasenames(
    repo.localPath,
    worktreesRoot,
  );
  if (registered === null) {
    // Registry unavailable (git missing, repoRoot not a git repo). Skip the
    // whole worktree mirror this tick — without the registry we can't tell
    // a real worktree from an orphan, and we MUST NOT fall back to "mirror
    // every subdir" (that's the pre-DX-525 behavior that produced the
    // EACCES warn-spam loop on root-owned siblings).
    return;
  }

  for (const agentName of agentDirs) {
    const worktree = resolve(worktreesRoot, agentName);
    // Use lstat — a symlink under `worktrees/` is operator-placed (rare but
    // legal) and MUST NOT be follow-stat'd into a real dir we then `rmdir`
    // (rmdir on a symlink unlinks the symlink itself, leaving the target).
    // Skip symlinks entirely; the registry will never list them as worktrees.
    let lst;
    try {
      lst = lstatSync(worktree);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) continue;
    if (!lst.isDirectory()) continue;

    if (!registered.has(agentName)) {
      reapOrSkipOrphanWorktreeDir(repo.name, worktree, agentName, lst.mtimeMs);
      continue;
    }

    // Isolate per-worktree errors so one unwritable worktree (e.g. a
    // worktree dir owned by a different uid from a prior container run)
    // does not abort the entire `_sync` tick — that previously took
    // every downstream cron step offline indefinitely.
    try {
      const workspacesTarget = resolve(worktree, ".danxbot", "workspaces");
      mkdirSync(workspacesTarget, { recursive: true });
      for (const entry of readdirSync(mainWorkspaces)) {
        const src = resolve(mainWorkspaces, entry);
        try {
          if (!statSync(src).isDirectory()) continue;
        } catch {
          continue;
        }
        mirrorWorkspaceTree(src, resolve(workspacesTarget, entry), []);
      }
      renderPerRepoFilesIntoWorkspaces(
        repo,
        danxbotConfigDir,
        cfg,
        workspacesTarget,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        `[${repo.name}] worktree ${agentName} mirror skipped — ${message}`,
      );
      recordSystemError({
        source: "worktree",
        severity: "warn",
        repo: repo.name,
        message: `Failed to mirror workspaces into worktree ${agentName}: ${message}`,
        details: { agent: agentName, worktree, error: message },
      });
    }
  }
}

/**
 * Parse `git worktree list --porcelain` and return the basenames of every
 * worktree registered as a direct child of `worktreesRoot`. Returns `null`
 * when the registry is unavailable (git missing, repoRoot not a git repo)
 * so the caller can fail loud (skip the mirror) rather than silently fall
 * back to "every subdir is a worktree."
 *
 * IMPORTANT — symlink resolution: connected-repo dirs at
 * `<danxbot>/repos/<name>/` are symlinks (per `repo-context.ts`), but
 * `git worktree list --porcelain` emits realpath. We MUST realpath the
 * prefix before comparing or every registered worktree string-mismatches
 * the prefix → empty set → every real worktree falsely classified as
 * orphan → the caller's reap pass nukes live agent dirs. The realpath
 * call is best-effort: if the dir doesn't yet exist (first tick), fall
 * back to the canonical input string.
 */
export function listRegisteredWorktreeBasenames(
  repoRoot: string,
  worktreesRoot: string,
): Set<string> | null {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    log.warn(
      `[${repoRoot}] worktree-registry query failed — skipping worktree mirror this tick: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  let realRoot = worktreesRoot;
  try {
    realRoot = realpathSync(worktreesRoot);
  } catch {
    // Dir doesn't exist yet (first tick, or just deleted) — fall through with
    // the canonical input. The caller's existsSync gate makes this branch
    // unreachable in steady state.
  }
  const prefix = realRoot.endsWith("/") ? realRoot : `${realRoot}/`;
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^worktree\s+(.+)$/);
    if (!m) continue;
    const p = m[1].trim();
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    // Direct child only — porcelain output should never produce nested
    // worktrees under our worktrees root, but guard regardless.
    if (rest.length === 0 || rest.includes("/")) continue;
    names.add(rest);
  }
  return names;
}

/**
 * Non-registered subdir under `worktrees/`. Try a non-recursive rmdir —
 * succeeds when the dir is empty AND the parent dir's permissions allow
 * us to remove it (the common case: stale empty root-owned orphan from
 * a sibling-package compose stack's relative bind mount).
 *
 * Race guard — if the dir's mtime is younger than `REAP_AGE_FLOOR_MS` we
 * skip the rmdir entirely. This protects against a concurrent
 * `git worktree add <name>` race where the dir exists on disk but the
 * `git worktree list` snapshot we took was older than the registry
 * write. The cron tick that runs after the worktree is fully registered
 * will see it in the registry and never reach this branch.
 *
 * Expected error codes branch by intent:
 *   - ENOTEMPTY / ENOENT  → empty-target assumption was wrong (race) → debug
 *   - EACCES / EPERM      → permission to remove from parent denied → debug
 *   - anything else       → unexpected → warn (re-introducing fail-silent in
 *                            the very change that exists to kill fail-silent
 *                            is forbidden)
 */
export const REAP_AGE_FLOOR_MS = 60_000;
export function reapOrSkipOrphanWorktreeDir(
  repoName: string,
  worktree: string,
  agentName: string,
  mtimeMs: number,
): void {
  const ageMs = Date.now() - mtimeMs;
  if (ageMs < REAP_AGE_FLOOR_MS) {
    log.debug(
      `[${repoName}] skipping fresh non-registered worktree subdir ${agentName} — younger than ${REAP_AGE_FLOOR_MS}ms (possible mid-bootstrap race)`,
    );
    return;
  }
  try {
    // rmdirSync is the precise primitive — refuses to remove non-empty
    // dirs (ENOTEMPTY) and never recurses. rmSync({recursive:false}) on a
    // directory throws on every Node version regardless of contents.
    rmdirSync(worktree);
    log.info(
      `[${repoName}] reaped orphan worktree dir ${agentName} (not in git worktree registry, was empty)`,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ENOTEMPTY" ||
      code === "ENOENT" ||
      code === "EACCES" ||
      code === "EPERM"
    ) {
      log.debug(
        `[${repoName}] skipping orphan worktree dir ${agentName} (${code}) — not in git worktree registry`,
      );
      return;
    }
    log.warn(
      `[${repoName}] orphan worktree dir ${agentName} rmdir failed unexpectedly (${code ?? "no-code"}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
