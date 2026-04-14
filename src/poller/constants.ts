import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { optional } from "../env.js";
import { parseSimpleYaml } from "./parse-yaml.js";
import type { TrelloConfig } from "../types.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Resolve the base repos directory. Uses the project-relative `repos/` directory,
 * which works in both host mode (symlinks resolve natively) and Docker mode
 * (the directory is volume-mounted, and per-repo compose overrides mount symlink targets).
 *
 * Does NOT check existence — callers that need filesystem access should validate
 * the path themselves. This allows dashboard mode to parse REPOS env var without
 * requiring a repos/ directory on disk.
 */
export function getReposBase(): string {
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
  };
}

export const REVIEW_MIN_CARDS = parseInt(
  optional("TRELLO_REVIEW_MIN_CARDS", "10"),
  10,
);

/** Marker appended to all Danxbot-posted Trello comments. The poller uses this to distinguish bot comments from user responses. */
export const DANXBOT_COMMENT_MARKER = "<!-- danxbot -->";
