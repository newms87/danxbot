/**
 * Orphan-push: scan `<repo>/.danxbot/issues/open/*.yml`, find issues whose
 * `external_id` is empty (i.e. local-only YAMLs that never went through
 * `danx_issue_create`), and push them to the active tracker.
 *
 * Why this exists: planning agents that hand-write phase YAMLs (or the
 * `danx-epic-link` flow that splits an epic into phase children) often
 * skip the MCP `danx_issue_create` round-trip. Without this scan those
 * YAMLs never appear in Trello — the poller is otherwise remote-first
 * (it pulls from the tracker and hydrates locally; it never iterates
 * local YAMLs to push). One scan per tick closes the gap with no agent
 * change required.
 *
 * Ordering invariant: parents before children. `parent_id` references
 * an INTERNAL `ISS-N` id, not an `external_id`, so the on-disk YAML
 * doesn't need rewiring after the parent push — but tracker
 * implementations that prefix titles with `#<id>: ` rely on the parent
 * card existing first to render the parent chip on the child. Sorting
 * by topology keeps tracker UIs consistent on first paint.
 *
 * Failure semantics: a per-card `parseIssue` or `createCard` rejection
 * is recorded as an `OrphanPushError` and execution continues with the
 * next orphan. Cycles in `parent_id` and array-length mismatches from
 * `createCard` are loud (throw) — both indicate corrupt input that the
 * caller should not silently paper over.
 *
 * Idempotency: re-runs on the next tick skip already-pushed YAMLs
 * (non-empty `external_id`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ISSUE_ID_REGEX,
  issueToCreateInput,
  parseIssue,
} from "../issue-tracker/yaml.js";
import { writeIssue } from "./yaml-lifecycle.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";

export interface OrphanPushError {
  id: string;
  message: string;
}

export interface OrphanPushResult {
  pushed: number;
  errors: OrphanPushError[];
}

/**
 * Topologically sort orphans so parents land in the tracker before
 * children. A cycle in `parent_id` is corrupt input — throws rather
 * than silently flushing nodes in arbitrary order.
 */
function sortParentsFirst(orphans: Issue[]): Issue[] {
  const orphanIds = new Set(orphans.map((o) => o.id));
  const remaining = new Map(orphans.map((o) => [o.id, o]));
  const ordered: Issue[] = [];
  const emitted = new Set<string>();

  while (remaining.size > 0) {
    let progressed = false;
    for (const [id, issue] of remaining) {
      const parent = issue.parent_id;
      const parentSatisfied =
        parent === null || !orphanIds.has(parent) || emitted.has(parent);
      if (parentSatisfied) {
        ordered.push(issue);
        emitted.add(id);
        remaining.delete(id);
        progressed = true;
      }
    }
    if (!progressed) {
      const cycleIds = Array.from(remaining.keys()).sort().join(", ");
      throw new Error(
        `pushOrphans: cycle detected in parent_id graph among orphans [${cycleIds}]`,
      );
    }
  }
  return ordered;
}

/**
 * Scan `open/` for orphan YAMLs (empty `external_id`) and push each to
 * the tracker via `createCard`. The returned `external_id` and check-
 * item ids are stamped back into the YAML via `writeIssue`.
 *
 * `closed/` is intentionally skipped — terminal-status YAMLs represent
 * work that was completed locally without a tracker push, and
 * resurrecting them as fresh cards on the tracker would surface stale
 * "Done" cards in the Done column with zero history.
 */
export async function pushOrphans(
  repoLocalPath: string,
  tracker: IssueTracker,
): Promise<OrphanPushResult> {
  const openDir = resolve(repoLocalPath, ".danxbot", "issues", "open");
  if (!existsSync(openDir)) {
    return { pushed: 0, errors: [] };
  }

  const orphans: Issue[] = [];
  const errors: OrphanPushError[] = [];

  for (const entry of readdirSync(openDir)) {
    if (!entry.endsWith(".yml")) continue;
    const stem = entry.slice(0, -".yml".length);
    if (!ISSUE_ID_REGEX.test(stem)) continue;
    const path = resolve(openDir, entry);
    let issue: Issue;
    try {
      issue = parseIssue(readFileSync(path, "utf-8"));
    } catch (err) {
      // One malformed YAML in `open/` must not block the rest of the
      // scan — the poller keeps running while the operator fixes it.
      errors.push({
        id: stem,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (issue.external_id === "") {
      orphans.push(issue);
    }
  }

  if (orphans.length === 0) {
    return { pushed: 0, errors };
  }

  const ordered = sortParentsFirst(orphans);
  let pushed = 0;

  for (const issue of ordered) {
    try {
      const result = await tracker.createCard(issueToCreateInput(issue));
      if (result.ac.length !== issue.ac.length) {
        throw new Error(
          `tracker.createCard returned ${result.ac.length} ac items, expected ${issue.ac.length}`,
        );
      }
      if (result.phases.length !== issue.phases.length) {
        throw new Error(
          `tracker.createCard returned ${result.phases.length} phases, expected ${issue.phases.length}`,
        );
      }
      const stamped: Issue = {
        ...issue,
        external_id: result.external_id,
        ac: issue.ac.map((a, i) => ({
          ...a,
          check_item_id: result.ac[i].check_item_id,
        })),
        phases: issue.phases.map((p, i) => ({
          ...p,
          check_item_id: result.phases[i].check_item_id,
        })),
      };
      writeIssue(repoLocalPath, stamped);
      pushed++;
    } catch (err) {
      errors.push({
        id: issue.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pushed, errors };
}
