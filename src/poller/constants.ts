import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Resolve the base repos directory. Inside the Docker container this is
 * `/danxbot/repos/`; on the host it is `repos/` relative to the project root.
 */
export function getReposBase(): string {
  if (existsSync("/danxbot/repos")) return "/danxbot/repos";
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return resolve(projectRoot, "repos");
}

/**
 * Load Trello IDs from .danxbot/config/trello.yml in the connected repo.
 * Falls back to a simple flat YAML parser (key: value per line, with one level of nesting).
 */
function loadTrelloYaml(): Record<string, string> {
  const repos = process.env.REPOS;
  if (!repos) throw new Error("Missing required environment variable: REPOS");
  const name = repos.split(",")[0].split(":")[0].trim();
  if (!name) throw new Error("Invalid REPOS format — expected 'name:url'");

  const trelloYmlPath = resolve(getReposBase(), name, ".danxbot/config/trello.yml");
  const content = readFileSync(trelloYmlPath, "utf-8");

  const result: Record<string, string> = {};
  let currentSection = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^(\w[\w_]*):\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const kvMatch = line.match(/^(\s*)(\w[\w_]*):\s*"?([^"]*)"?\s*$/);
    if (kvMatch) {
      const [, indent, key, value] = kvMatch;
      const prefix = indent && indent.length > 0 ? `${currentSection}.` : "";
      if (!indent || indent.length === 0) currentSection = "";
      result[`${prefix}${key}`] = value.trim();
    }
  }

  return result;
}

function requiredTrello(config: Record<string, string>, key: string): string {
  const value = config[key];
  if (!value) throw new Error(`Missing required Trello config key '${key}' in .danxbot/config/trello.yml`);
  return value;
}

const trello = loadTrelloYaml();

export const BOARD_ID = requiredTrello(trello, "board_id");
export const REVIEW_LIST_ID = requiredTrello(trello, "lists.review");
export const TODO_LIST_ID = requiredTrello(trello, "lists.todo");
export const IN_PROGRESS_LIST_ID = requiredTrello(trello, "lists.in_progress");
export const NEEDS_HELP_LIST_ID = requiredTrello(trello, "lists.needs_help");
export const DONE_LIST_ID = requiredTrello(trello, "lists.done");
export const CANCELLED_LIST_ID = requiredTrello(trello, "lists.cancelled");
export const ACTION_ITEMS_LIST_ID = requiredTrello(trello, "lists.action_items");

export const BUG_LABEL_ID = requiredTrello(trello, "labels.bug");
export const FEATURE_LABEL_ID = requiredTrello(trello, "labels.feature");
export const EPIC_LABEL_ID = requiredTrello(trello, "labels.epic");
export const NEEDS_HELP_LABEL_ID = requiredTrello(trello, "labels.needs_help");

export const REVIEW_MIN_CARDS = parseInt(process.env.TRELLO_REVIEW_MIN_CARDS || "10", 10);

/** Marker appended to all Danxbot-posted Trello comments. The poller uses this to distinguish bot comments from user responses. */
export const DANXBOT_COMMENT_MARKER = "<!-- danxbot -->";
