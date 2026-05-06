/**
 * Local-YAML walkers used by the poller's dispatch path.
 *
 * Source-of-truth contract: `<repo>/.danxbot/issues/open/*.yml` is the
 * single authority for "what cards exist and what state are they in".
 * The tracker (Trello) is a one-way mirror plus a narrow inbound
 * channel for new cards + human comments — it never decides what gets
 * dispatched. This module replaces the legacy
 * `tracker.fetchOpenCards().filter(status === "ToDo" | "In Progress")`
 * dispatch source. See ISS-67 (epic) and ISS-86 (Phase 1 / Slice A).
 *
 * `list_kind` (the Action-Items vs ToDo distinction) is NOT persisted
 * on the YAML schema — it lives only on the tracker `IssueRef`. To
 * filter Action Items out of the dispatchable set, the call site
 * passes their `external_id`s in via `excludeExternalIds`. Local-only
 * orphans (`external_id === ""`) are always dispatchable: by
 * definition they have not yet been mirrored to the tracker, so they
 * cannot be on the Action Items list.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ISSUE_ID_REGEX,
  IssueParseError,
  parseIssue,
} from "../issue-tracker/yaml.js";
import type { Issue } from "../issue-tracker/interface.js";
import { createLogger } from "../logger.js";

const log = createLogger("local-issues");

interface WalkEntry {
  issue: Issue;
  mtimeMs: number;
}

function walkOpenIssues(repoLocalPath: string): WalkEntry[] {
  const dir = resolve(repoLocalPath, ".danxbot", "issues", "open");
  if (!existsSync(dir)) return [];
  const out: WalkEntry[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yml")) continue;
    const stem = entry.slice(0, -".yml".length);
    if (!ISSUE_ID_REGEX.test(stem)) continue;
    const path = resolve(dir, entry);
    let issue: Issue;
    try {
      issue = parseIssue(readFileSync(path, "utf-8"));
    } catch (err) {
      // Malformed YAML on disk is a real fault — skip it but log loudly so
      // the poller doesn't silently drop a card. The next tick re-tries.
      const msg = err instanceof IssueParseError ? err.message : String(err);
      log.error(`[local-issues] Failed to parse ${path}: ${msg}`);
      continue;
    }
    out.push({ issue, mtimeMs: statSync(path).mtimeMs });
  }
  return out;
}

function sortFifo(entries: WalkEntry[]): Issue[] {
  // Oldest mtime first (FIFO across ticks); tiebreak by id ascending so
  // ordering is deterministic when two YAMLs are written in the same ms.
  entries.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.issue.id.localeCompare(b.issue.id);
  });
  return entries.map((e) => e.issue);
}

export interface ListDispatchableOptions {
  /**
   * `external_id`s to exclude from the dispatchable set. Used by the
   * poller to filter out Action Items list cards (`list_kind:
   * "action_items"` on the tracker `IssueRef`) — that flag is not
   * persisted on the YAML, so the call site builds the set from the
   * current tick's `tracker.fetchOpenCards()` view.
   */
  excludeExternalIds?: ReadonlySet<string>;
}

/**
 * Walk `<repo>/.danxbot/issues/open/*.yml` and return every issue
 * eligible for dispatch this tick:
 *   - `status === "ToDo"`
 *   - `blocked === null`
 *   - `external_id` not in `options.excludeExternalIds`
 *
 * Sorted FIFO by file mtime ascending, tiebreak by id ascending.
 */
export function listDispatchableYamls(
  repoLocalPath: string,
  options: ListDispatchableOptions = {},
): Issue[] {
  const exclude = options.excludeExternalIds;
  const filtered = walkOpenIssues(repoLocalPath).filter((e) => {
    const i = e.issue;
    if (i.status !== "ToDo") return false;
    if (i.blocked !== null) return false;
    if (exclude && i.external_id !== "" && exclude.has(i.external_id)) {
      return false;
    }
    return true;
  });
  return sortFifo(filtered);
}

/**
 * Walk `<repo>/.danxbot/issues/open/*.yml` and return every In Progress
 * issue. Used by the orphan-resume / stuck-card recovery path. Same
 * FIFO ordering as `listDispatchableYamls` — oldest first so the
 * longest-running orphan is reconciled first.
 */
export function listInProgressYamls(repoLocalPath: string): Issue[] {
  const filtered = walkOpenIssues(repoLocalPath).filter(
    (e) => e.issue.status === "In Progress",
  );
  return sortFifo(filtered);
}

/**
 * Walk `<repo>/.danxbot/issues/open/*.yml` and return every ToDo issue
 * with a non-null `blocked` record. Companion to
 * `listDispatchableYamls` (which filters blocked=null out): the call
 * site feeds these to `resolveBlockedCards` so a card whose blockers
 * just became terminal can be cleared and appended to the dispatchable
 * pool on the same tick.
 */
export function listBlockedTodoYamls(repoLocalPath: string): Issue[] {
  const filtered = walkOpenIssues(repoLocalPath).filter(
    (e) => e.issue.status === "ToDo" && e.issue.blocked !== null,
  );
  return sortFifo(filtered);
}
