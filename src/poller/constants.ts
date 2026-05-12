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
    blockedLabelId: req("labels.blocked"),
    // `labels.requires_human` is OPTIONAL during rollout of the new
    // orthogonal indicator (DX-231 Phase 3) — existing repos predate the
    // line and would otherwise fail to load. Empty string = label not
    // provisioned yet; `trello.ts#setLabels` / `projectLabels` /
    // `allManagedLabelIdsForFiltering` short-circuit on the empty value
    // so no churn is generated. The setup skill provisions the label on
    // fresh boards; existing operators paste the id in once they create
    // the matching Trello label by hand.
    requiresHumanLabelId: yaml["labels.requires_human"] ?? "",
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
 * Slash-command prefix for orphan-resume dispatches (ISS-135).
 *
 * Identical to `TEAM_PROMPT` today (both load the `danx-next` skill,
 * which now ships a "Resume self-check" section that detects
 * already-terminal cards before doing any work). Carved out as its own
 * constant so the orphan-resume callsite is grep-distinct from the
 * fresh-dispatch callsite — and so a future swap to a dedicated
 * `/danx-resume` slash command is a one-line edit here. The May-7
 * incident (resumed agent re-running `/danx-next` against a Done card)
 * is the load-bearing reason: the resume path now prepends an explicit
 * "verify, don't repeat" CONTRACT block, while the fresh-dispatch path
 * keeps its current "Edit <yaml>" body.
 */
export const TEAM_PROMPT_RESUME = "/danx-next";

/**
 * Per-card triage prompt — invoked by the poller's triage-due path
 * (Phase 4 of ISS-90) when an open card with `status` ∈
 * {Review, Blocked} OR `blocked != null` has `triage.expires_at` in
 * the past (or empty). One dispatch per tick, one card per dispatch.
 *
 * Drives the `danx-triage-card` skill (Phase 3 / ISS-93). The single
 * Claude session reads the named card via `mcp__danx-issue__danx_issue_get`,
 * decides per the per-status decision tree, writes the TTL-stamped
 * `triage{}` block back via `Edit` (the chokidar watcher in
 * `src/db/issues-mirror.ts` mirrors the change to the DB; the poller's
 * per-tick mirror pushes to the tracker), and signals completion.
 * Decisions:
 *   - Review → ICE-score → Keep / Cancel / Approve (status flips)
 *   - Needs Help → Hard Gate audit → Demote / Confirm
 *   - Blocked (`blocked != null`) → Re-check `blocked.by[]` → Unblock
 *     (clear `blocked`) / Confirm (refresh expires_at).
 *
 * The dispatch task is a single command line with the card's id; the
 * skill description carries the full per-status contract.
 */
export const TRIAGE_CARD_PROMPT = (issueId: string): string =>
  `/danx-triage-card ${issueId}`;

