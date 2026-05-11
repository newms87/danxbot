/**
 * DB-backed dispatch readers used by the poller's per-tick decisions.
 *
 * Source-of-truth contract: `<repo>/.danxbot/issues/open/*.yml` is the
 * single authority for "what cards exist and what state are they in".
 * The chokidar mirror in `src/db/issues-mirror.ts` watches every YAML
 * change and projects it into the `issues` table; these readers query
 * that projection. Phase 4 of the Issues DB Mirror epic (DX-151 /
 * DX-155) replaced the previous YAML-walk implementation here. The
 * filesystem is still authoritative — boot scan + 10-min reconcile
 * keep the DB consistent with disk; if the DB diverges, the next
 * reconcile fixes it.
 *
 * The signatures take `repoLocalPath` as the first argument for caller
 * compatibility; internally the repo name (the `repo_name` column on
 * `issues`) is resolved via `repoNameFromPath` (registered at worker
 * boot). The `prefix` parameter is unused under SQL — the per-repo id
 * shape is stable so the prefix filter the YAML walker did via regex is
 * implicit in the `repo_name` filter.
 *
 * ## Sort orders
 *
 * Two distinct sorts are exported:
 *
 *  - **Work-ready** (`listDispatchableYamls`): canonical
 *    `sortInputsForStatus("ToDo", ...)` order — tier (waiting/blocked
 *    last) → ICE total DESC (untriaged = +Inf) → priority DESC →
 *    `updatedAt` ASC (FIFO). The poller filters waiting/blocked rows
 *    out before sorting, so the tier predicate is a no-op there.
 *
 *  - **Triage-due** (`listTriageDueYamls`): never-triaged first
 *    (`triage.expires_at === ""`), then `expires_at` ASC (oldest stale
 *    first). FIFO `mirror_updated_at` tiebreak.
 *
 * `mirrorUpdatedAtMs` replaces file mtime as the FIFO signal. The
 * mirror stamps it on every content-changing upsert, so it is a logical
 * mtime under the SQL projection.
 */

import {
  dbListOpenIssues,
  type DbIssueRow,
} from "./issues-db.js";
import type { Issue } from "../issue-tracker/interface.js";
import {
  ancestorWaitingOrBlocked,
  sortInputsForStatus,
} from "../issue-tracker/sort.js";
import { repoNameFromPath } from "./repo-name.js";

function fifoCompare(a: DbIssueRow, b: DbIssueRow): number {
  if (a.mirrorUpdatedAtMs !== b.mirrorUpdatedAtMs) {
    return a.mirrorUpdatedAtMs - b.mirrorUpdatedAtMs;
  }
  return a.issue.id.localeCompare(b.issue.id);
}

function sortFifo(rows: DbIssueRow[]): Issue[] {
  // Oldest mirror_updated_at first (FIFO across ticks); tiebreak by id
  // ascending so two rows updated in the same instant resolve
  // deterministically.
  rows.sort(fifoCompare);
  return rows.map((r) => r.issue);
}

/**
 * Return every issue eligible for dispatch this tick. Predicates:
 *
 *   - `status === "ToDo"`
 *   - `waiting_on === null`
 *   - `blocked === null`
 *   - `dispatch === null` (an active dispatch occupies the card)
 *   - `type !== "Epic"` (epics are containers; phase children carry the work)
 *   - No ancestor (parent, grandparent, …) has `waiting_on !== null`
 *     OR `blocked !== null`. A blocked / waiting parent transitively
 *     blocks every descendant — the entire subtree is held until the
 *     ancestor's impediment clears. Ancestor walk runs on the fetched
 *     `byId` map; closed (Done / Cancelled) ancestors are excluded
 *     from the map so they cannot block descendants.
 *
 * Sort: `sortInputsForStatus("ToDo", byId)` — see module header.
 */
export async function listDispatchableYamls(
  repoLocalPath: string,
  _prefix: string,
): Promise<Issue[]> {
  const repoName = repoNameFromPath(repoLocalPath);
  const rows = await dbListOpenIssues(repoName);
  const byId = new Map<string, Issue>();
  for (const r of rows) byId.set(r.issue.id, r.issue);
  const filtered = rows.filter((r) => {
    const i = r.issue;
    if (i.status !== "ToDo") return false;
    if (i.waiting_on !== null) return false;
    if (i.blocked !== null) return false;
    // DX-231 (Phase 1): the orthogonal "needs human action" field is a
    // dispatch gate parallel to `blocked` and `waiting_on`. The filter
    // landed in Phase 1 (this phase) — paired with the same-phase
    // `isDispatchSessionTerminal` clause in `src/worker/issue-route.ts`
    // that releases the slot when an agent saves `requires_human != null`.
    // Without both clauses landing together, an agent that flips the field
    // and exits would see the poller re-dispatch the card on the next
    // tick — infinite loop.
    if (i.requires_human !== null) return false;
    if (i.dispatch !== null) return false;
    // Epics are containers — phase children carry the actual work. The
    // poller dispatches phase cards directly; the dispatched agent reads
    // the parent epic for context. Epic status is derived from children
    // (see `deriveParentStatuses`), so the epic transitions through
    // In Progress / Done automatically as phases progress. Dispatching
    // the epic itself produces a false-positive critical-failure flag
    // when a phase succeeds but the epic legitimately stays ToDo.
    if (i.type === "Epic") return false;
    if (ancestorWaitingOrBlocked(i, byId)) return false;
    return true;
  });
  return sortInputsForStatus(
    filtered.map((r) => ({
      issue: r.issue,
      payload: r.issue,
      updatedAtMs: r.mirrorUpdatedAtMs,
    })),
    "ToDo",
    byId,
  );
}

/**
 * Return every In Progress issue. Used by the orphan-resume / stuck-card
 * recovery path. FIFO `mirror_updated_at` ordering — oldest first so the
 * longest-running orphan is reconciled first.
 */
export async function listInProgressYamls(
  repoLocalPath: string,
  _prefix: string,
): Promise<Issue[]> {
  const repoName = repoNameFromPath(repoLocalPath);
  const rows = await dbListOpenIssues(repoName);
  return sortFifo(rows.filter((r) => r.issue.status === "In Progress"));
}

/**
 * Look up the In Progress YAML whose `dispatch.id` matches `dispatchId`.
 * Used by the worker boot reattach pass (DX-209 extension) to decide
 * whether a dead-PID dispatch row is salvageable via `claude --resume`.
 *
 * Returns `null` when no matching In Progress YAML exists — caller falls
 * through to the legacy orphan-mark behavior. The dispatch may have
 * already moved its YAML to `closed/` (status: Done) before the worker
 * died, in which case auto-resume must NOT fire (the work is done; the
 * dispatch row just never got finalized).
 */
export async function findInProgressIssueByDispatchId(
  repoLocalPath: string,
  dispatchId: string,
): Promise<Issue | null> {
  const repoName = repoNameFromPath(repoLocalPath);
  const rows = await dbListOpenIssues(repoName);
  const match = rows.find(
    (r) =>
      r.issue.status === "In Progress" && r.issue.dispatch?.id === dispatchId,
  );
  return match?.issue ?? null;
}

/**
 * Return every ToDo issue with a non-null `waiting_on` record. Companion
 * to `listDispatchableYamls` (which filters waiting_on=null out): the call
 * site feeds these to `resolveWaitingOnCards` so a card whose dependencies
 * just became terminal can be cleared and appended to the dispatchable
 * pool on the same tick. "Blocked" in the function name is historical
 * (the field was renamed to `waiting_on`).
 */
export async function listBlockedTodoYamls(
  repoLocalPath: string,
  _prefix: string,
): Promise<Issue[]> {
  const repoName = repoNameFromPath(repoLocalPath);
  const rows = await dbListOpenIssues(repoName);
  return sortFifo(
    rows.filter(
      (r) => r.issue.status === "ToDo" && r.issue.waiting_on !== null,
    ),
  );
}

/**
 * Return every issue the per-card triage agent should be dispatched
 * against this tick.
 *
 * Eligible if all of:
 *   - `dispatch === null` (no in-flight dispatch on the card)
 *   - `triage.expires_at === ""` OR `Date.parse(triage.expires_at) <= now`
 *   - The card matches one of the three triage paths:
 *      a. `waiting_on != null` (regardless of `status`) — Waiting On path
 *      b. `waiting_on == null` AND `status === "Review"` — Review path
 *      c. `waiting_on == null` AND `status === "Blocked"` — Blocked path
 *
 * Sort:
 *   1. Never-triaged first — `triage.expires_at === ""`. Brand-new
 *      cards or post-migration entries; the operator wants priority
 *      info ASAP so flush them before stale-but-priorited entries.
 *   2. Then `expires_at` ASC — oldest stale first.
 *   3. FIFO `mirror_updated_at` tiebreak.
 *
 * The triage_expires_at column is populated by the mirror writer
 * (see `extractTriageExpiresAt` in `src/db/issues-mirror.ts`). An
 * unparseable string lands as NULL, which falls through to the
 * never-triaged branch — fail-open (re-triage will rewrite the field).
 *
 * `now` is supplied by the caller (typically `Date.now()`) so tests
 * can pin the clock without monkey-patching `Date`.
 */
export async function listTriageDueYamls(
  repoLocalPath: string,
  now: number,
  _prefix: string,
): Promise<Issue[]> {
  const repoName = repoNameFromPath(repoLocalPath);
  const rows = await dbListOpenIssues(repoName);
  const filtered = rows.filter((r) => {
    const i = r.issue;
    if (i.dispatch !== null) return false;
    if (!isTriageDue(i, now)) return false;
    return inTriageScope(i);
  });
  filtered.sort(triageDueCompare);
  return filtered.map((r) => r.issue);
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

function triageDueCompare(a: DbIssueRow, b: DbIssueRow): number {
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
