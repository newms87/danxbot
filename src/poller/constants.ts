import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { optional } from "../env.js";
import { parseSimpleYaml } from "./parse-yaml.js";
import type { TrelloConfig } from "../types.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Resolve the base repos directory.
 *
 * Checks DANXBOT_REPOS_BASE first — worker containers set this to the bind-mount
 * path (e.g. `/danxbot/repos`) so the agent spawn cwd and SessionLogWatcher both
 * derive the correct encoded directory name, avoiding the symlink-resolution bug
 * where a dev-machine image bakes in `repos/<name> → /home/dev/web/<name>` and
 * causes JSONL to land under the host path rather than the container path.
 *
 * Falls back to the project-relative `repos/` directory when the env var is
 * absent, which works for host mode (symlinks resolve natively) and the
 * dashboard container (volume-mounted at the default path).
 *
 * Does NOT check existence — callers that need filesystem access should validate
 * the path themselves. This allows dashboard mode to parse REPOS env var without
 * requiring a repos/ directory on disk.
 */
export function getReposBase(): string {
  const override = optional("DANXBOT_REPOS_BASE", "").trim();
  if (override) return override;
  return resolve(projectRoot, "repos");
}

/**
 * Load Trello board/list/label IDs from a repo's .danxbot/config/trello.yml.
 * Returns all IDs needed for Trello operations on that repo's board.
 * API credentials (apiKey, apiToken) are set to empty strings — the caller
 * fills them from the repo's .danxbot/.env.
 */
export function loadTrelloIds(repoPath: string): Omit<TrelloConfig, "apiKey" | "apiToken"> {
  const trelloYmlPath = resolve(repoPath, ".danxbot/config/trello.yml");
  if (!existsSync(trelloYmlPath)) {
    throw new Error(
      `Trello config not found at ${trelloYmlPath}. Run ./install.sh to set up the repo.`,
    );
  }
  const content = readFileSync(trelloYmlPath, "utf-8");
  const yaml = parseSimpleYaml(content);

  function req(key: string): string {
    const value = yaml[key];
    if (!value) {
      throw new Error(
        `Missing required Trello config key '${key}' in ${trelloYmlPath}`,
      );
    }
    return value;
  }

  const triaged = yaml["labels.triaged"];

  return {
    boardId: req("board_id"),
    reviewListId: req("lists.review"),
    todoListId: req("lists.todo"),
    inProgressListId: req("lists.in_progress"),
    needsHelpListId: req("lists.needs_help"),
    doneListId: req("lists.done"),
    cancelledListId: req("lists.cancelled"),
    actionItemsListId: req("lists.action_items"),
    bugLabelId: req("labels.bug"),
    featureLabelId: req("labels.feature"),
    epicLabelId: req("labels.epic"),
    needsHelpLabelId: req("labels.needs_help"),
    ...(triaged ? { triagedLabelId: triaged } : {}),
  };
}

export const REVIEW_MIN_CARDS = parseInt(
  optional("TRELLO_REVIEW_MIN_CARDS", "10"),
  10,
);

/** Marker appended to all Danxbot-posted Trello comments. The poller uses this to distinguish bot comments from user responses. */
export const DANXBOT_COMMENT_MARKER = "<!-- danxbot -->";

/** Claude CLI prompts for the poller's agent modes. */
export const TEAM_PROMPT = "/danx-next";
export const IDEATOR_PROMPT = "/danx-ideate";

/**
 * Hardcoded tool allowlist for every poller-spawned dispatch.
 *
 * Covers the union of the `/danx-next` and `/danx-ideate` skill surfaces:
 *   - Built-ins the orchestrator needs to read, implement, and commit code.
 *   - `mcp__trello__*` so the orchestrator can pick up / move / comment on
 *     cards (the canonical danx-next pickup sequence).
 *   - The resolver auto-injects `mcp__danxbot__danxbot_complete` — don't list
 *     it here (the resolver treats an explicit `mcp__danxbot__*` request as a
 *     registry lookup, not infrastructure).
 *
 * Kept `Agent` + `Task` together because Claude Code currently accepts both
 * as the subagent-dispatch built-in (see `.claude/rules/agent-dispatch.md`
 * sub-agent layout). The resolver treats each entry as opaque and forwards
 * it to `--allowed-tools`.
 *
 * Schema tools (`mcp__schema__*`) are deliberately NOT in the poller surface —
 * the `/danx-next` and `/danx-ideate` skills don't use them. A connected repo
 * that wants schema tools in its poller dispatches needs to opt in explicitly
 * (future work; currently scoped to HTTP dispatch callers like gpt-manager).
 */
export const POLLER_ALLOW_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "Bash",
  "TodoWrite",
  "Agent",
  "Task",
  "mcp__trello__*",
]);
