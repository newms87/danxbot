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
 * ## Sort orders
 *
 * Two distinct sorts are exported:
 *
 *  - **Work-ready** (`listDispatchableYamls`): untriaged cards first
 *    (`triage.expires_at === ""`), then triaged cards by
 *    `triage.ice.total` DESC. Within each tier, FIFO mtime. Untriaged
 *    cards have unknown priority so they get flushed first; among
 *    triaged cards, the highest ICE total wins (Impact × Confidence ×
 *    Ease). Phase 4 of ISS-90 introduced the priority sort to replace
 *    the legacy pure-FIFO order.
 *
 *  - **Triage-due** (`listTriageDueYamls`): never-triaged first
 *    (`triage.expires_at === ""`), then `expires_at` ASC (oldest stale
 *    first). Within each tier, FIFO mtime tiebreak. The poller dispatches
 *    a per-card triage agent for the FIRST entry in this list every tick
 *    that has no work-ready card to dispatch.
 *
 * Action Items list cards now hydrate as `status: "Review"` (the Trello
 * tracker's `listIdToStatus` does that mapping); the legacy
 * `excludeExternalIds` filter at this layer was retired in Phase 4.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildIssueIdRegex,

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

function walkOpenIssues(
  repoLocalPath: string,
  prefix: string,
): WalkEntry[] {
  const dir = resolve(repoLocalPath, ".danxbot", "issues", "open");
  if (!existsSync(dir)) return [];
  const idRegex = buildIssueIdRegex(prefix);
  const out: WalkEntry[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yml")) continue;
    const stem = entry.slice(0, -".yml".length);
    if (!idRegex.test(stem)) continue;
    const path = resolve(dir, entry);
    let issue: Issue;
    try {
      issue = parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: prefix });
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

function fifoCompare(a: WalkEntry, b: WalkEntry): number {
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
  return a.issue.id.localeCompare(b.issue.id);
}

function sortFifo(entries: WalkEntry[]): Issue[] {
  // Oldest mtime first (FIFO across ticks); tiebreak by id ascending so
  // ordering is deterministic when two YAMLs are written in the same ms.
  entries.sort(fifoCompare);
  return entries.map((e) => e.issue);
}

/**
 * Walk `<repo>/.danxbot/issues/open/*.yml` and return every issue
 * eligible for dispatch this tick:
 *   - `status === "ToDo"`
 *   - `waiting_on === null`
 *   - `dispatch === null` (an active dispatch occupies the card)
 *
 * Sort order (Phase 4 of ISS-90):
 *   1. Untriaged cards first — `triage.expires_at === ""` means the
 *      poller has no priority signal, so flush them before triaged
 *      siblings. Newly hydrated cards hit this branch by default.
 *   2. Triaged cards by `triage.ice.total` DESC — highest ICE first.
 *   3. FIFO mtime tiebreak inside each tier so two cards stamped the
 *      same priority resolve deterministically.
 */
export function listDispatchableYamls(
  repoLocalPath: string,
  prefix: string,
): Issue[] {
  const filtered = walkOpenIssues(repoLocalPath, prefix).filter((e) => {
    const i = e.issue;
    if (i.status !== "ToDo") return false;
    if (i.waiting_on !== null) return false;
    if (i.dispatch !== null) return false;
    // Epics are containers — phase children carry the actual work. The
    // poller dispatches phase cards directly; the dispatched agent reads
    // the parent epic for context. Epic status is derived from children
    // (see `deriveParentStatuses`), so the epic transitions through
    // In Progress / Done automatically as phases progress. Dispatching
    // the epic itself produces a false-positive critical-failure flag
    // when a phase succeeds but the epic legitimately stays ToDo.
    if (i.type === "Epic") return false;
    return true;
  });
  filtered.sort(workReadyCompare);
  return filtered.map((e) => e.issue);
}

function workReadyCompare(a: WalkEntry, b: WalkEntry): number {
  const aUntriaged = a.issue.triage.expires_at === "";
  const bUntriaged = b.issue.triage.expires_at === "";
  if (aUntriaged !== bUntriaged) return aUntriaged ? -1 : 1;
  const iceDelta = b.issue.triage.ice.total - a.issue.triage.ice.total;
  if (iceDelta !== 0) return iceDelta;
  return fifoCompare(a, b);
}

/**
 * Walk `<repo>/.danxbot/issues/open/*.yml` and return every In Progress
 * issue. Used by the orphan-resume / stuck-card recovery path. Same
 * FIFO ordering as `listDispatchableYamls` — oldest first so the
 * longest-running orphan is reconciled first.
 */
export function listInProgressYamls(
  repoLocalPath: string,
  prefix: string,
): Issue[] {
  const filtered = walkOpenIssues(repoLocalPath, prefix).filter(
    (e) => e.issue.status === "In Progress",
  );
  return sortFifo(filtered);
}

/**
 * Walk `<repo>/.danxbot/issues/open/*.yml` and return every ToDo issue
 * with a non-null `waiting_on` record. Companion to
 * `listDispatchableYamls` (which filters waiting_on=null out): the call
 * site feeds these to `resolveWaitingOnCards` so a card whose dependencies
 * just became terminal can be cleared and appended to the dispatchable
 * pool on the same tick. "Blocked" here refers to the old data field name
 * (now `waiting_on`) — this function name reflects historical terminology.
 */
export function listBlockedTodoYamls(
  repoLocalPath: string,
  prefix: string,
): Issue[] {
  const filtered = walkOpenIssues(repoLocalPath, prefix).filter(
    (e) => e.issue.status === "ToDo" && e.issue.waiting_on !== null,
  );
  return sortFifo(filtered);
}

/**
 * Walk `<repo>/.danxbot/issues/open/*.yml` and return every issue that
 * the per-card triage agent should be dispatched against this tick.
 *
 * Eligible if all of:
 *   - `dispatch === null` (no in-flight dispatch on the card)
 *   - `triage.expires_at === ""` OR `Date.parse(triage.expires_at) <= now`
 *   - The card matches one of the three triage paths:
 *      a. `waiting_on != null` (regardless of `status`) — Waiting On path
 *      b. `waiting_on == null` AND `status === "Review"` — Review path
 *      c. `waiting_on == null` AND `status === "Blocked"` — Blocked path
 *
 * Sort (Phase 4 of ISS-90):
 *   1. Never-triaged first — `triage.expires_at === ""`. These are
 *      brand-new or post-migration cards; the operator wants priority
 *      info ASAP so flush them before stale-but-priorited entries.
 *   2. Then `expires_at` ASC — oldest stale entry first so the poller
 *      catches up on overdue triage in chronological order.
 *   3. FIFO mtime tiebreak so two cards expiring the same instant
 *      resolve deterministically.
 *
 * `now` is supplied by the caller (typically `Date.now()`) so tests can
 * pin the clock without monkey-patching `Date`.
 */
export function listTriageDueYamls(
  repoLocalPath: string,
  now: number,
  prefix: string,
): Issue[] {
  const filtered = walkOpenIssues(repoLocalPath, prefix).filter((e) => {
    const i = e.issue;
    if (i.dispatch !== null) return false;
    if (!isTriageDue(i, now)) return false;
    return inTriageScope(i);
  });
  filtered.sort(triageDueCompare);
  return filtered.map((e) => e.issue);
}

function inTriageScope(issue: Issue): boolean {
  if (issue.waiting_on !== null) return true;
  if (issue.status === "Review") return true;
  if (issue.status === "Blocked") return true;
  return false;
}

function isTriageDue(issue: Issue, now: number): boolean {
  const expiresAt = issue.triage.expires_at;
  if (expiresAt === "") return true;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return true;
  return expiresMs <= now;
}

function triageDueCompare(a: WalkEntry, b: WalkEntry): number {
  const aNever = a.issue.triage.expires_at === "";
  const bNever = b.issue.triage.expires_at === "";
  if (aNever !== bNever) return aNever ? -1 : 1;
  if (!aNever) {
    const cmp = a.issue.triage.expires_at.localeCompare(
      b.issue.triage.expires_at,
    );
    if (cmp !== 0) return cmp;
  }
  return fifoCompare(a, b);
}
