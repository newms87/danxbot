import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";
import { repoContexts } from "../repo-context.js";
import {
  REVIEW_MIN_CARDS,
  DANXBOT_COMMENT_MARKER,
  TEAM_PROMPT,
  IDEATOR_PROMPT,
  POLLER_ALLOW_TOOLS,
} from "./constants.js";
import { parseSimpleYaml } from "./parse-yaml.js";
import { writeTrelloConfigRule } from "./trello-config-rule.js";
import { createLogger } from "../logger.js";
import { dispatch } from "../dispatch/core.js";
import {
  fetchTodoCards,
  fetchNeedsHelpCards,
  fetchReviewCards,
  fetchInProgressCards,
  fetchLatestComment,
  fetchCard,
  moveCardToList,
  addComment,
  isUserResponse,
} from "./trello-client.js";
import type { AgentJob } from "../agent/launcher.js";
import type { RepoContext, TrelloConfig } from "../types.js";
import { isFeatureEnabled } from "../settings-file.js";
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
 * Check Needs Help cards for user responses. Cards where a user has replied
 * (latest comment lacks the danxbot marker) are moved to the top of ToDo
 * so they get higher priority than existing ToDo cards.
 */
async function checkNeedsHelp(trello: TrelloConfig): Promise<number> {
  let cards;
  try {
    cards = await fetchNeedsHelpCards(trello);
  } catch (error) {
    log.error("Error fetching Needs Help cards", error);
    return 0;
  }

  if (cards.length === 0) return 0;

  let movedCount = 0;
  for (const card of cards) {
    try {
      const latestComment = await fetchLatestComment(trello, card.id);
      if (isUserResponse(latestComment)) {
        log.info(`User responded on "${card.name}" — moving to ToDo`);
        await moveCardToList(trello, card.id, trello.todoListId, "top");
        movedCount++;
      }
    } catch (error) {
      log.error(`Error checking comments for card "${card.name}"`, error);
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
  // Sync danxbot config into target repo on every poll cycle
  syncRepoFiles(repo);

  // Write Trello config into target repo's rules
  const repoRulesDir = resolve(repo.localPath, ".claude/rules");
  mkdirSync(repoRulesDir, { recursive: true });
  writeTrelloConfigRule(repo.trello, repoRulesDir);

  log.info(`[${repo.name}] Checking Needs Help + ToDo lists...`);

  // Check Needs Help first — user-responded cards get moved to ToDo top
  const movedFromNeedsHelp = await checkNeedsHelp(repo.trello);
  if (movedFromNeedsHelp > 0) {
    log.info(
      `[${repo.name}] Moved ${movedFromNeedsHelp} card${movedFromNeedsHelp > 1 ? "s" : ""} from Needs Help to ToDo`,
    );
  }

  let cards;
  try {
    cards = await fetchTodoCards(repo.trello);
  } catch (error) {
    log.error(`[${repo.name}] Error fetching cards`, error);
    return;
  }

  if (cards.length === 0) {
    log.info(`[${repo.name}] No cards in ToDo — checking if ideator needed`);
    await checkAndSpawnIdeator(repo);
    return;
  }

  log.info(
    `[${repo.name}] Found ${cards.length} card${cards.length > 1 ? "s" : ""} — starting team`,
  );
  cards.forEach((card, i) => log.info(`  ${i + 1}. ${card.name}`));

  // Save card IDs for stuck-card recovery on failure
  const state = getState(repo.name);
  state.priorTodoCardIds = cards.map((c) => c.id);

  // Record the first card as the dispatch trigger. One agent session processes
  // the whole ToDo queue; tagging it with the primary card lets the dashboard
  // show what kicked off the run. The UI can expand to show all processed cards
  // by scanning the JSONL for Trello MCP calls.
  const primary = cards[0];
  const trelloMeta: TrelloTriggerMetadata = {
    cardId: primary.id,
    cardName: primary.name,
    cardUrl: `https://trello.com/c/${primary.id}`,
    listId: repo.trello.todoListId,
    listName: "ToDo",
  };
  spawnClaude(repo, TEAM_PROMPT, { trigger: "trello", metadata: trelloMeta });
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
 * Sync danxbot config into the target repo's .claude/ directory. All injected
 * files use the `danx-` prefix so they're clearly identifiable and gitignore-able.
 * Called on every poll cycle to keep targets up to date.
 */
function syncRepoFiles(repo: RepoContext): void {
  const danxbotConfigDir = resolve(repo.localPath, ".danxbot/config");
  if (!existsSync(danxbotConfigDir)) return;

  const repoDir = repo.localPath;
  const repoClaudeDir = resolve(repoDir, ".claude");
  const repoRulesDir = resolve(repoClaudeDir, "rules");
  const repoSkillsDir = resolve(repoClaudeDir, "skills");
  const repoToolsDir = resolve(repoClaudeDir, "tools");
  const overridesDir = resolve(projectRoot, "repo-overrides");

  mkdirSync(repoRulesDir, { recursive: true });
  mkdirSync(repoToolsDir, { recursive: true });

  // 1. Generate danx-repo-config.md from .danxbot/config/config.yml
  const repoConfigYml = resolve(danxbotConfigDir, "config.yml");
  const raw = readFileSync(repoConfigYml, "utf-8");
  const cfg = parseSimpleYaml(raw);

  const name = cfg.name || "unknown";
  const url = cfg.url || "";
  const runtime = cfg.runtime || "local";
  const language = cfg.language || "";
  const framework = cfg.framework || "";
  const testCmd = cfg["commands.test"] || "";
  const lintCmd = cfg["commands.lint"] || "";
  const typeCheckCmd = cfg["commands.type_check"] || "";
  const devCmd = cfg["commands.dev"] || "";
  const composeFile = cfg["docker.compose_file"] || "";
  const serviceName = cfg["docker.service_name"] || "";
  const projectName = cfg["docker.project_name"] || "";
  const sourcePath = cfg["paths.source"] || "";
  const testsPath = cfg["paths.tests"] || "";
  const gitMode = cfg.git_mode || "pr";

  let repoConfigContent = `# Repo Config (auto-generated by danxbot — do not edit)

## Repo

| Field | Value |
|-------|-------|
| Name | \`${name}\` |
| URL | \`${url}\` |
| Runtime | \`${runtime}\` |
| Language | \`${language}\` |
| Framework | \`${framework}\` |
| Git Mode | \`${gitMode}\` |

## Commands

| Command | Value |
|---------|-------|
| Test | \`${testCmd}\` |
| Lint | \`${lintCmd}\` |
| Type Check | \`${typeCheckCmd}\` |
| Dev | \`${devCmd}\` |

## Paths

| Path | Value |
|------|-------|
| Source | \`${sourcePath}\` |
| Tests | \`${testsPath}\` |
`;

  if (runtime === "docker" && composeFile) {
    repoConfigContent += `
## Docker

| Field | Value |
|-------|-------|
| Compose File | \`${composeFile}\` |
| Service Name | \`${serviceName}\` |
| Project Name | \`${projectName}\` |
`;
  }

  writeFileSync(resolve(repoRulesDir, "danx-repo-config.md"), repoConfigContent);

  // 2. Copy overview.md and workflow.md → danx-repo-overview.md / danx-repo-workflow.md
  for (const [src, dest] of [
    ["overview.md", "danx-repo-overview.md"],
    ["workflow.md", "danx-repo-workflow.md"],
  ] as const) {
    const srcPath = resolve(danxbotConfigDir, src);
    if (existsSync(srcPath)) {
      const header = `<!-- AUTO-GENERATED by danxbot from .danxbot/config/${src} — do not edit -->\n\n`;
      const body = readFileSync(srcPath, "utf-8");
      writeFileSync(resolve(repoRulesDir, dest), header + body);
    }
  }

  // 3. Copy repo-specific tools.md → .claude/rules/danx-tools.md
  const toolsDocSource = resolve(danxbotConfigDir, "tools.md");
  if (existsSync(toolsDocSource)) {
    copyFileSync(toolsDocSource, resolve(repoRulesDir, "danx-tools.md"));
  }

  // 4. Copy repo-specific tool scripts → .claude/tools/ (executable)
  const toolsScriptsSource = resolve(danxbotConfigDir, "tools");
  if (existsSync(toolsScriptsSource)) {
    for (const file of readdirSync(toolsScriptsSource)) {
      const src = resolve(toolsScriptsSource, file);
      const dest = resolve(repoToolsDir, file);
      copyFileSync(src, dest);
      try {
        chmodSync(dest, 0o755);
      } catch (e) {
        log.warn(`Failed to chmod ${dest}:`, e);
      }
    }
  }

  // 5. Inject danx-* skills from inject/skills/. Authoritative sync: any
  // danx-* skill dir present in the destination but missing from the source
  // is removed, so deletions in inject/skills/ propagate to consuming repos.
  const injectSkillsDir = resolve(injectDir, "skills");
  if (existsSync(injectSkillsDir)) {
    const sourceSkillNames = new Set(readdirSync(injectSkillsDir));
    if (existsSync(repoSkillsDir)) {
      for (const existing of readdirSync(repoSkillsDir)) {
        if (existing.startsWith("danx-") && !sourceSkillNames.has(existing)) {
          rmSync(resolve(repoSkillsDir, existing), { recursive: true, force: true });
        }
      }
    }
    for (const skillName of sourceSkillNames) {
      const srcSkillDir = resolve(injectSkillsDir, skillName);
      const destSkillDir = resolve(repoSkillsDir, skillName);
      mkdirSync(destSkillDir, { recursive: true });
      for (const file of readdirSync(srcSkillDir)) {
        copyFileSync(resolve(srcSkillDir, file), resolve(destSkillDir, file));
      }
    }
  }

  // 5b. Inject danx-* rule docs from inject/rules/ into the target repo's
  // `.claude/rules/`. These rules are AUTHORED FOR DISPATCHED AGENTS —
  // they're read at session start inside a connected repo's cwd and enforce
  // behaviors like "signal danxbot_complete with critical_failure when the
  // environment is broken". No pruning: other danx-* rule files in
  // repoRulesDir are generated by steps 1-3 above (danx-repo-config.md,
  // danx-repo-overview.md, danx-repo-workflow.md, danx-tools.md) and
  // overlapping prune logic would nuke them. Overwrite-on-copy is
  // idempotent enough — stale rule files don't break workflows the way
  // stale skills/tools can.
  const injectRulesDir = resolve(injectDir, "rules");
  if (existsSync(injectRulesDir)) {
    for (const file of readdirSync(injectRulesDir)) {
      if (!file.endsWith(".md")) continue;
      copyFileSync(
        resolve(injectRulesDir, file),
        resolve(repoRulesDir, file),
      );
    }
  }

  // 6. Inject danx-* tools from inject/tools/. Authoritative sync: any
  // danx-* file present in the destination but missing from the source is
  // removed, so deletions in inject/tools/ propagate to consuming repos.
  const injectToolsDir = resolve(injectDir, "tools");
  if (existsSync(injectToolsDir)) {
    const sourceToolNames = new Set(readdirSync(injectToolsDir));
    if (existsSync(repoToolsDir)) {
      for (const existing of readdirSync(repoToolsDir)) {
        if (existing.startsWith("danx-") && !sourceToolNames.has(existing)) {
          rmSync(resolve(repoToolsDir, existing), { force: true });
        }
      }
    }
    for (const file of sourceToolNames) {
      const src = resolve(injectToolsDir, file);
      const dest = resolve(repoToolsDir, file);
      copyFileSync(src, dest);
      try {
        chmodSync(dest, 0o755);
      } catch (e) {
        log.warn(`Failed to chmod ${dest}:`, e);
      }
    }
  }

  // 7. Copy compose override to repo-overrides/ (optional)
  const composeSource = resolve(danxbotConfigDir, "compose.yml");
  if (existsSync(composeSource)) {
    mkdirSync(overridesDir, { recursive: true });
    copyFileSync(composeSource, resolve(overridesDir, `${name}-compose.yml`));
  }

  // 8. Copy docs/ → danxbot docs dir (domains and schema)
  const repoDocsDir = resolve(danxbotConfigDir, "docs");
  if (existsSync(repoDocsDir)) {
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

  // 9. Copy .danxbot/features.md → docs/features.md (only if not already present)
  const danxbotDir = resolve(danxbotConfigDir, "..");
  const featuresSource = resolve(danxbotDir, "features.md");
  const featuresDest = resolve(projectRoot, "docs", "features.md");
  if (existsSync(featuresSource) && !existsSync(featuresDest)) {
    mkdirSync(resolve(projectRoot, "docs"), { recursive: true });
    copyFileSync(featuresSource, featuresDest);
  }
}

function spawnClaude(
  repo: RepoContext,
  prompt: string,
  apiDispatchMeta: DispatchTriggerMetadata,
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

  // Unified dispatch path: the poller shares `dispatch()` with
  // `/api/launch` and `/api/resume`. Same MCP resolver, same settings
  // file, same danxbot-complete injection, same stall recovery. The
  // poller supplies its own `timeoutMs` (60x poll interval), its own
  // `allowTools` (the `/danx-next` skill surface — `POLLER_ALLOW_TOOLS`),
  // and chains `handleAgentCompletion` through `onComplete`. `dispatch()`
  // owns `DANXBOT_REPO_NAME` injection from `input.repo.name` and
  // defaults `openTerminal` to `config.isHost`, so the poller doesn't
  // restate either invariant. See `.claude/rules/agent-dispatch.md` and
  // the XCptaJ34 Trello card (Phase 4) for the full contract.
  //
  // Fire-and-forget: dispatch() returns a promise that resolves once
  // the agent is spawned (NOT when it completes). The poller already
  // hands completion handling to `onComplete`, so awaiting here would
  // only serialize the initial spawn with... nothing.
  dispatch({
    repo,
    task: prompt,
    allowTools: POLLER_ALLOW_TOOLS,
    timeoutMs: config.pollerIntervalMs * 60,
    apiDispatchMeta,
    onComplete: (job) => {
      handleAgentCompletion(repo, state, job).catch((err) =>
        log.error(`[${repo.name}] Error in post-completion handler`, err),
      );
    },
  }).catch((err) => {
    // Pre-spawn failures (bad `allowTools`, OS spawn error, MCP probe
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

  let card;
  try {
    card = await fetchCard(repo.trello, cardId);
  } catch (err) {
    log.error(
      `[${repo.name}] Failed to fetch tracked card ${cardId} after dispatch — skipping card-progress check`,
      err,
    );
    return;
  }

  if (card.idList !== repo.trello.todoListId) {
    // Card moved to In Progress / Needs Help / Done / Cancelled / Review.
    // The dispatch made SOME progress even if it ultimately failed — not
    // an env-level issue. Leave the flag untripped.
    return;
  }

  log.error(
    `[${repo.name}] Tracked card "${card.name}" (${cardId}) still in ToDo after dispatch ${job.id} — writing critical-failure flag`,
  );
  writeFlag(repo.localPath, {
    source: "post-dispatch-check",
    dispatchId: job.id,
    cardId,
    cardUrl: `https://trello.com/c/${cardId}`,
    reason: `Tracked card "${card.name}" did not move out of ToDo after dispatch`,
    detail:
      `Card ${cardId} (${card.name}) stayed in the ToDo list across dispatch ${job.id} ` +
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

  try {
    const inProgressCards = await fetchInProgressCards(repo.trello);
    const stuckCards = inProgressCards.filter((card) =>
      state.priorTodoCardIds.includes(card.id),
    );

    for (const card of stuckCards) {
      log.warn(`[${repo.name}] Recovering stuck card "${card.name}" → Needs Help`);
      await moveCardToList(repo.trello, card.id, repo.trello.needsHelpListId, "top");

      const elapsed = formatElapsed(job);
      const comment = `## Agent Failure — Card Recovery

The agent working on this card ${job.status} after ${elapsed}.

**Error:** ${job.summary || "No details available"}

This card was automatically moved to Needs Help. Review the error and move back to ToDo to retry.

${DANXBOT_COMMENT_MARKER}`;

      await addComment(repo.trello, card.id, comment);
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

async function checkAndSpawnIdeator(repo: RepoContext): Promise<void> {
  let reviewCards;
  try {
    reviewCards = await fetchReviewCards(repo.trello);
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
}

// Auto-start when run as the direct entrypoint.
const isDirectEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/poller/index.ts");

if (isDirectEntrypoint) {
  start();
}
