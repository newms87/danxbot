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
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";
import { repoContexts } from "../repo-context.js";
import {
  REVIEW_MIN_CARDS,
  DANXBOT_COMMENT_MARKER,
  TEAM_PROMPT,
  IDEATOR_PROMPT,
} from "./constants.js";
import {
  ensureGitignoreEntry,
  ensureIssuesDirs,
  findByExternalId,
  hydrateFromRemote,
  issuePath,
  stampDispatchAndWrite,
  writeIssue,
} from "./yaml-lifecycle.js";
import { createIssueTracker, TrelloTracker } from "../issue-tracker/index.js";
import type { Issue, IssueRef, IssueTracker } from "../issue-tracker/interface.js";
import { parseSimpleYaml } from "./parse-yaml.js";
import { renderRepoConfigMarkdown } from "./repo-config-rule.js";
import { writeIfChanged } from "../workspace/write-if-changed.js";
import { createLogger } from "../logger.js";
import { dispatch } from "../dispatch/core.js";
import { scrubLegacyTrelloWorkerSymlink } from "./legacy-trello-worker-scrub.js";
import { isLinkOrFile, isSymlink } from "./fs-probe.js";
import type { AgentJob } from "../agent/launcher.js";
import type { RepoContext } from "../types.js";
import {
  getTrelloPollerPickupPrefix,
  isFeatureEnabled,
} from "../settings-file.js";
import { readFlag, writeFlag } from "../critical-failure.js";
import type {
  DispatchTriggerMetadata,
  TrelloTriggerMetadata,
} from "../dashboard/dispatches.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const log = createLogger("poller");

/** Per-repo poller state */
interface RepoPollerState {
  teamRunning: boolean;
  polling: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
  consecutiveFailures: number;
  backoffUntil: number;
  priorTodoCardIds: string[];
  /**
   * The Trello card the current dispatch targets. Set in `spawnClaude`
   * when the trigger is "trello" (null for ideator/api dispatches); read
   * by the post-dispatch "did the card move?" check in
   * `handleAgentCompletion`. Cleared by `cleanupAfterAgent` so stale
   * state from a prior run can't trip the check on the next dispatch.
   * Card URL is reconstructed from cardId when the flag is written —
   * don't duplicate it in state.
   */
  trackedCardId: string | null;
}

const repoState = new Map<string, RepoPollerState>();

function getState(repoName: string): RepoPollerState {
  let state = repoState.get(repoName);
  if (!state) {
    state = {
      teamRunning: false,
      polling: false,
      intervalId: null,
      consecutiveFailures: 0,
      backoffUntil: 0,
      priorTodoCardIds: [],
      trackedCardId: null,
    };
    repoState.set(repoName, state);
  }
  return state;
}

/**
 * Cache of one IssueTracker per repo, populated lazily by `getRepoTracker`.
 *
 * The cache is essential for `MemoryTracker` (`DANXBOT_TRACKER=memory`):
 * a fresh tracker per tick would lose every card it ever stored, breaking
 * any Layer 3 scenario that drives a full ToDo → In Progress → Done
 * lifecycle through repeated `poll()` calls. With caching, the in-memory
 * card sequence survives the entire run. `TrelloTracker` also benefits —
 * `checklistIdCache` and `triagedLabelIdCache` survive across ticks
 * instead of cold-starting every minute.
 *
 * **Lifecycle invariant:** the cache lives until process restart. The
 * worker never rotates `RepoContext` at runtime — credential changes
 * require a redeploy, which recreates the worker container, which
 * tears down this Map naturally. Adding a future tracker with
 * refreshable / short-lived auth (OAuth, rotating tokens) would need
 * to invalidate selectively here; until then, no production code path
 * reads or writes the cache outside `getRepoTracker`.
 *
 * Cleared by `_resetForTesting` so per-test isolation works.
 */
const trackerByRepo = new Map<string, IssueTracker>();

function getRepoTracker(repo: RepoContext): IssueTracker {
  let tracker = trackerByRepo.get(repo.name);
  if (!tracker) {
    tracker = createIssueTracker(repo);
    trackerByRepo.set(repo.name, tracker);
  }
  return tracker;
}

/**
 * Check Needs Help cards for user responses. Cards where a user has replied
 * (latest comment lacks the danxbot marker) are moved to the top of ToDo
 * so they get higher priority than existing ToDo cards.
 *
 * `tracker.getComments` returns comments sorted ascending by timestamp,
 * so the LAST element is the most recent — opposite of the retired
 * Trello-direct comment fetch (which used `limit=1` against an endpoint
 * that returned newest-first). Both produce the same answer: is the
 * most recent comment from the user (no danxbot marker)?
 */
async function checkNeedsHelp(
  repo: RepoContext,
  tracker: IssueTracker,
): Promise<number> {
  let refs: IssueRef[];
  try {
    const all = await tracker.fetchOpenCards();
    refs = all.filter((c) => c.status === "Needs Help");
  } catch (error) {
    log.error(`[${repo.name}] Error fetching Needs Help cards`, error);
    return 0;
  }

  if (refs.length === 0) return 0;

  let movedCount = 0;
  for (const ref of refs) {
    try {
      const comments = await tracker.getComments(ref.external_id);
      const latest = comments.length > 0 ? comments[comments.length - 1] : null;
      if (latest && !latest.text.includes(DANXBOT_COMMENT_MARKER)) {
        log.info(`[${repo.name}] User responded on "${ref.title}" — moving to ToDo`);
        await tracker.moveToStatus(ref.external_id, "ToDo");
        movedCount++;
      }
    } catch (error) {
      log.error(
        `[${repo.name}] Error checking comments for card "${ref.title}"`,
        error,
      );
    }
  }

  return movedCount;
}

export async function poll(repo: RepoContext): Promise<void> {
  const state = getState(repo.name);
  if (state.teamRunning || state.polling) {
    return;
  }

  // Runtime toggle — when the Trello poller is disabled for this repo
  // via the settings file, skip the tick entirely. Checked per-tick so
  // operators can toggle without a worker restart. See
  // `.claude/rules/settings-file.md`.
  if (!isFeatureEnabled(repo, "trelloPoller")) {
    log.info(`[${repo.name}] poller disabled via settings — skipping`);
    return;
  }

  // Critical-failure halt gate. When the agent signaled
  // `critical_failure` or the post-dispatch check caught a dispatch
  // that didn't move its card out of ToDo, a flag file is written at
  // `<repo>/.danxbot/CRITICAL_FAILURE`. The poller refuses to run
  // while the flag is present — a human must clear it (via `rm` or the
  // dashboard DELETE endpoint) after fixing the underlying env issue.
  // Slack listener and /api/launch are unaffected by design — the
  // halt is poller-only. See `.claude/rules/agent-dispatch.md`
  // "Critical failure flag".
  const flag = readFlag(repo.localPath);
  if (flag) {
    log.warn(
      `[${repo.name}] poller halted — critical-failure flag present (source=${flag.source}, dispatch=${flag.dispatchId}): ${flag.reason}`,
    );
    // Halt is a stronger signal than backoff. If we're halted because
    // of a run that also tripped backoff, clear that state so when the
    // operator clears the flag the poller resumes on the very next
    // tick — no leftover "In backoff" log from a dispatch whose real
    // failure mode is now being tracked by the flag file.
    state.consecutiveFailures = 0;
    state.backoffUntil = 0;
    return;
  }

  if (Date.now() < state.backoffUntil) {
    const remainingSeconds = Math.round((state.backoffUntil - Date.now()) / 1000);
    log.info(`[${repo.name}] In backoff — ${remainingSeconds}s remaining (${state.consecutiveFailures} consecutive failures)`);
    return;
  }

  state.polling = true;
  try {
    await _poll(repo);
  } finally {
    state.polling = false;
  }
}

async function _poll(repo: RepoContext): Promise<void> {
  // Re-run the inject pipeline every tick (not just at worker boot) so
  // changes inside `.danxbot/config/` propagate to dispatched agents
  // without a restart. `syncRepoFiles` is idempotent — see its
  // docstring + the per-workspace render loop inside.
  syncRepoFiles(repo);

  log.info(`[${repo.name}] Checking Needs Help + ToDo lists...`);

  // ONE tracker per repo, reused across every tick (see `getRepoTracker`).
  // Threaded through every helper that needs to talk to the issue
  // tracker so `MemoryTracker` state survives the lifecycle and so
  // tests can assert on a single mock.
  const tracker = getRepoTracker(repo);

  // Check Needs Help first — user-responded cards get moved to ToDo top
  const movedFromNeedsHelp = await checkNeedsHelp(repo, tracker);
  if (movedFromNeedsHelp > 0) {
    log.info(
      `[${repo.name}] Moved ${movedFromNeedsHelp} card${movedFromNeedsHelp > 1 ? "s" : ""} from Needs Help to ToDo`,
    );
  }

  let cards: IssueRef[];
  try {
    const all = await tracker.fetchOpenCards();
    cards = all.filter((c) => c.status === "ToDo");
  } catch (error) {
    log.error(`[${repo.name}] Error fetching cards`, error);
    return;
  }

  // Optional pickup-name-prefix filter from per-repo settings. When set,
  // ONLY cards whose name starts with the prefix are eligible for
  // dispatch — pre-existing real ToDo cards are left untouched on this
  // tick. Used by the system-test harness for race-free isolation
  // (Trello `IleofrBj`); operators can also use it to temporarily limit
  // the poller to one card class without disabling it entirely.
  // Important: filter BEFORE the empty-cards branch so a board with
  // only non-matching cards falls through to the ideator check rather
  // than dispatching, AND before `priorTodoCardIds` is captured so
  // stuck-card recovery only considers cards in this dispatch's scope.
  // Match against `IssueRef.title` — TrelloTracker strips the `#ISS-N: `
  // id prefix from card names, so `[System Test] foo` still matches the
  // operator-configured prefix `[System Test]` regardless of whether the
  // card has been reconciled with a local YAML.
  const pickupPrefix = getTrelloPollerPickupPrefix(repo.localPath);
  if (pickupPrefix) {
    const before = cards.length;
    cards = cards.filter((c) => c.title.startsWith(pickupPrefix));
    log.info(
      `[${repo.name}] pickupNamePrefix="${pickupPrefix}" filter: ${cards.length}/${before} cards match`,
    );
  }

  if (cards.length === 0) {
    log.info(`[${repo.name}] No cards in ToDo — checking if ideator needed`);
    await checkAndSpawnIdeator(repo, tracker);
    return;
  }

  log.info(
    `[${repo.name}] Found ${cards.length} card${cards.length > 1 ? "s" : ""} — starting team`,
  );
  cards.forEach((card, i) => log.info(`  ${i + 1}. ${card.title}`));

  // Save tracker-native ids for stuck-card recovery on failure
  const state = getState(repo.name);
  state.priorTodoCardIds = cards.map((c) => c.external_id);

  // Record the first card as the dispatch trigger. One agent session processes
  // the whole ToDo queue; tagging it with the primary card lets the dashboard
  // show what kicked off the run. The UI can expand to show all processed cards
  // by scanning the JSONL for tracker MCP calls.
  const primary = cards[0];
  const trelloMeta: TrelloTriggerMetadata = {
    cardId: primary.external_id,
    cardName: primary.title,
    cardUrl: `https://trello.com/c/${primary.external_id}`,
    listId: repo.trello.todoListId,
    listName: "ToDo",
  };

  // Hydrate-or-load by tracker-native external_id, then dispatch using
  // the resolved INTERNAL id. The agent never sees external_id — the
  // dispatch prompt and YAML filename both use `id`.
  //   1. Pre-generate the dispatch UUID so the same value lands in BOTH
  //      the dispatch row AND the YAML's `dispatch_id` field.
  //   2. `findByExternalId` scans existing YAMLs — if one carries this
  //      external_id, it's authoritative; only `dispatch_id` overwrites.
  //   3. No match → `hydrateFromRemote` pulls metadata, allocates an
  //      ISS-N (or parses one from the title prefix), patches the
  //      tracker title, and writes a fresh local YAML. Reuses the same
  //      cached tracker instance so MemoryTracker state survives.
  //   4. Dispatch task references the local id — agent calls
  //      `danx_issue_save({id})` and never knows external trackers exist.
  const dispatchId = randomUUID();
  const existing = findByExternalId(repo.localPath, primary.external_id);
  let resolvedIssue: Issue;
  if (existing) {
    resolvedIssue = stampDispatchAndWrite(
      repo.localPath,
      existing,
      dispatchId,
    );
  } else {
    resolvedIssue = await hydrateFromRemote(
      tracker,
      primary.external_id,
      dispatchId,
      repo.localPath,
    );
    writeIssue(repo.localPath, resolvedIssue);
  }

  const yamlPath = issuePath(repo.localPath, resolvedIssue.id, "open");
  const task =
    `${TEAM_PROMPT}\n\nEdit ${yamlPath}. ` +
    `Call danx_issue_save({id: "${resolvedIssue.id}"}) when done.`;

  spawnClaude(repo, task, { trigger: "trello", metadata: trelloMeta }, dispatchId);
}

/** Directory containing files to inject into target repos. */
const injectDir = resolve(dirname(fileURLToPath(import.meta.url)), "inject");

/**
 * Validate that .danxbot/config/ in the connected repo and env vars are fully configured.
 * Throws if anything is missing or empty — the poller must not run without valid config.
 */
export function validateRepoConfig(repo: RepoContext): void {
  const errors: string[] = [];
  const danxbotConfigDir = resolve(repo.localPath, ".danxbot/config");

  // 1. .danxbot/config/ directory must exist in the connected repo
  if (!existsSync(danxbotConfigDir)) {
    throw new Error(
      `[${repo.name}] .danxbot/config/ not found in connected repo. Run ./install.sh to set up danxbot.`,
    );
  }

  // 2. Required files must exist and not be empty
  const requiredFiles = [
    { path: "config.yml", label: "Repo configuration" },
    { path: "overview.md", label: "Repo overview" },
    { path: "workflow.md", label: "Repo workflow" },
    { path: "trello.yml", label: "Trello board/list/label IDs" },
  ];

  for (const { path, label } of requiredFiles) {
    const fullPath = resolve(danxbotConfigDir, path);
    if (!existsSync(fullPath)) {
      errors.push(`Missing .danxbot/config/${path} (${label})`);
    } else {
      const content = readFileSync(fullPath, "utf-8").trim();
      if (!content) {
        errors.push(`Empty .danxbot/config/${path} (${label})`);
      }
    }
  }

  // 3. config.yml must have required fields with non-empty values
  const repoConfigYml = resolve(danxbotConfigDir, "config.yml");
  if (existsSync(repoConfigYml)) {
    const raw = readFileSync(repoConfigYml, "utf-8");
    const cfg = parseSimpleYaml(raw);

    const requiredFields = [
      { key: "name", label: "Repo name" },
      { key: "url", label: "Repo URL" },
      { key: "runtime", label: "Runtime (docker or local)" },
      { key: "language", label: "Language" },
    ];

    for (const { key, label } of requiredFields) {
      if (!cfg[key] || !cfg[key].trim()) {
        errors.push(
          `Missing '${key}' in .danxbot/config/config.yml (${label})`,
        );
      }
    }

    // If runtime is docker, compose config is required
    if (cfg.runtime === "docker") {
      const dockerFields = [
        { key: "docker.compose_file", label: "Docker compose file" },
        { key: "docker.service_name", label: "Docker service name" },
        { key: "docker.project_name", label: "Docker project name" },
      ];
      for (const { key, label } of dockerFields) {
        if (!cfg[key] || !cfg[key].trim()) {
          errors.push(
            `Missing '${key}' in .danxbot/config/config.yml (${label} — required when runtime is docker)`,
          );
        }
      }

      // Compose file must actually exist
      const composeFile = resolve(danxbotConfigDir, "compose.yml");
      if (!existsSync(composeFile)) {
        errors.push(
          `Missing .danxbot/config/compose.yml (required when runtime is docker)`,
        );
      }
    }
  }

  // 4. Required environment variables (secrets)
  const requiredEnvVars = [
    { name: "ANTHROPIC_API_KEY", label: "Anthropic API key" },
    { name: "REPOS", label: "Connected repos (name:url,...)" },
  ];

  for (const { name, label } of requiredEnvVars) {
    const value = process.env[name];
    if (!value || !value.trim()) {
      errors.push(`Missing env var ${name} (${label})`);
    }
  }

  // 5. Per-repo secrets must be set (loaded via RepoContext)
  if (!repo.trello.apiKey) errors.push(`Missing DANX_TRELLO_API_KEY in ${repo.name}/.danxbot/.env`);
  if (!repo.trello.apiToken) errors.push(`Missing DANX_TRELLO_API_TOKEN in ${repo.name}/.danxbot/.env`);
  if (!repo.githubToken) errors.push(`Missing DANX_GITHUB_TOKEN in ${repo.name}/.danxbot/.env`);

  // 6. Claude auth files must exist
  const claudeAuthDir = resolve(projectRoot, "claude-auth");
  const claudeJson = resolve(claudeAuthDir, ".claude.json");
  if (!existsSync(claudeJson)) {
    errors.push(
      `Missing claude-auth/.claude.json (Claude Code credentials — run ./install.sh Step 6)`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `[${repo.name}] Repo config validation failed:\n  - ${errors.join("\n  - ")}\n\nRun ./install.sh to complete setup.`,
    );
  }

  log.info(`[${repo.name}] Repo config validated successfully`);
}

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
    writeFileSync(resolve(target.rulesDir, dest), header + readFileSync(srcPath, "utf-8"));
  }
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
 * Step 6b: inject/workspaces/<name>/ -> <repo>/.danxbot/workspaces/<name>/.
 *
 * Part of the workspace-dispatch epic (Trello `jAdeJgi5`, Phase 2). Every
 * named workspace under `src/poller/inject/workspaces/` is mirrored in
 * full into the connected repo so every triggered agent can cwd into an
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
 *     poller has no business deleting anything in a connected repo; that
 *     authority belongs to git (for tracked files) or the operator (for
 *     gitignored stragglers via `git clean -fdX`). Earlier revisions
 *     wholesale-rmSync'd workspace dirs absent from source — that nuked
 *     a gpt-manager-authored `schema-builder/` workspace tracked in
 *     gpt-manager's git, blast-radius incident the contract now forbids.
 *   - **Executable bit.** `.sh` files nested under a `tools/` ancestor
 *     (at any depth inside the workspace) get `chmod 0755`. Anything
 *     else keeps default perms. The check is intentionally narrow — a
 *     `.sh` file at the workspace root is NOT made executable; only
 *     shell helpers the agent will invoke as commands via the injected
 *     `tools/` PATH contract.
 *   - **Empty source is a no-op.** In Phase 2 no fixtures ship — the
 *     helper exists so Phases 3/4/5 can drop workspace subtrees in
 *     place without touching the inject wiring. The function still
 *     ensures the target root directory is created so the on-disk shape
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
    const workspaceDir = resolve(workspacesTargetDir, name);
    mirrorWorkspaceTree(
      resolve(injectWorkspacesDir, name),
      workspaceDir,
      [],
    );
  }

  // Phase 5 cleanup (Trello 69f76e8d069eb71dd315d363): the migration
  // window for the legacy `trello-worker` symlink has closed. Remove
  // any leftover symlink so the workspace listing reflects only the
  // canonical name. Real directories at that path are preserved
  // (operator-authored workspaces, e.g. gpt-manager's schema-builder
  // sibling pattern). See `legacy-trello-worker-scrub.ts`.
  scrubLegacyTrelloWorkerSymlink(workspacesTargetDir);

  // Symlink mcp-servers/ into EVERY workspace present at target, including
  // repo-authored workspaces (e.g. gpt-manager's schema-builder) that
  // didn't come through our inject source. Every dispatched agent expects
  // to find the danxbot mcp-servers tree at `<workspace>/mcp-servers`
  // regardless of who authored the workspace.
  for (const entry of readdirSync(workspacesTargetDir)) {
    const workspaceDir = resolve(workspacesTargetDir, entry);
    if (!statSync(workspaceDir).isDirectory()) continue;
    injectMcpServers(workspaceDir);
  }
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
 * `/home/.../danxbot`; container → `/danxbot/app`). The poller and the
 * dispatched agent share that install, so the symlink resolves correctly
 * for the runtime that wrote it.
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
 *      `src/poller/inject/workspaces/<name>/` → `<repo>/.danxbot/workspaces/<name>/`
 *      verbatim. Each workspace ships its own static skills, rules,
 *      `.mcp.json`, `CLAUDE.md`, etc. — all generic, identical for
 *      every connected repo.
 *
 *   2. **Per-repo render** (`renderPerRepoFilesIntoWorkspaces`). For
 *      each workspace, writes the per-repo rendered files into its
 *      `.claude/`: `danx-repo-config.md`, `danx-repo-overview.md`,
 *      `danx-repo-workflow.md`, `danx-tools.md`, and repo-specific tool
 *      scripts. These differ per repo
 *      (repo name, runtime, etc.) so they cannot live in the static
 *      inject tree — they are rendered fresh every tick from the
 *      `RepoContext`. Duplicated across every workspace dir so
 *      cwd-relative skill references resolve locally.
 *
 *   3. **Scrubs** enforce the agent-isolation contract: stale `danx-*`
 *      files at `<repo>/.claude/{rules,skills,tools}/` and the legacy
 *      singular `<repo>/.danxbot/workspace/` directory are removed.
 *      Without these scrubs claude's ancestor walk for `.claude/` dirs
 *      finds the repo-root copies and loads stale config (the Phase 6
 *      "agent reads Flytebot Chat board IDs after we switched to
 *      Platform V3" incident).
 *
 * Called on every poll tick to keep workspaces up to date. Each
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

  // Stage 2: per-repo render into every plural workspace.
  renderPerRepoFilesIntoWorkspaces(repo, danxbotConfigDir, cfg, workspacesDir);

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
    copyRepoToolsDoc(danxbotConfigDir, target);
    copyRepoToolScripts(danxbotConfigDir, target);
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
 */
function scrubRepoRootDanxArtifacts(repoLocalPath: string): void {
  const subdirs = ["rules", "skills", "tools"];
  for (const sub of subdirs) {
    const dir = resolve(repoLocalPath, ".claude", sub);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith("danx-")) continue;
      const path = resolve(dir, entry);
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (err) {
        log.warn(`Failed to scrub ${path}:`, err);
      }
    }
  }
}

function spawnClaude(
  repo: RepoContext,
  prompt: string,
  apiDispatchMeta: DispatchTriggerMetadata,
  dispatchId?: string,
): void {
  const state = getState(repo.name);

  state.teamRunning = true;

  // Track the Trello card this dispatch targets. The post-dispatch
  // "card didn't move out of ToDo" check in `handleAgentCompletion`
  // reads this field to detect env-level blockers. Ideator/api
  // dispatches are not card-specific — null tracks "no card to check".
  state.trackedCardId =
    apiDispatchMeta.trigger === "trello"
      ? apiDispatchMeta.metadata.cardId
      : null;

  // The poller's tracker calls (fetchOpenCards, moveToStatus, retro
  // comments) need a usable IssueTracker. Resolve the cached tracker
  // up front so the validation key is the RESOLVED tracker class, not
  // an env var the createIssueTracker factory reads internally — that
  // keeps "which tracker is active" with one source of truth and
  // eliminates the only `process.env` read that used to live on the
  // poller hot path.
  //
  // Only TrelloTracker requires populated credentials on RepoContext;
  // MemoryTracker (DANXBOT_TRACKER=memory) constructs without them.
  // Fail loud here so a missing value surfaces as a clear configuration
  // error before we spawn an agent that the poller can't follow up on.
  // The dispatch overlay itself no longer needs these (Phase 5 of
  // tracker-agnostic-agents retired the trello MCP server entry from
  // the issue-worker workspace).
  const tracker = getRepoTracker(repo);
  const trello = repo.trello;
  if (
    tracker instanceof TrelloTracker &&
    (!trello?.apiKey || !trello?.apiToken || !trello?.boardId)
  ) {
    throw new Error(
      `[${repo.name}] poller dispatchCard called without complete trello credentials on RepoContext`,
    );
  }

  // Workspace-shaped dispatch (Phase 3 of the workspace-dispatch epic,
  // Trello `q5aFuINM`). The poller's allowed-tools, MCP server set, and
  // skill surface live in `src/poller/inject/workspaces/issue-worker/`
  // and are mirrored to `<repo>/.danxbot/workspaces/issue-worker/` by
  // the inject pipeline on every poll tick. `dispatch` resolves that
  // fixture, merges the danxbot infrastructure server, and runs the
  // shared spawn loop — stall recovery, activeJobs registration,
  // completion signalling. The poller still supplies its own
  // `timeoutMs` (60x poll interval) and chains `handleAgentCompletion`
  // through `onComplete`. See `.claude/rules/agent-dispatch.md`.
  //
  // Fire-and-forget: `dispatch` returns once the agent is spawned (NOT
  // when it completes). The poller already hands completion to
  // `onComplete`, so awaiting here would only serialize the initial
  // spawn with... nothing.
  dispatch({
    repo,
    task: prompt,
    workspace: "issue-worker",
    // `DANXBOT_WORKER_PORT` and the dispatchId-derived URLs are
    // auto-injected by `dispatch()` from `repo.workerPort`. Phase 5 of
    // tracker-agnostic-agents retired the trello MCP server entry from
    // the issue-worker workspace, so TRELLO_API_KEY / TRELLO_TOKEN /
    // TRELLO_BOARD_ID no longer need an overlay either — agents now
    // talk to the tracker through the danxbot MCP server's
    // `danx_issue_*` tools, which the worker proxies.
    overlay: {},
    timeoutMs: config.pollerIntervalMs * 60,
    apiDispatchMeta,
    // Phase 2 of tracker-agnostic-agents (Trello ZDb7FOGO): when the trello
    // trigger pre-stamped a UUID into the YAML, thread it through so the
    // dispatch row's id matches the YAML's `dispatch_id`. Ideator and other
    // non-trello dispatches omit this and inherit the auto-generated UUID
    // inside `dispatch()`.
    dispatchId,
    onComplete: (job) => {
      handleAgentCompletion(repo, state, job).catch((err) =>
        log.error(`[${repo.name}] Error in post-completion handler`, err),
      );
    },
  }).catch((err) => {
    // Pre-spawn failures (workspace resolution error, OS spawn error, MCP probe
    // failure) deliberately skip the exponential-backoff escalator:
    // these are configuration / infrastructure errors, not intermittent
    // agent failures. We reset `teamRunning` so the next tick retries
    // immediately and the problem shows up every minute until the
    // operator fixes it. Runtime agent failures take the separate
    // `handleAgentCompletion` path above, which DOES apply backoff.
    log.error(`[${repo.name}] dispatch() failed before agent spawned`, err);
    cleanupAfterAgent(state);
  });
}

/**
 * Handle agent completion: track failures, apply backoff, recover stuck cards.
 * On success, resets the failure counter. On failure, increments the counter,
 * recovers stuck cards, and applies exponential backoff.
 */
async function handleAgentCompletion(
  repo: RepoContext,
  state: RepoPollerState,
  job: AgentJob,
): Promise<void> {
  const isFailure = job.status !== "completed";

  if (isFailure) {
    state.consecutiveFailures++;
    log.warn(
      `[${repo.name}] Agent ${job.status} (${state.consecutiveFailures} consecutive failure${state.consecutiveFailures > 1 ? "s" : ""})`,
    );

    // Recover stuck cards before backoff
    await recoverStuckCards(repo, state, job);

    const schedule = config.pollerBackoffScheduleMs;
    if (state.consecutiveFailures > schedule.length) {
      log.error(
        `[${repo.name}] Max consecutive failures (${state.consecutiveFailures}) exceeded schedule — halting poller`,
      );
      cleanupAfterAgent(state);
      return; // Don't resume polling
    }

    const backoffMs = schedule[state.consecutiveFailures - 1];
    state.backoffUntil = Date.now() + backoffMs;
    log.warn(`[${repo.name}] Backing off ${backoffMs / 1000}s before next attempt`);
  } else {
    if (state.consecutiveFailures > 0) {
      log.info(`[${repo.name}] Agent succeeded — resetting failure counter`);
    }
    state.consecutiveFailures = 0;
    state.backoffUntil = 0;
  }

  // Post-dispatch card-progress check. Runs on both success and
  // failure — a "completed" agent that never moved the card is as much
  // of an env-level signal as a "failed" one. If the card still sits
  // in ToDo, this writes the critical-failure flag; the next tick's
  // halt gate will see it and refuse to dispatch.
  if (state.trackedCardId) {
    await checkCardProgressedOrHalt(repo, state, job);
  }

  cleanupAfterAgent(state);
  log.info(`[${repo.name}] Headless agent finished — resuming polling`);
  poll(repo).catch((err) =>
    log.error(`[${repo.name}] Re-poll after headless agent failed`, err),
  );
}

function cleanupAfterAgent(state: RepoPollerState): void {
  state.teamRunning = false;
  state.priorTodoCardIds = [];
  state.trackedCardId = null;
}

/**
 * After a trello-triggered dispatch exits, fetch the tracked card's
 * current list. If it's still in ToDo, the dispatch made zero
 * progress — an env-level blocker the poller cannot recover from on
 * its own. Write the critical-failure flag so the next tick halts.
 *
 * Complementary to `recoverStuckCards`, which handles the case where
 * the agent moved a card to In Progress but failed mid-work (the
 * recovery there moves it to Needs Help). This function handles the
 * distinct case where the agent never moved the card at all — the
 * classic signal that MCP or Bash failed to load.
 *
 * A fetch failure here does NOT trip the flag: we only halt when we
 * have positive evidence the card stayed in ToDo. Swallowing the
 * error and logging is intentional — the next tick will try again.
 */
async function checkCardProgressedOrHalt(
  repo: RepoContext,
  state: RepoPollerState,
  job: AgentJob,
): Promise<void> {
  const cardId = state.trackedCardId;
  if (!cardId) return;

  const tracker = getRepoTracker(repo);
  let card: Issue;
  try {
    card = await tracker.getCard(cardId);
  } catch (err) {
    log.error(
      `[${repo.name}] Failed to fetch tracked card ${cardId} after dispatch — skipping card-progress check`,
      err,
    );
    return;
  }

  if (card.status !== "ToDo") {
    // Card moved to In Progress / Needs Help / Done / Cancelled / Review.
    // The dispatch made SOME progress even if it ultimately failed — not
    // an env-level issue. Leave the flag untripped.
    return;
  }

  log.error(
    `[${repo.name}] Tracked card "${card.title}" (${cardId}) still in ToDo after dispatch ${job.id} — writing critical-failure flag`,
  );
  writeFlag(repo.localPath, {
    source: "post-dispatch-check",
    dispatchId: job.id,
    cardId,
    cardUrl: `https://trello.com/c/${cardId}`,
    reason: `Tracked card "${card.title}" did not move out of ToDo after dispatch`,
    detail:
      `Card ${cardId} (${card.title}) stayed in the ToDo list across dispatch ${job.id} ` +
      `(status=${job.status}, summary=${job.summary || "none"}). ` +
      `Poller halts until this flag is cleared and the underlying environment blocker is fixed.`,
  });
}

/**
 * After agent failure, check if any cards moved from ToDo to In Progress
 * during the agent's run. If so, move them to Needs Help with a comment.
 */
async function recoverStuckCards(
  repo: RepoContext,
  state: RepoPollerState,
  job: AgentJob,
): Promise<void> {
  if (state.priorTodoCardIds.length === 0) return;

  const tracker = getRepoTracker(repo);
  try {
    const all = await tracker.fetchOpenCards();
    const inProgressCards = all.filter((c) => c.status === "In Progress");
    const stuckCards = inProgressCards.filter((card) =>
      state.priorTodoCardIds.includes(card.external_id),
    );

    for (const card of stuckCards) {
      log.warn(`[${repo.name}] Recovering stuck card "${card.title}" → Needs Help`);
      await tracker.moveToStatus(card.external_id, "Needs Help");

      const elapsed = formatElapsed(job);
      const comment = `## Agent Failure — Card Recovery

The agent working on this card ${job.status} after ${elapsed}.

**Error:** ${job.summary || "No details available"}

This card was automatically moved to Needs Help. Review the error and move back to ToDo to retry.

${DANXBOT_COMMENT_MARKER}`;

      await tracker.addComment(card.external_id, comment);
    }
  } catch (err) {
    log.error(`[${repo.name}] Failed to recover stuck cards`, err);
  }
}

function formatElapsed(job: AgentJob): string {
  const ms = (job.completedAt?.getTime() ?? Date.now()) - job.startedAt.getTime();
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}min`;
}

async function checkAndSpawnIdeator(
  repo: RepoContext,
  tracker: IssueTracker,
): Promise<void> {
  // Per-repo runtime toggle. Env default is `false` — operators opt in
  // via the dashboard Agents tab. Checked BEFORE the Review-list fetch
  // so a disabled repo doesn't pay the tracker round-trip on every
  // empty-ToDo tick. See `.claude/rules/settings-file.md`.
  if (!isFeatureEnabled(repo, "ideator")) {
    log.info(
      `[${repo.name}] Ideator disabled (settings.json override or env default) — skipping`,
    );
    return;
  }

  let reviewCards: IssueRef[];
  try {
    const all = await tracker.fetchOpenCards();
    reviewCards = all.filter((c) => c.status === "Review");
  } catch (error) {
    log.error(`[${repo.name}] Error fetching Review cards`, error);
    return;
  }

  if (reviewCards.length >= REVIEW_MIN_CARDS) {
    log.info(
      `[${repo.name}] Review has ${reviewCards.length} cards (min ${REVIEW_MIN_CARDS}) — no ideation needed`,
    );
    return;
  }

  log.info(
    `[${repo.name}] Review has ${reviewCards.length} cards (min ${REVIEW_MIN_CARDS}) — spawning ideator`,
  );
  // Ideator runs don't originate from a specific card — tag them as API
  // dispatches so the poller run is still visible in dispatch history.
  spawnClaude(repo, IDEATOR_PROMPT, {
    trigger: "api",
    metadata: {
      endpoint: "poller/ideator",
      callerIp: null,
      statusUrl: null,
      initialPrompt: IDEATOR_PROMPT.slice(0, 500),
    },
  });
}

export function shutdown(): void {
  log.info("Shutting down...");

  for (const [, state] of repoState) {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  process.exit(0);
}


export function start(): void {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (repoContexts.length === 0) {
    log.error("No repos configured — nothing to poll");
    return;
  }

  // Every repo gets a polling interval scheduled regardless of the env
  // default — the per-tick `isFeatureEnabled(repo, "trelloPoller")` check
  // in `poll()` honors runtime overrides from `.danxbot/settings.json`, so
  // boot-time skipping would defeat the toggle. Boot-time validation only
  // runs when the env default says Trello is supposed to be on; a repo
  // that opts in at runtime takes responsibility for ensuring its config
  // is complete (the first enabled tick surfaces config gaps naturally).
  for (const repo of repoContexts) {
    if (repo.trelloEnabled) {
      validateRepoConfig(repo);
    } else {
      log.info(
        `[${repo.name}] Trello env-default disabled — skipping boot validation. Runtime override in settings.json can still enable the poller.`,
      );
    }

    const state = getState(repo.name);
    const intervalSeconds = config.pollerIntervalMs / 1000;
    log.info(`[${repo.name}] Started — polling every ${intervalSeconds}s`);

    poll(repo);
    state.intervalId = setInterval(() => poll(repo), config.pollerIntervalMs);
  }
}

/** Reset module state for testing. Do not use in production. */
export function _resetForTesting(): void {
  for (const state of repoState.values()) {
    state.teamRunning = false;
    state.polling = false;
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }
  repoState.clear();
  trackerByRepo.clear();
}

// Auto-start when run as the direct entrypoint.
const isDirectEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/poller/index.ts");

if (isDirectEntrypoint) {
  start();
}
