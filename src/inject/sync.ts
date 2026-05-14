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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

  for (const agentName of agentDirs) {
    const worktree = resolve(worktreesRoot, agentName);
    try {
      if (!statSync(worktree).isDirectory()) continue;
    } catch {
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
