/**
 * Auto-derive a parent issue's status from the union of its children's
 * statuses (ISS-98). Runs every poller tick after `bulkSyncMissingYamls`,
 * before dispatch decisions, so the same tick that hydrates a freshly
 * created child card propagates its status up the parent chain.
 *
 * Contract:
 *
 *  - The parent's `status` field is **derivation-owned**. Agent edits to
 *    a parent's status are overwritten on the next poller tick. The
 *    skill docs explicitly tell agents to NOT touch epic status; they
 *    edit child statuses, derivation propagates up.
 *  - Cancelled children are excluded from rules 4 + 5 (they don't block
 *    a Done / Review derivation). Rule 6 fires only when EVERY child is
 *    Cancelled — a single non-Cancelled child shifts the answer.
 *  - Parents with `blocked != null` are skipped — the worker normalizes
 *    blocked parents to `status: ToDo` on save, so writing a derived
 *    status would just churn IO every tick.
 *  - Children may live in `open/` or `closed/`. The walker reads both
 *    via `loadLocal`, which short-circuits on the open/ hit and falls
 *    back to closed/ for terminal children (Done / Cancelled).
 *  - When the union of child statuses doesn't satisfy any rule (e.g.
 *    `Review` + `Done` with no `Cancelled`), `deriveStatus` returns
 *    `null` and the caller leaves the parent untouched. Better than
 *    forcing a guess.
 *
 * Pure-local: no tracker imports, no logger import. Outbound mirror to
 * the tracker happens via the existing `syncIssue` path on the parent's
 * next reconcile (worker-side `danx_issue_save`). The poller does not
 * push the derived status itself — accepts brief tracker-side drift in
 * exchange for keeping this module pure-local + cheap.
 *
 * Priority rules (first match wins):
 *
 *  1. Any child `Needs Help` OR `Needs Approval` → parent inherits the
 *     same status. `Needs Help` wins if both are present (signals
 *     blocking-on-info, which is louder than blocking-on-approval).
 *     Both are non-dispatchable, so either lifts the parent into a
 *     non-dispatchable state.
 *  2. Any child `In Progress` → parent `In Progress`.
 *  3. Any child `ToDo` → parent `ToDo`.
 *  4. All non-cancelled children `Review` → parent `Review`.
 *  5. All non-cancelled children `Done` → parent `Done`.
 *  6. All children `Cancelled` (no exclusion) → parent `Cancelled`.
 *
 * Anything that doesn't fit (e.g. mix of `Review` + `Done` with no
 * `Cancelled`) returns `null`.
 */

import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import { loadLocal, writeIssue } from "./yaml-lifecycle.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildIssueIdRegex,
  DEFAULT_ISSUE_PREFIX,
  IssueParseError,
  parseIssue,
} from "../issue-tracker/yaml.js";
import { createLogger } from "../logger.js";

const log = createLogger("epic-status");

export interface ParentStatusChange {
  id: string;
  before: IssueStatus;
  after: IssueStatus;
}

export function deriveStatus(children: Issue[]): IssueStatus | null {
  if (children.length === 0) return null;

  if (children.some((c) => c.status === "Needs Help")) return "Needs Help";
  if (children.some((c) => c.status === "Needs Approval")) {
    return "Needs Approval";
  }
  if (children.some((c) => c.status === "In Progress")) return "In Progress";
  if (children.some((c) => c.status === "ToDo")) return "ToDo";

  // Rules 4 + 5: terminal-or-review derivation excludes Cancelled
  // children (they don't block a Done/Review parent).
  const nonCancelled = children.filter((c) => c.status !== "Cancelled");
  const hasNonCancelled = nonCancelled.length > 0;
  if (hasNonCancelled && nonCancelled.every((c) => c.status === "Review")) {
    return "Review";
  }
  if (hasNonCancelled && nonCancelled.every((c) => c.status === "Done")) {
    return "Done";
  }
  if (!hasNonCancelled) return "Cancelled";

  // Mixed terminal states (e.g. Review + Done) — caller leaves the
  // parent's current status untouched.
  return null;
}

/**
 * Walk every YAML in `<repo>/.danxbot/issues/open/` whose `children[]` is
 * non-empty and re-derive its `status` from the children's union. Writes
 * the parent's YAML only when the derived status differs from the
 * on-disk status. Returns the list of changes (id + before/after) so the
 * caller can log them.
 *
 * Skips:
 *  - Parents with `blocked != null` (the worker forces those to
 *    `status: ToDo` on save; deriving would churn IO).
 *  - Parents whose every listed child is missing locally (defensive —
 *    `deriveStatus` of an empty resolved set returns null).
 *  - Parents whose derived status equals the current status.
 *
 * Closed parents are not walked: the file move open/→closed/ happens at
 * Done / Cancelled, so any closed parent already reached a terminal
 * status and re-derivation is a no-op anyway.
 */
export function recomputeParentStatuses(
  repoLocalPath: string,
  prefix: string = DEFAULT_ISSUE_PREFIX,
): ParentStatusChange[] {
  const dir = resolve(repoLocalPath, ".danxbot", "issues", "open");
  if (!existsSync(dir)) return [];

  const idRegex = buildIssueIdRegex(prefix);
  const changes: ParentStatusChange[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yml")) continue;
    const stem = entry.slice(0, -".yml".length);
    if (!idRegex.test(stem)) continue;

    const path = resolve(dir, entry);
    let parent: Issue;
    try {
      parent = parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: prefix });
    } catch (err) {
      // Malformed YAML — skip (the local-issues walker logs it on the
      // same tick, no need to double-log). Surface unexpected non-parse
      // errors so silent breakage stays loud.
      if (err instanceof IssueParseError) continue;
      log.warn(
        `Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (parent.children.length === 0) continue;
    if (parent.blocked !== null) continue;

    // Resolve children. Missing children are silently skipped — the
    // alternative (treat missing as "blocks derivation") would lock a
    // parent's status forever after a child is renamed/deleted. A
    // malformed child YAML is also skipped (with the same defensive
    // pattern as the parent walk above) so a single corrupt sibling
    // doesn't abort derivation for every parent on the tick.
    const resolved: Issue[] = [];
    for (const childId of parent.children) {
      try {
        const child = loadLocal(repoLocalPath, childId, prefix);
        if (child) resolved.push(child);
      } catch (err) {
        if (err instanceof IssueParseError) continue;
        log.warn(
          `Failed to load child ${childId} of ${parent.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (resolved.length === 0) continue;

    const derived = deriveStatus(resolved);
    if (derived === null) continue;
    if (derived === parent.status) continue;

    const before = parent.status;
    const updated: Issue = { ...parent, status: derived };
    // Use writeIssue which always writes to open/. Derived statuses of
    // Done / Cancelled WILL leave the parent in open/ until the next
    // agent save triggers worker's open/→closed/ move; that's fine —
    // the file is still authoritative and the next save reconciles.
    writeIssue(repoLocalPath, updated);
    changes.push({ id: parent.id, before, after: derived });
  }

  return changes;
}
