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
 *    last) → priority DESC → id numeric ASC (FIFO by creation). DX-627
 *    (priority canon, Phase 1) collapsed the priority bucket to
 *    `priority DESC → id ASC`; the prior position / epic phase-order /
 *    ICE-total tiebreaks were stripped. The poller filters
 *    waiting/blocked rows out before sorting, so the tier predicate is
 *    a no-op there.
 *
 *  - **Triage-due** (`listTriageDueYamls`): never-triaged first
 *    (`triage.expires_at === ""`), then `expires_at` ASC (oldest stale
 *    first). FIFO `mirror_updated_at` tiebreak.
 *
 * `mirrorUpdatedAtMs` is retained on the row shape for the triage-due
 * sort's FIFO tiebreak; the priority-bucket sort no longer reads it
 * (DX-627 — id-numeric ASC is the FIFO signal).
 */

import {
  dbListOpenIssues,
  dbSelectIssuesByIds,
  type DbIssueRow,
} from "./issues-db.js";
import type { Issue } from "../issue-tracker/interface.js";
import {
  ancestorWaitingOrBlocked,
  sortInputsForStatus,
} from "../issue-tracker/sort.js";
import { isEffectivelyWaitingOn } from "../issue/effective-waiting-on.js";
import { isEffectivelyConflicted } from "../issue/effective-conflict-on.js";
import { deriveStatus } from "../issue/derive-status.js";
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
 *   - `deriveStatus(i) === "ToDo"` (DX-584 — Phase 4 of computed card
 *     state). Reads the derived semantic state instead of the raw
 *     `status` field so a card whose timestamps drift ahead of `status`
 *     (or vice versa) is interpreted via the single 7-rule precedence
 *     in `deriveStatus`. The picker no longer trusts the raw `status`
 *     write directly.
 *   - Explicit Backlog gate: `archived_at != null && ready_at == null`
 *     → skip. Backlog cards (parked / shelved without a readied flag)
 *     are not dispatch-eligible even if some other code path nudges
 *     `status` to ToDo by mistake. Belt-and-suspenders against the
 *     deriveStatus rule 6 (`archived_at → Backlog`) — explicit guard
 *     so a future tweak to the precedence does not silently allow
 *     Backlog dispatch.
 *   - **Effective** `waiting_on` is null — `effectiveWaitingOn(i, byId)`
 *     returns null iff every id in `i.waiting_on.by[]` resolves to a
 *     terminal status (`Done` / `Cancelled`). The raw YAML may still
 *     carry a non-null `waiting_on` record (durable audit trail); the
 *     dispatch gate looks at effective state only. Any unresolvable
 *     dep keeps the card waiting.
 *   - `blocked === null`
 *   - `dispatch === null` (an active dispatch occupies the card)
 *   - `type !== "Epic"` (epics are containers; phase children carry the work)
 *   - No ancestor (parent, grandparent, …) is effectively waiting OR
 *     `blocked !== null`. A blocked / effectively-waiting parent
 *     transitively blocks every descendant — the entire subtree is
 *     held until the ancestor's impediment clears. Ancestor walk runs
 *     on the same `byId` map.
 *
 * `byId` is built from `dbListOpenIssues` (open rows only) and then
 * enriched with any closed deps referenced by an open card's
 * `waiting_on.by[]`. Without the enrichment, a card waiting on a closed
 * (Done) dep would see the dep as "missing from map" and stay
 * effectively waiting forever — wrong: closed deps SHOULD eligibilise
 * the card.
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
  const missingDepIds = new Set<string>();
  for (const r of rows) {
    const w = r.issue.waiting_on;
    if (w === null) continue;
    for (const depId of w.by) {
      if (!byId.has(depId)) missingDepIds.add(depId);
    }
  }
  if (missingDepIds.size > 0) {
    const closedDeps = await dbSelectIssuesByIds(repoName, [...missingDepIds]);
    for (const d of closedDeps) byId.set(d.id, d);
  }
  // conflict_on gate (v7) — two-way dispatch mutex. A card is gated
  // by the conflict_on gate iff it (a) lists an In Progress partner
  // in its own conflict_on[], OR (b) some other open card lists THIS
  // card in its conflict_on[] AND the other card is In Progress. The
  // `allOpen` set the helper walks is the same `rows.map(r => issue)`
  // set this filter is iterating — pre-extracted to a flat array
  // since the helper iterates the full set per-call (O(n) per card —
  // worst-case O(n²) total per tick; n is open-issues-per-repo,
  // expected <500). Terminal partners ignored by the helper; missing
  // partners ignored too (durable audit record on disk but no live
  // dispatch gate).
  const allOpen = rows.map((r) => r.issue);
  const filtered = rows.filter((r) => {
    const i = r.issue;
    // DX-584 (Phase 4) — derived semantic state, not raw `status`. The
    // 7-rule precedence in deriveStatus folds Cancelled/Done/Blocked/
    // ToDo/Backlog around the raw field; a card with the right
    // timestamps reads as the right semantic regardless of any stale
    // raw `status` value still on disk.
    if (deriveStatus(i) !== "ToDo") return false;
    // Explicit Backlog gate: a card with `archived_at` set but no
    // `ready_at` is parked / shelved. deriveStatus rule 6 already
    // returns "Backlog" for this case (so the predicate above filters
    // it out), but the explicit check documents the precedence at the
    // dispatchability surface and survives any future deriveStatus
    // rewrite without silently re-opening Backlog cards to dispatch.
    if (i.archived_at !== null && i.ready_at === null) return false;
    if (isEffectivelyWaitingOn(i, byId)) return false;
    // DX-658 (Phase 2) — `blocked: {at, reason}` is now a pure
    // dispatch gate independent of `status`. The picker skips any
    // card with the gate populated regardless of which derived
    // semantic column it lives in. `blocked?.at != null` matches the
    // validator invariant (`blocked` non-null ⇒ `at` non-empty); the
    // explicit at-check survives any future widening of the shape.
    if (i.blocked?.at != null && i.blocked.at !== "") return false;
    if (isEffectivelyConflicted(i, allOpen)) return false;
    // DX-231 (Phase 2 — DX-233): the orthogonal "needs human action"
    // field is a dispatch gate parallel to `blocked` and `waiting_on`.
    // Paired with `isDispatchSessionTerminal` in `src/worker/issue-route.ts`
    // (landed Phase 1) that releases the slot when an agent saves
    // `requires_human != null`. Without both clauses, an agent that
    // flips the field and exits would see the poller re-dispatch the
    // card on the next tick — infinite loop. `/api/launch` deliberately
    // bypasses this filter (operator override); see `handleLaunch`.
    //
    // Loose `!= null` (vs strict `!== null`) tolerates pre-DX-231
    // JSONB rows whose `requires_human` key was never written — those
    // surface as `undefined` after JSONB→JS conversion and would
    // otherwise be incorrectly excluded. Same coercion applied to
    // `blocked` + `dispatch` for symmetry.
    if (i.requires_human != null) return false;
    if (i.dispatch != null) return false;
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
 * Return every open (non-terminal) issue regardless of status. Used by
 * the picker's resume-existing-card pre-check (DX-360) — an agent
 * carrying an open `assigned_agent` claim must be re-dispatched to that
 * card before any new ToDo is offered. No sort applied; caller picks
 * the order they want.
 */
export async function listOpenYamls(
  repoLocalPath: string,
  _prefix: string,
): Promise<Issue[]> {
  const repoName = repoNameFromPath(repoLocalPath);
  const rows = await dbListOpenIssues(repoName);
  return rows.map((r) => r.issue);
}

/**
 * Return every In Progress issue. Used by the orphan-resume recovery
 * path. FIFO `mirror_updated_at` ordering — oldest first so the
 * longest-running orphan is reconciled first.
 */
export async function listInProgressYamls(
  repoLocalPath: string,
  _prefix: string,
): Promise<Issue[]> {
  const repoName = repoNameFromPath(repoLocalPath);
  const rows = await dbListOpenIssues(repoName);
  // DX-584 (Phase 4) — derived semantic state, not raw `status`. The
  // orphan-resume + reattach paths walk this list to find dispatches
  // whose dispatched PID died without a terminal save; derived state
  // covers both pre- and post-Phase-4 cards uniformly.
  return sortFifo(rows.filter((r) => deriveStatus(r.issue) === "In Progress"));
}

/**
 * Look up the In Progress YAML whose `dispatch.id` matches `dispatchId`.
 * Used by the worker boot reattach pass (DX-209 extension) to decide
 * whether a dead-PID dispatch row is salvageable via `claude --resume`.
 *
 * Returns `null` when no matching In Progress YAML exists — caller falls
 * through to the orphan-mark behavior. The dispatch may have already
 * moved its YAML to `closed/` (status: Done) before the worker died, in
 * which case auto-resume must NOT fire (the work is done; the dispatch
 * row just never got finalized).
 */
export async function findInProgressIssueByDispatchId(
  repoLocalPath: string,
  dispatchId: string,
): Promise<Issue | null> {
  const repoName = repoNameFromPath(repoLocalPath);
  const rows = await dbListOpenIssues(repoName);
  // DX-584 (Phase 4) — derived semantic state. A terminal-stamped card
  // (completed_at / cancelled_at set) reads as Done / Cancelled even
  // if the raw `status` field still says In Progress; the reattach
  // pass must NOT re-resume a card whose work is already done.
  const match = rows.find(
    (r) =>
      deriveStatus(r.issue) === "In Progress" &&
      r.issue.dispatch?.id === dispatchId,
  );
  return match?.issue ?? null;
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
  // DX-658 / Phase 2 — `"Blocked"` is no longer an `IssueStatus`. The
  // self-block gate (`Issue.blocked != null`) signals a card that
  // still needs human triage of the block reason; keep it in scope.
  if (issue.blocked !== null) return true;
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
