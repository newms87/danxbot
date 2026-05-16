/**
 * Single publish path for `issue:updated` SSE events.
 *
 * Every producer (chokidar watcher, PATCH endpoint, paste-import) routes
 * through one of two functions here so there is exactly one place that
 * (a) builds the projected `IssueListItem` wire shape via `projectIssue`,
 * and (b) computes which OTHER open cards' projections depend on the
 * changed card and re-emits for each. Direct `eventBus.publish({topic:
 * "issue:updated", ...})` is FORBIDDEN — the wire is item-shaped only.
 *
 * Fan-out criteria for a changed card X (the set of OTHER open cards Y
 * whose projection may need refresh because X changed):
 *
 *   - `Y.waiting_on.by` includes `X.id` → Y's effective `waiting_on` /
 *     `waiting_on_by` may have unblocked or shrunk now that X is in
 *     a (possibly) terminal status.
 *   - `Y.conflict_on[].id == X.id` → Y's `conflict_on_active_count`
 *     forward leg depends on X.status; recompute.
 *   - `Y.children` includes `X.id` → Y is X's parent; Y's
 *     `children_detail[<X>]` needs refresh.
 *   - Y is an ANCESTOR of X (recursive parent_id walk) → Y's
 *     `child_assignments` rollup may include / exclude X.
 *   - `X.conflict_on[].id == Y.id` → Y is a forward-partner of X; Y's
 *     `conflict_on_active_count` reverse leg flips when X transitions
 *     to / from In Progress.
 *
 * Bounded N (small in practice: 0–5 per write). Cost = one
 * `dbListAllIssues` per call + N projections + N SSE publishes.
 */

import { dbListAllIssues } from "../poller/issues-db.js";
import type { Issue } from "../issue-tracker/interface.js";
import { eventBus } from "./event-bus.js";
import type { BusEvent } from "./event-bus.js";
import {
  isClosed,
  toRawIssue,
  type RawIssue,
} from "./issues-reader.js";
import { projectIssue } from "./project-issue.js";

export interface EventPublisherLike {
  publish(event: BusEvent): void;
}

interface RepoSnapshot {
  byId: Map<string, Issue>;
  mtime: Map<string, number>;
  openIssues: Issue[];
}

async function loadRepoSnapshot(repoName: string): Promise<RepoSnapshot> {
  const rows = await dbListAllIssues(repoName);
  const byId = new Map<string, Issue>();
  const mtime = new Map<string, number>();
  const openIssues: Issue[] = [];
  for (const row of rows) {
    let raw: RawIssue;
    try {
      raw = toRawIssue(row);
    } catch {
      // _malformed / rogue id — same defense as listIssues; skip.
      continue;
    }
    byId.set(raw.issue.id, raw.issue);
    mtime.set(raw.issue.id, raw.mtimeMs);
    if (!isClosed(raw.issue.status)) openIssues.push(raw.issue);
  }
  return { byId, mtime, openIssues };
}

function computeFanout(changedId: string, snap: RepoSnapshot): Set<string> {
  const out = new Set<string>([changedId]);
  const changed = snap.byId.get(changedId);
  // Walk forward-conflict partners + ancestor chain when we still know
  // the changed card's shape (i.e. row exists in DB at lookup time).
  if (changed) {
    for (const entry of changed.conflict_on) out.add(entry.id);
    let cursor = changed.parent_id;
    const guard = new Set<string>([changedId]);
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      out.add(cursor);
      cursor = snap.byId.get(cursor)?.parent_id ?? null;
    }
  }
  // Scan open set for back-references. Cheap — N is the open count.
  for (const other of snap.openIssues) {
    if (other.id === changedId) continue;
    if (other.waiting_on && other.waiting_on.by.includes(changedId)) {
      out.add(other.id);
    }
    if (other.conflict_on.some((e) => e.id === changedId)) {
      out.add(other.id);
    }
    if (other.children.includes(changedId)) {
      out.add(other.id);
    }
  }
  return out;
}

/**
 * Publish a projected upsert for `changedIssue` + every other open
 * card whose projection depends on it.
 *
 * `changedIssue` is the authoritative post-write state — caller MUST
 * pass the parsed/patched `Issue` directly so the publish does not race
 * the DB mirror's chokidar write. Fan-out cards are sourced from the DB
 * (small staleness window acceptable — the mirror's next event will
 * reproject them too).
 *
 * `changedMtimeMs` is the on-disk mtime; controls the `updated_at` /
 * `created_at` derivations on the projected item.
 */
export async function publishIssueUpsert(
  repoName: string,
  changedIssue: Issue,
  changedMtimeMs: number,
  bus: EventPublisherLike = eventBus,
): Promise<import("./issues-reader.js").IssueListItem> {
  const snap = await loadRepoSnapshot(repoName);
  // Authoritative override: caller's `changedIssue` wins over the DB
  // snapshot for the changed id (mirror lag protection).
  snap.byId.set(changedIssue.id, changedIssue);
  snap.mtime.set(changedIssue.id, changedMtimeMs);
  // Recompute openIssues so the changed card's open-ness reflects the
  // override. Drop any prior copy + reinsert when non-terminal.
  const open = snap.openIssues.filter((i) => i.id !== changedIssue.id);
  if (!isClosed(changedIssue.status)) open.push(changedIssue);
  snap.openIssues = open;

  const ids = computeFanout(changedIssue.id, snap);
  let changedItem: import("./issues-reader.js").IssueListItem | undefined;
  for (const id of ids) {
    const issue = snap.byId.get(id);
    if (!issue) continue;
    const mtime = snap.mtime.get(id) ?? changedMtimeMs;
    const item = projectIssue(issue, mtime, snap.byId, snap.openIssues);
    bus.publish({
      topic: "issue:updated",
      data: { repoName, id, item },
    });
    if (id === changedIssue.id) changedItem = item;
  }
  if (!changedItem) {
    // Defense in depth: computeFanout always includes the changed id, so
    // a missing item would mean the override snap was somehow stripped.
    // Fall back to a direct project so the caller still receives the
    // canonical wire shape.
    changedItem = projectIssue(
      changedIssue,
      changedMtimeMs,
      snap.byId,
      snap.openIssues,
    );
  }
  return changedItem;
}

/**
 * Publish a removed event for `id` + reproject every other open card
 * whose projection depended on it. The caller has just observed the
 * YAML disappear (chokidar unlink with no sibling, hard delete).
 *
 * Fan-out lookups use the DB snapshot as-is — if the mirror has already
 * removed the row, ancestor / conflict references on the now-gone card
 * are lost; the reverse-direction scan against the open set still
 * surfaces every Y that referenced X.
 */
export async function publishIssueRemoved(
  repoName: string,
  id: string,
  bus: EventPublisherLike = eventBus,
): Promise<void> {
  const snap = await loadRepoSnapshot(repoName);
  // Emit removed for X FIRST so reducers drop the row before consuming
  // the reprojected referrers.
  bus.publish({
    topic: "issue:updated",
    data: { repoName, id, removed: true },
  });
  const ids = computeFanout(id, snap);
  ids.delete(id);
  for (const otherId of ids) {
    const issue = snap.byId.get(otherId);
    if (!issue) continue;
    const mtime = snap.mtime.get(otherId) ?? 0;
    const item = projectIssue(issue, mtime, snap.byId, snap.openIssues);
    bus.publish({
      topic: "issue:updated",
      data: { repoName, id: otherId, item },
    });
  }
}
