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
    // `lists.needs_approval` is OPTIONAL during the rollout of the new
    // `Needs Approval` status — existing repos predate the line and would
    // otherwise fail to load. Default to empty; trello.ts throws at the
    // statusToListId call site when an agent actually tries to route a
    // card to Needs Approval without a provisioned list, which is the
    // correct fail-loud surface.
    needsApprovalListId: yaml["lists.needs_approval"] ?? "",
    doneListId: req("lists.done"),
    cancelledListId: req("lists.cancelled"),
    actionItemsListId: req("lists.action_items"),
    bugLabelId: req("labels.bug"),
    featureLabelId: req("labels.feature"),
    epicLabelId: req("labels.epic"),
    needsHelpLabelId: req("labels.needs_help"),
    // `labels.needs_approval` mirrors `lists.needs_approval` — optional
    // during rollout; setLabels skips applying when empty.
    needsApprovalLabelId: yaml["labels.needs_approval"] ?? "",
    blockedLabelId: req("labels.blocked"),
    ...(triaged ? { triagedLabelId: triaged } : {}),
  };
}

export const REVIEW_MIN_CARDS = parseInt(
  optional("TRELLO_REVIEW_MIN_CARDS", "10"),
  10,
);

/** Claude CLI prompts for the poller's agent modes. */
export const TEAM_PROMPT = "/danx-next";
export const IDEATOR_PROMPT = "/danx-ideate";

/**
 * Auto-triage prompt — invoked by the poller (Phase 5 / ISS-79) when
 * the ToDo queue is empty and `overrides.autoTriage.enabled` is true.
 *
 * Drives the `danx-triage` skill in `auto` mode (see
 * `src/poller/inject/workspaces/issue-worker/.claude/skills/danx-triage/SKILL.md`,
 * scope row "/danx-triage auto"). Scope: Action Items list (priority 1)
 * + Review list (priority 2). Every card in scope gets a decision —
 * the skill never skips. Decisions map to one of five YAML statuses:
 * `ToDo`, `Done`, `Cancelled`, `Needs Help`, or `Needs Approval`.
 *
 * Defining the prompt as a constant here keeps the spawn site in
 * `src/poller/index.ts` (Phase 5) small and gives tests one place to
 * assert the auto-mode markers.
 */
export const TRIAGE_AUTO_PROMPT = [
  "/danx-triage auto",
  "",
  "Scope: Action Items list (priority 1) + Review list (priority 2).",
  "Every card gets ONE decision — never skip.",
  "Outcomes map to YAML status: ToDo, Done, Cancelled, Needs Help, or Needs Approval.",
  "Use `Needs Approval` when uncertain about direction (architectural risk, cross-cutting scope, disruptive refactor).",
  "Use `Needs Help` ONLY when missing information from a human (creds, ambiguous spec, write-only access).",
].join("\n");

