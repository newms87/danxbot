/**
 * Inject pipeline — static workspace mirror.
 *
 * Split out of `src/inject/sync.ts` in DX-319. Mirrors
 * `src/inject/workspaces/<name>/` → `<repo>/.danxbot/workspaces/<name>/`
 * verbatim. Each workspace ships its own static skills, rules,
 * `.mcp.json`, `CLAUDE.md` — all generic, identical for every
 * connected repo.
 *
 * Also carries the repo-wide static script injection
 * (`injectDanxbotScripts`) since it follows the same idempotent
 * `writeIfChanged` + chmod pattern, just with a `<repo>/.danxbot/scripts/`
 * target instead of per-workspace.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { isLinkOrFile, isSymlink } from "../poller/fs-probe.js";
import { scrubLegacyTrelloWorkerSymlink } from "../poller/legacy-trello-worker-scrub.js";
import { writeIfChanged } from "../workspace/write-if-changed.js";
import { chmodExecutable, injectDir, projectRoot } from "./_shared/inject-utils.js";
import { PER_REPO_RENDER_RULE_NAMES } from "./per-repo-render.js";
import { EMPTY_NAME_SET, scrubDanxArtifacts } from "./scrubs.js";

/**
 * Step 5: danxbot-shipped scripts -> `<repo>/.danxbot/scripts/` (executable).
 *
 * Currently mirrors `agent-finalize.sh` (DX-162 / multi-worker dispatch
 * epic DX-158) — the agent's per-dispatch completion helper. Lives in
 * `src/inject/scripts/` and lands in EVERY connected repo on EVERY
 * cron tick. Scope is intentionally repo-wide (not per-workspace):
 * the script is invoked from inside an agent's git worktree at
 * `<repo>/.danxbot/worktrees/<agent>/`, NOT from a workspace directory,
 * so the path agents reference (`.danxbot/scripts/agent-finalize.sh`)
 * resolves correctly relative to the worktree's repo root.
 *
 * Contract mirrors `injectDanxWorkspaces`:
 *   - **Idempotent.** `writeIfChanged` skips writes when content is
 *     byte-identical so inodes stay stable across ticks.
 *   - **Write-only.** Scripts retired from the inject source survive
 *     at target — there is no prune. The set is small and operator-
 *     visible enough that drift here is preferable to accidentally
 *     nuking an operator-authored script that lives alongside ours.
 *   - **Executable bit.** Every `.sh` file gets `chmod 0755` — the
 *     agent invokes them via `bash <path>` but operators / CI scripts
 *     may run them directly.
 *   - **Empty source dir is a no-op** — useful for tests that scaffold
 *     a poller against a stripped-down danxbot tree.
 */
export function injectDanxbotScripts(repoLocalPath: string): void {
  const sourceDir = resolve(injectDir, "scripts");
  if (!existsSync(sourceDir)) return;
  const targetDir = resolve(repoLocalPath, ".danxbot", "scripts");
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const srcPath = resolve(sourceDir, entry);
    if (!statSync(srcPath).isFile()) continue;
    const destPath = resolve(targetDir, entry);
    writeIfChanged(destPath, readFileSync(srcPath, "utf-8"));
    if (entry.endsWith(".sh")) chmodExecutable(destPath);
  }
}

/**
 * Step 6b: inject/workspaces/<name>/ -> <repo>/.danxbot/workspaces/<name>/.
 *
 * Part of the workspace-dispatch epic (Trello `jAdeJgi5`, Phase 2). Every
 * named workspace under `src/inject/workspaces/` is mirrored in full
 * into the connected repo so every triggered agent can cwd into an
 * isolated `<repo>/.danxbot/workspaces/<name>/` directory containing its
 * own `workspace.yml`, `.mcp.json`, `.claude/` subtree, and `CLAUDE.md`.
 *
 * Contract:
 *   - **Idempotent.** Uses `writeIfChanged` so unchanged files don't bump
 *     inode timestamps. Repeated calls converge on identical disk state.
 *   - **Recursive.** Workspaces have nested structure (`.claude/skills/
 *     <skill>/SKILL.md`, `.claude/agents/*.md`, `tools/*.sh`). The walk
 *     descends to arbitrary depth.
 *   - **Write-only — NEVER deletes.** Files / dirs / workspaces removed
 *     from `inject/workspaces/` survive at target on the next tick. The
 *     inject pipeline has no business deleting anything in a connected
 *     repo; that authority belongs to git (for tracked files) or the
 *     operator (for gitignored stragglers via `git clean -fdX`).
 *   - **Executable bit.** `.sh` files nested under a `tools/` ancestor
 *     (at any depth inside the workspace) get `chmod 0755`. Anything
 *     else keeps default perms. The check is intentionally narrow — a
 *     `.sh` file at the workspace root is NOT made executable; only
 *     shell helpers the agent will invoke as commands via the injected
 *     `tools/` PATH contract.
 *   - **Empty source is a no-op.** The function still ensures the
 *     target root directory is created so the on-disk shape
 *     `<repo>/.danxbot/workspaces/` is present after the first tick.
 *
 * See `.claude/rules/agent-dispatch.md` "Workspace isolation" and the
 * Phase 1 resolver contract in `src/workspace/resolve.ts` for how the
 * mirrored trees are consumed at dispatch time.
 */
export function injectDanxWorkspaces(workspacesTargetDir: string): void {
  const injectWorkspacesDir = resolve(injectDir, "workspaces");
  mkdirSync(workspacesTargetDir, { recursive: true });
  if (!existsSync(injectWorkspacesDir)) return;

  // Filter to directories only — the workspaces root may contain
  // tombstone files (e.g. `.gitkeep`) that keep the dir tracked when no
  // fixtures ship. Treating those as workspace names crashes the
  // recursive walk (ENOTDIR on `readdirSync(<file>)`) and was the bug
  // surfaced by `make test-system-poller` after P3.
  const sourceNames = readdirSync(injectWorkspacesDir).filter((entry) =>
    statSync(resolve(injectWorkspacesDir, entry)).isDirectory(),
  );

  for (const name of sourceNames) {
    const workspaceSourceDir = resolve(injectWorkspacesDir, name);
    const workspaceDir = resolve(workspacesTargetDir, name);
    mirrorWorkspaceTree(workspaceSourceDir, workspaceDir, []);
  }

  // Migration cleanup (Trello 69f76e8d069eb71dd315d363): the migration
  // window for the legacy `trello-worker` symlink has closed. Remove
  // any leftover symlink so the workspace listing reflects only the
  // canonical name. Real directories at that path are preserved
  // (operator-authored workspaces, e.g. gpt-manager's schema-builder
  // sibling pattern). See `legacy-trello-worker-scrub.ts`.
  scrubLegacyTrelloWorkerSymlink(workspacesTargetDir);

  // Per-workspace post-mirror steps over EVERY workspace present at
  // target — both inject-sourced AND operator-authored (e.g.
  // gpt-manager's schema-builder, trello-worker). Operator-authored
  // workspaces have no inject source dir, but still receive per-repo
  // rendered rules from `renderPerRepoFilesIntoWorkspaces` and so are
  // equally subject to stale `danx-*` rule accumulation. Passing a
  // non-existent inject source path is handled by the prune fn via
  // its `existsSync` checks.
  for (const entry of readdirSync(workspacesTargetDir)) {
    const workspaceDir = resolve(workspacesTargetDir, entry);
    if (!statSync(workspaceDir).isDirectory()) continue;
    injectMcpServers(workspaceDir);
    stripHostUnreachableMcpServers(workspaceDir);
    injectSharedWorktreeGuardHook(workspaceDir);
    pruneStaleDanxArtifactsInWorkspace(
      resolve(injectWorkspacesDir, entry),
      workspaceDir,
    );
    pruneRetiredWorkspaceFiles(entry, workspaceDir);
  }
}

/**
 * DX-309: copy the shared `worktree-guard.mjs` PreToolUse hook into
 * `<workspace>/.claude/hooks/`. Single source of truth at
 * `src/inject/_shared/hooks/worktree-guard.mjs`; the workspace's
 * own `.claude/settings.json` references the hook by relative path.
 * Cross-workspace sharing avoided the drift that copying-by-hand into
 * every workspace fixture would have caused.
 *
 * Idempotent via `writeIfChanged`. Exec bit stamped because some host
 * file systems lose it across copies; the hook is invoked as `node
 * <path>` so the bit is belt-and-suspenders rather than load-bearing.
 */
function injectSharedWorktreeGuardHook(workspaceDir: string): void {
  const source = resolve(
    injectDir,
    "_shared",
    "hooks",
    "worktree-guard.mjs",
  );
  if (!existsSync(source)) return;
  const targetDir = resolve(workspaceDir, ".claude", "hooks");
  mkdirSync(targetDir, { recursive: true });
  const targetPath = resolve(targetDir, "worktree-guard.mjs");
  writeIfChanged(targetPath, readFileSync(source, "utf-8"));
  chmodExecutable(targetPath);
}

/**
 * Host-mode dispatches run claude on the operator's machine; the inject
 * `.mcp.json` is authored for docker dispatches and references MCP
 * servers via danxbot-net DNS (e.g. `http://playwright:3000`). Those
 * hostnames don't resolve from the host, so the server appears as
 * "1 MCP server failed" in the agent's TUI and any tool call against it
 * times out. Strip such entries from the workspace `.mcp.json` post-
 * mirror when `config.isHost` so the host-mode agent sees only servers
 * it can actually reach.
 *
 * The list of host-unreachable entries is intentionally hard-coded:
 * every server we ship under `mcp-servers/` targets the danxbot-net
 * playwright container. A future dashboard toggle (filed separately)
 * will let operators opt in via host port mapping or remote URL.
 */
function stripHostUnreachableMcpServers(workspaceDir: string): void {
  if (!config.isHost) return;
  const mcpJsonPath = resolve(workspaceDir, ".mcp.json");
  if (!existsSync(mcpJsonPath)) return;
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
  } catch {
    return;
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") return;
  const HOST_UNREACHABLE = new Set(["playwright"]);
  let removed = false;
  for (const name of Object.keys(parsed.mcpServers)) {
    if (HOST_UNREACHABLE.has(name)) {
      delete parsed.mcpServers[name];
      removed = true;
    }
  }
  if (!removed) return;
  writeIfChanged(mcpJsonPath, JSON.stringify(parsed, null, 2) + "\n");
}

/**
 * Step 6c: symlink danxbot's `mcp-servers/` directory into each workspace
 * as `<workspace>/mcp-servers`. The dispatched agent's cwd is the workspace
 * dir, so workspace `.mcp.json` files reference MCP server scripts via the
 * relative path `mcp-servers/<name>/src/index.ts`. The symlink keeps a
 * single source of truth (the danxbot install's `mcp-servers/`); edits
 * propagate to every workspace immediately and there is no copy to keep
 * in sync.
 *
 * Symlink target is the absolute path to `${projectRoot}/mcp-servers`.
 * `projectRoot` is the danxbot install root for THIS process (host →
 * `/home/.../danxbot`; container → `/danxbot/app`). The inject pipeline
 * and the dispatched agent share that install, so the symlink resolves
 * correctly for the runtime that wrote it.
 *
 * Idempotent: existing correct symlink is left alone; existing wrong
 * symlink (or stray directory left behind by an older copy-based
 * implementation) is replaced.
 */
function injectMcpServers(workspaceDir: string): void {
  const srcRoot = resolve(projectRoot, "mcp-servers");
  if (!existsSync(srcRoot)) return;
  const linkPath = resolve(workspaceDir, "mcp-servers");

  if (existsSync(linkPath) || isLinkOrFile(linkPath)) {
    if (isSymlink(linkPath) && readlinkSync(linkPath) === srcRoot) return;
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(srcRoot, linkPath, "dir");
}

/**
 * Recursive helper for `injectDanxWorkspaces`. Mirrors `srcDir` into
 * `destDir` and stamps executable bits. Write-only — never deletes
 * (see `injectDanxWorkspaces` contract). `relSegments` tracks the path
 * segments inside the workspace (NOT including the workspace name itself)
 * so `chmod` decisions can inspect ancestors — `.sh` files nested under a
 * `tools/` segment get `+x`.
 *
 * Exported so `sync.ts#mirrorWorkspacesIntoWorktrees` can re-use the
 * same idempotent recursive copy without duplicating the chmod logic.
 */
export function mirrorWorkspaceTree(
  srcDir: string,
  destDir: string,
  relSegments: string[],
): void {
  mkdirSync(destDir, { recursive: true });
  const sourceEntries = readdirSync(srcDir);

  for (const entry of sourceEntries) {
    const srcPath = resolve(srcDir, entry);
    const destPath = resolve(destDir, entry);
    const childSegments = [...relSegments, entry];
    // Use lstat — statSync follows symlinks. The `mcp-servers` entry in
    // each workspace is a symlink to `<danxbot>/mcp-servers`; recursing
    // through it deep-copies the entire mcp-servers tree into every
    // worktree's workspace each tick AND, if the dest symlink already
    // exists, writes resolve THROUGH it into the real mcp-servers source.
    // Mirror symlinks as symlinks instead.
    const srcLstat = lstatSync(srcPath);
    if (srcLstat.isSymbolicLink()) {
      const target = readlinkSync(srcPath);
      try {
        if (isLinkOrFile(destPath)) rmSync(destPath, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      let linkType: "dir" | "file" = "file";
      try {
        linkType = statSync(srcPath).isDirectory() ? "dir" : "file";
      } catch {
        // dangling symlink — keep "file" default; Linux ignores the type anyway
      }
      symlinkSync(target, destPath, linkType);
      continue;
    }
    if (srcLstat.isDirectory()) {
      mirrorWorkspaceTree(srcPath, destPath, childSegments);
    } else {
      writeIfChanged(destPath, readFileSync(srcPath, "utf-8"));
      // Executable bit for .sh scripts nested under a tools/ ancestor.
      // Checking ancestors (not just immediate parent) lets a workspace
      // organize tools into subdirs like `tools/mcp/*.sh` without
      // losing +x. Matching the literal `tools` segment keeps the
      // check narrow — a `.sh` at the workspace root is intentionally
      // not made executable.
      if (entry.endsWith(".sh") && relSegments.includes("tools")) {
        chmodExecutable(destPath);
      }
    }
  }
}

/**
 * Prune stale `danx-*` artifacts left behind in a workspace's
 * `.claude/{rules,skills}/` after `mirrorWorkspaceTree`. The mirror is
 * write-only — when a `danx-*` rule or skill is RETIRED from the inject
 * source, the previous tick's copy in the target persists forever and
 * the dispatched agent keeps loading dead config.
 *
 * Keep rules:
 *   1. The matching name exists in `<source>/.claude/<sub>/` (still
 *      shipped from the static inject tree), OR
 *   2. The name is in `PER_REPO_RENDER_RULE_NAMES` — rules that
 *      `renderPerRepoFilesIntoWorkspaces` writes per-tick from
 *      `RepoContext` AFTER this prune runs. The set is co-located
 *      with the writers so the prune cannot drift out of sync.
 *
 * Scope is intentionally narrow — only `rules/` and `skills/`, only
 * `danx-*` prefix. `tools/` is excluded because `copyRepoToolScripts`
 * legitimately writes per-repo, NON-`danx-*`-prefixed scripts there
 * (operator-authored tooling). The repo-root scrub
 * (`scrubRepoRootDanxArtifacts`) DOES include `tools/` because the
 * repo-root contract forbids any `danx-*` artifact anywhere, while
 * the workspace contract is "danx-* in rules/skills ships from
 * danxbot; tools/ is per-repo". Non-prefixed entries are
 * operator-authored or per-repo scripts and survive untouched.
 */
function pruneStaleDanxArtifactsInWorkspace(
  workspaceSourceDir: string,
  workspaceTargetDir: string,
): void {
  scrubDanxArtifacts(resolve(workspaceTargetDir, ".claude"), {
    subdirs: ["rules", "skills"],
    keepIfShippedFrom: (sub) => {
      const sourceSubDir = resolve(workspaceSourceDir, ".claude", sub);
      return existsSync(sourceSubDir)
        ? new Set(readdirSync(sourceSubDir))
        : EMPTY_NAME_SET;
    },
    keepNames: (sub) =>
      sub === "rules" ? PER_REPO_RENDER_RULE_NAMES : EMPTY_NAME_SET,
  });
}

/**
 * DX-272 (Phase 3 of the plugin-consolidation epic DX-269): non-prefixed
 * retiree tombstone allowlist.
 *
 * `pruneStaleDanxArtifactsInWorkspace` only deletes entries whose name
 * starts with `danx-` AND no longer ship from the inject source. Most
 * retirees match both filters and are auto-cleaned. ONE outlier under
 * `issue-worker/.claude/skills/issue-blocker/` lacks the `danx-` prefix,
 * so the prefix-scoped scrubber walks past it and the stale plugin-
 * duplicate sits in every connected repo's workspace dir forever.
 *
 * This helper carries an explicit per-workspace, per-subdir allowlist
 * of retired names that the prefix scrubber CANNOT reach. Names are
 * permanent tombstones — once retired, never unretired. If a plugin
 * skill is ever re-introduced under one of these names, the entry is
 * deleted from the map in the same commit that re-adds the file (or
 * the prune fights the inject mirror on every tick).
 *
 * `danx-*`-prefixed retirees are NOT listed here on purpose — the
 * sibling scrubber catches them via prefix the moment inject stops
 * shipping them. Listing them would be dead code that drifts.
 *
 * Empty `rules`/`skills` sets are permitted extension points so a
 * future retiree under a workspace that does not yet have any
 * non-prefixed tombstones can be added with one line.
 */
type RetiredWorkspaceNames = Readonly<{
  rules: ReadonlySet<string>;
  skills: ReadonlySet<string>;
}>;

const RETIRED_WORKSPACE_ARTIFACT_NAMES: ReadonlyMap<
  string,
  RetiredWorkspaceNames
> = new Map<string, RetiredWorkspaceNames>([
  [
    "issue-worker",
    {
      rules: new Set<string>(),
      skills: new Set<string>(["issue-blocker"]),
    },
  ],
]);

/**
 * Per-tick companion to `pruneStaleDanxArtifactsInWorkspace`. Walks the
 * tombstone map and force-deletes any retired non-`danx-*` artifact
 * sitting in the workspace's `.claude/{rules,skills}/`. Fail-loud per
 * DX-149: an `rm` failure here means the dispatched agent will load
 * dead plugin-duplicate config on the next dispatch — exactly the bug
 * this helper exists to prevent. The cron top-level catch
 * logs+swallows process-wide, same convergence model as the sibling
 * scrubber.
 *
 * Idempotent: a missing target subdir or a missing entry within it is
 * a silent no-op (the second poll after a successful prune is a no-op
 * because every `existsSync` short-circuits).
 */
function pruneRetiredWorkspaceFiles(
  workspaceName: string,
  workspaceTargetDir: string,
): void {
  const retired = RETIRED_WORKSPACE_ARTIFACT_NAMES.get(workspaceName);
  if (!retired) return;
  const claudeDir = resolve(workspaceTargetDir, ".claude");
  const subdirs: ReadonlyArray<["rules" | "skills", ReadonlySet<string>]> = [
    ["rules", retired.rules],
    ["skills", retired.skills],
  ];
  for (const [sub, names] of subdirs) {
    if (names.size === 0) continue;
    const dir = resolve(claudeDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of names) {
      const path = resolve(dir, name);
      if (!existsSync(path)) continue;
      rmSync(path, { recursive: true, force: true });
    }
  }
}
