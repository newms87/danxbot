/**
 * Inject pipeline — DX-220 Phase 5 of the Event-Driven Worker epic.
 *
 * Extracted from the pre-DX-220 `src/poller/index.ts` so the cron
 * sweep (`src/cron/sync-and-audit.ts`) is no longer a 1700-LOC file.
 * The inject contract is unchanged from the pre-DX-220 version that
 * lived inside the poller — every comment + behaviour is preserved
 * verbatim; only the home of the code moved.
 *
 * Two-stage pipeline (see `syncRepoFiles` below):
 *
 *   1. **Static mirror** (`injectDanxWorkspaces`). Copies
 *      `src/inject/workspaces/<name>/` → `<repo>/.danxbot/workspaces/<name>/`
 *      verbatim. Each workspace ships its own static skills, rules,
 *      `.mcp.json`, `CLAUDE.md` — all generic, identical for every
 *      connected repo.
 *
 *   2. **Per-repo render** (`renderPerRepoFilesIntoWorkspaces`). For
 *      each workspace, writes the per-repo rendered files
 *      (`danx-repo-config.md`, `danx-repo-overview.md`,
 *      `danx-repo-workflow.md`, `danx-tools.md`,
 *      `danx-issue-prefix.md`) plus tool scripts into its `.claude/`.
 *      Rendered fresh from `RepoContext` every tick so cwd-relative
 *      skill references resolve locally.
 *
 *   3. **Scrubs** enforce agent-isolation — stale `danx-*` files at
 *      repo-root `.claude/` and the legacy singular workspace dir are
 *      removed.
 *
 * The cron sweep calls `syncRepoFiles` once per tick. The worker's boot
 * path also calls it (`src/index.ts`) so a Trello-disabled repo still
 * gets workspaces provisioned at start.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  statSync,
  readlinkSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";
import { parseSimpleYaml } from "../poller/parse-yaml.js";
import { renderRepoConfigMarkdown } from "../poller/repo-config-rule.js";
import { writeIfChanged } from "../workspace/write-if-changed.js";
import { createLogger } from "../logger.js";
import { scrubLegacyTrelloWorkerSymlink } from "../poller/legacy-trello-worker-scrub.js";
import { injectDanxIssueMcp } from "./inject-root-mcp.js";
import { isLinkOrFile, isSymlink } from "../poller/fs-probe.js";
import { ensureGitignoreEntry, ensureIssuesDirs } from "../poller/yaml-lifecycle.js";
import type { RepoContext } from "../types.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const injectDir = resolve(dirname(fileURLToPath(import.meta.url)));

const log = createLogger("inject");

/**
 * The `.claude/` subtree the inject pipeline writes per-repo files
 * into. Every dispatched agent cwds into one of the plural workspaces
 * at `<repo>/.danxbot/workspaces/<name>/` (agent-isolation +
 * workspace-dispatch epics, Trello `7ha2CSpc`/`jAdeJgi5`), so that's
 * where per-repo rendered rules + tools must land — duplicated into
 * each workspace dir so cwd-relative skill references like
 * `.claude/rules/danx-repo-config.md` resolve LOCALLY without claude
 * having to walk ancestor `.claude/` dirs (which would land on the
 * developer's repo-root `.claude/`, an isolation contract violation
 * that produced the Phase 6 stale-board-IDs incident).
 *
 * The repo-root `.claude/` is strictly developer-owned. Danxbot neither
 * reads nor writes there; `scrubRepoRootDanxArtifacts` actively removes
 * any leftover `danx-*` files at repo-root on every tick.
 */
interface InjectTarget {
  rulesDir: string;
  skillsDir: string;
  toolsDir: string;
}

function buildInjectTarget(workspaceRoot: string): InjectTarget {
  return {
    rulesDir: resolve(workspaceRoot, ".claude/rules"),
    skillsDir: resolve(workspaceRoot, ".claude/skills"),
    toolsDir: resolve(workspaceRoot, ".claude/tools"),
  };
}

function chmodExecutable(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch (e) {
    log.warn(`Failed to chmod ${path}:`, e);
  }
}

/**
 * Names of every `danx-*` rule that `renderPerRepoFilesIntoWorkspaces`
 * writes into a workspace's `.claude/rules/` every tick. Lives here
 * alongside the writers so adding a new per-repo rendered rule is a
 * single-edit change — both the writer below and the
 * `pruneStaleDanxArtifactsInWorkspace` allowlist consume this set, so
 * the prune cannot drift out of sync with the render. Adding a new
 * rendered rule without updating this set would cause the prune to
 * silently delete it on the next tick.
 *
 * Skills directory has no per-repo renders today; if that changes, add
 * a sibling set + thread it through the prune.
 */
export const PER_REPO_RENDER_RULE_NAMES: ReadonlySet<string> = new Set([
  "danx-repo-config.md",
  "danx-repo-overview.md",
  "danx-repo-workflow.md",
  "danx-tools.md",
  "danx-issue-prefix.md",
]);

/** Step 1: render danx-repo-config.md from config.yml to the workspace. */
function writeRepoConfigRule(
  cfg: Record<string, string>,
  target: InjectTarget,
): void {
  writeFileSync(
    resolve(target.rulesDir, "danx-repo-config.md"),
    renderRepoConfigMarkdown(cfg),
  );
}

/** Step 2: overview.md + workflow.md -> danx-repo-{overview,workflow}.md. */
function copyRepoConfigDocs(
  danxbotConfigDir: string,
  target: InjectTarget,
): void {
  const mappings: ReadonlyArray<readonly [string, string]> = [
    ["overview.md", "danx-repo-overview.md"],
    ["workflow.md", "danx-repo-workflow.md"],
  ];
  for (const [src, dest] of mappings) {
    const srcPath = resolve(danxbotConfigDir, src);
    if (!existsSync(srcPath)) continue;
    const header = `<!-- AUTO-GENERATED by danxbot from .danxbot/config/${src} — do not edit -->\n\n`;
    writeFileSync(
      resolve(target.rulesDir, dest),
      header + readFileSync(srcPath, "utf-8"),
    );
  }
}

/**
 * Step 2b: render `danx-issue-prefix.md` from `RepoContext.issuePrefix`.
 *
 * Carries the live per-repo issue prefix (e.g. `DX`, `SG`, `FD`) so
 * workspace skills can reference the actual literal when prose
 * convention `<PREFIX>-N` is insufficient (e.g. examples that need a
 * concrete id, scripts that templated the prefix). Phase 4 of DX-99 —
 * the source-of-truth lookup point for the live value at agent-dispatch
 * time. The prose layer (skills + rules) generally uses `<PREFIX>-N`
 * as a placeholder; this file is the escape hatch for the rare case
 * the literal is needed.
 */
function writeIssuePrefixRule(
  issuePrefix: string,
  target: InjectTarget,
): void {
  const body =
    `<!-- AUTO-GENERATED by danxbot — do not edit. Source: <repo>/.danxbot/config/config.yml#issue_prefix -->\n` +
    `\n` +
    `# Issue ID Prefix\n` +
    `\n` +
    `This repo's issue id prefix is **\`${issuePrefix}\`**.\n` +
    `\n` +
    `Every issue id in this repo has the shape \`${issuePrefix}-<N>\` (e.g. \`${issuePrefix}-1\`, \`${issuePrefix}-42\`). When skill prose says \`<PREFIX>-N\`, substitute \`${issuePrefix}\`. When you need a literal example id in a comment or commit message, use a real \`${issuePrefix}-N\` from this repo.\n`;
  writeFileSync(resolve(target.rulesDir, "danx-issue-prefix.md"), body);
}

/** Step 3: repo-specific tools.md -> danx-tools.md. */
function copyRepoToolsDoc(
  danxbotConfigDir: string,
  target: InjectTarget,
): void {
  const src = resolve(danxbotConfigDir, "tools.md");
  if (!existsSync(src)) return;
  copyFileSync(src, resolve(target.rulesDir, "danx-tools.md"));
}

/** Step 4: repo-specific tool scripts -> .claude/tools/ (executable). */
function copyRepoToolScripts(
  danxbotConfigDir: string,
  target: InjectTarget,
): void {
  const src = resolve(danxbotConfigDir, "tools");
  if (!existsSync(src)) return;
  for (const file of readdirSync(src)) {
    const dest = resolve(target.toolsDir, file);
    copyFileSync(resolve(src, file), dest);
    chmodExecutable(dest);
  }
}

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
function injectDanxbotScripts(repoLocalPath: string): void {
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
function injectDanxWorkspaces(workspacesTargetDir: string): void {
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
 */
function mirrorWorkspaceTree(
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
    if (statSync(srcPath).isDirectory()) {
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
 * Shared `danx-*`-artifact scrubber for a `.claude/` root. Used by
 * both the workspace prune (`pruneStaleDanxArtifactsInWorkspace`,
 * scoped to a workspace's target `.claude/`) and the repo-root scrub
 * (`scrubRepoRootDanxArtifacts`, scoped to the developer-owned
 * `<repo>/.claude/`). Centralizing the logic prevents the two from
 * drifting apart on prefix conventions, subdir scope, or failure
 * semantics.
 *
 * For each subdir in `opts.subdirs`:
 *   - Walks `<claudeRootDir>/<sub>/`
 *   - For every direct child whose name starts with `danx-`:
 *     - Keeps it if `opts.keepIfShippedFrom?.(sub)` returns a Set
 *       containing the entry (caller-supplied source-of-truth for
 *       "this name still ships from the inject tree").
 *     - Keeps it if `opts.keepNames?.(sub)` returns a Set containing
 *       the entry (caller-supplied per-name allowlist, e.g. the
 *       per-repo render outputs that this scrubber runs BEFORE the
 *       renderer writes them).
 *     - Otherwise rm-r's it.
 *
 * Fail-loud per CLAUDE.md "Fail loudly" rule: an `rm` failure on a
 * stale `danx-*` artifact means the dispatched agent will load dead
 * config on the next dispatch — exactly the bug this scrubber exists
 * to prevent. Do not swallow the error.
 */
interface ScrubDanxArtifactsOptions {
  readonly subdirs: readonly string[];
  readonly keepIfShippedFrom?: (sub: string) => ReadonlySet<string>;
  readonly keepNames?: (sub: string) => ReadonlySet<string>;
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set<string>();

function scrubDanxArtifacts(
  claudeRootDir: string,
  opts: ScrubDanxArtifactsOptions,
): void {
  for (const sub of opts.subdirs) {
    const dir = resolve(claudeRootDir, sub);
    if (!existsSync(dir)) continue;

    const keepShipped = opts.keepIfShippedFrom?.(sub) ?? EMPTY_NAME_SET;
    const keepWhitelist = opts.keepNames?.(sub) ?? EMPTY_NAME_SET;

    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith("danx-")) continue;
      if (keepShipped.has(entry)) continue;
      if (keepWhitelist.has(entry)) continue;
      rmSync(resolve(dir, entry), { recursive: true, force: true });
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

/** Step 7: optional compose override -> repo-overrides/<name>-compose.yml. */
function copyComposeOverride(
  danxbotConfigDir: string,
  overridesDir: string,
  cfgName: string,
): void {
  const src = resolve(danxbotConfigDir, "compose.yml");
  if (!existsSync(src)) return;
  mkdirSync(overridesDir, { recursive: true });
  copyFileSync(src, resolve(overridesDir, `${cfgName}-compose.yml`));
}

/** Step 8: repo-side docs/{domains,schema}/* -> danxbot docs dir. */
function copyRepoDocs(danxbotConfigDir: string): void {
  const repoDocsDir = resolve(danxbotConfigDir, "docs");
  if (!existsSync(repoDocsDir)) return;
  const docsDir = resolve(projectRoot, "docs");
  for (const subdir of ["domains", "schema"]) {
    const srcDir = resolve(repoDocsDir, subdir);
    if (!existsSync(srcDir)) continue;
    const destDir = resolve(docsDir, subdir);
    mkdirSync(destDir, { recursive: true });
    for (const file of readdirSync(srcDir)) {
      copyFileSync(resolve(srcDir, file), resolve(destDir, file));
    }
  }
}

/** Step 9: features.md is copied ONCE and left alone so ideator edits persist. */
function copyFeaturesOnce(danxbotConfigDir: string): void {
  const danxbotDir = resolve(danxbotConfigDir, "..");
  const src = resolve(danxbotDir, "features.md");
  const dest = resolve(projectRoot, "docs", "features.md");
  if (!existsSync(src) || existsSync(dest)) return;
  mkdirSync(resolve(projectRoot, "docs"), { recursive: true });
  copyFileSync(src, dest);
}

/**
 * Sync danxbot config into every plural workspace's `.claude/` subtree.
 * All injected files use the `danx-` prefix so they're clearly
 * identifiable and gitignore-able.
 *
 * Two-stage pipeline:
 *
 *   1. **Static mirror** (`injectDanxWorkspaces`). Copies
 *      `src/inject/workspaces/<name>/` → `<repo>/.danxbot/workspaces/<name>/`
 *      verbatim.
 *
 *   2. **Per-repo render** (`renderPerRepoFilesIntoWorkspaces`). For
 *      each workspace, writes the per-repo rendered files into its
 *      `.claude/`.
 *
 *   3. **Scrubs** enforce the agent-isolation contract: stale `danx-*`
 *      files at `<repo>/.claude/{rules,skills,tools}/` and the legacy
 *      singular `<repo>/.danxbot/workspace/` directory are removed.
 *
 * Called on every cron tick to keep workspaces up to date. Each
 * numbered step is its own helper — the function body is the table
 * of contents.
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
  copyFeaturesOnce(danxbotConfigDir);
}

/**
 * For each plural workspace under `<repo>/.danxbot/workspaces/`, render
 * the per-repo files into its `.claude/`. The static mirror created
 * the workspace dirs in stage 1; this stage just adds the per-repo
 * data layer on top. Workspaces from the static inject tree that have
 * never received a tick yet still get the per-repo files written —
 * `injectDanxWorkspaces` ran first, so the dirs exist.
 *
 * Workspaces are discovered from the on-disk `<repo>/.danxbot/workspaces/`
 * directory, not from `inject/workspaces/`. This way an operator-authored
 * workspace tracked in the connected repo's git (the
 * `gpt-manager-authored schema-builder/` precedent that produced the
 * never-prune contract) also gets the per-repo files — the inject
 * pipeline doesn't gate on whether danxbot ships the workspace itself.
 */
function renderPerRepoFilesIntoWorkspaces(
  repo: RepoContext,
  danxbotConfigDir: string,
  cfg: Record<string, string>,
  workspacesDir: string,
): void {
  if (!existsSync(workspacesDir)) return;
  const names = readdirSync(workspacesDir).filter((entry) => {
    try {
      return statSync(resolve(workspacesDir, entry)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const name of names) {
    const workspaceRoot = resolve(workspacesDir, name);
    const target = buildInjectTarget(workspaceRoot);
    mkdirSync(target.rulesDir, { recursive: true });
    mkdirSync(target.toolsDir, { recursive: true });

    writeRepoConfigRule(cfg, target);
    copyRepoConfigDocs(danxbotConfigDir, target);
    writeIssuePrefixRule(repo.issuePrefix, target);
    copyRepoToolsDoc(danxbotConfigDir, target);
    copyRepoToolScripts(danxbotConfigDir, target);
  }
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
  }
}

/**
 * Remove the legacy singular `<repo>/.danxbot/workspace/` dir created
 * by the retired `generateWorkspace` helper. Pre-refactor this dir was
 * the dispatched-agent cwd; post-refactor every dispatch resolves a
 * plural workspace under `<repo>/.danxbot/workspaces/<name>/` and the
 * singular dir is dead weight that shadows nothing but still confuses
 * humans grepping the tree. Idempotent — absent dir is a no-op.
 */
function scrubLegacySingularWorkspace(repoLocalPath: string): void {
  const dir = resolve(repoLocalPath, ".danxbot/workspace");
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Remove any `danx-*` files at `<repo>/.claude/{rules,skills,tools}/`.
 * The repo-root `.claude/` is strictly developer-owned per the
 * agent-isolation contract; any `danx-*` file there is either (a) a
 * leftover from a pre-isolation poller version, or (b) someone's
 * misguided attempt to override workspace config. Both cause the
 * exact bug this scrub exists to prevent: claude's ancestor walk
 * finds the repo-root copy, loads stale data, and the agent dispatches
 * with wrong board IDs / repo config.
 *
 * Scope is intentionally narrow — only the `danx-*` prefix, only the
 * three subdirs (`rules/`, `skills/`, `tools/`). Nothing else under
 * `<repo>/.claude/` is touched.
 *
 * Fail-loud per CLAUDE.md "Fail loudly" rule: a swallowed `rm` error
 * here would leave stale `danx-*` config in repo-root, which is the
 * exact bug this scrubber exists to prevent.
 */
function scrubRepoRootDanxArtifacts(repoLocalPath: string): void {
  scrubDanxArtifacts(resolve(repoLocalPath, ".claude"), {
    subdirs: ["rules", "skills", "tools"],
  });
}
