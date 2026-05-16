/**
 * Phase 4 + Phase 5 of the Issues DB Mirror epic (DX-151 / DX-155 / DX-156).
 *
 * Low-level SQL helpers consumed by the migrated readers across the
 * codebase: poller (`local-issues.ts`, `yaml-lifecycle.ts`, `epic-status.ts`)
 * AND the dashboard (`src/dashboard/issues-reader.ts`). Every reader
 * function builds on these primitives so the SQL surface is isolated in
 * one module and the readers stay focused on filtering / sorting
 * semantics. The module name keeps its `poller/` location for backwards
 * compatibility with the Phase 4 import paths; the helpers are
 * deliberately repo-agnostic (no poller-specific logic) so the dashboard
 * can share the same `setIssueDbQueryFn` test hook.
 *
 * Pool wiring follows the codebase's established pattern: pull `query`
 * from `src/db/connection.ts`. Tests inject a per-test pool via
 * `vi.mock("../db/connection.js", () => ({ query: ... }))`. Integration
 * tests use the `setIssueDbQueryFn` hook below to swap in a function
 * bound to a `createTestDb()` pool — cleaner than re-mocking on every
 * suite.
 *
 * Returns shapes:
 *   - `Issue` payloads come from `data` (jsonb) cast directly. The mirror
 *     canonicalizes parsed YAML before storing, so the jsonb shape is
 *     guaranteed to match the strict `Issue` type modulo serialization
 *     round-trip — same guarantees the YAML readers had.
 *   - `mirrorUpdatedAtMs` exposes the FIFO ordering signal that file
 *     mtime previously provided. The watcher stamps `mirror_updated_at`
 *     on every content-changing upsert, so it is effectively a logical
 *     mtime under the SQL projection.
 */

import { query as defaultQuery } from "../db/connection.js";
import type { Issue } from "../issue-tracker/interface.js";

export interface DbIssueRow {
  issue: Issue;
  mirrorUpdatedAtMs: number;
}

type QueryFn = <T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

let queryFn: QueryFn = defaultQuery;

/**
 * Test hook — swap the underlying query function. Production never
 * calls this. Integration tests bind to a `createTestDb()` pool;
 * unit tests typically use `vi.mock` instead.
 */
export function setIssueDbQueryFn(fn: QueryFn): void {
  queryFn = fn;
}

export function resetIssueDbQueryFn(): void {
  queryFn = defaultQuery;
}

interface RawRow {
  data: Issue;
  mirror_updated_at: string | Date;
}

function toRow(raw: RawRow): DbIssueRow {
  const ts =
    raw.mirror_updated_at instanceof Date
      ? raw.mirror_updated_at.getTime()
      : new Date(raw.mirror_updated_at).getTime();
  return { issue: normalizeLoadedIssue(raw.data), mirrorUpdatedAtMs: ts };
}

/**
 * Fill schema-default values on rows whose on-disk YAML predates fields
 * that were added in later schema bumps (v4 history, v5 priority, v6
 * position / requires_human / assigned_agent / waiting_on optional).
 *
 * The mirror (`src/db/issues-mirror.ts#readAndParse`) intentionally
 * stores the YAML payload verbatim — no `parseIssue` / `validateIssue`
 * pass — so a hash round-trip stays content-addressed and older clients
 * round-trip cleanly without rewriting v3 bytes into v6 bytes. That
 * leaves the schema-default fill-in as the DB-reader's job: every
 * consumer behind these helpers can assume the strict `Issue` shape,
 * regardless of which schema version the row was written under.
 *
 * Mutates the input in place — `data` is a fresh JSONB deserialization
 * owned by this scope. `_malformed: true` rows (also stamped by the
 * mirror when YAML parsing throws) are passed through untouched; the
 * consumer is responsible for skipping them.
 */
function normalizeLoadedIssue(raw: unknown): Issue {
  if (!raw || typeof raw !== "object") return raw as Issue;
  const obj = raw as Record<string, unknown>;
  if (obj._malformed === true) return obj as unknown as Issue;
  if (!Array.isArray(obj.children)) obj.children = [];
  if (!Array.isArray(obj.comments)) obj.comments = [];
  if (!Array.isArray(obj.history)) obj.history = [];
  if (!Array.isArray(obj.ac)) obj.ac = [];
  if (!Array.isArray(obj.conflict_on)) obj.conflict_on = [];
  if (obj.waiting_on === undefined) obj.waiting_on = null;
  if (obj.blocked === undefined) obj.blocked = null;
  if (obj.requires_human === undefined) obj.requires_human = null;
  if (obj.assigned_agent === undefined) obj.assigned_agent = null;
  if (obj.priority === undefined) obj.priority = 3.0;
  if (obj.position === undefined) obj.position = null;
  if (obj.dispatch === undefined) obj.dispatch = null;
  if (obj.parent_id === undefined) obj.parent_id = null;
  if (obj.retro === undefined || obj.retro === null) {
    obj.retro = { good: "", bad: "", action_item_ids: [], commits: [] };
  } else if (typeof obj.retro === "object") {
    const r = obj.retro as Record<string, unknown>;
    if (!Array.isArray(r.action_item_ids)) r.action_item_ids = [];
    if (!Array.isArray(r.commits)) r.commits = [];
    if (typeof r.good !== "string") r.good = "";
    if (typeof r.bad !== "string") r.bad = "";
  }
  if (obj.waiting_on && typeof obj.waiting_on === "object") {
    const w = obj.waiting_on as Record<string, unknown>;
    if (!Array.isArray(w.by)) w.by = [];
  }
  if (obj.triage && typeof obj.triage === "object") {
    const t = obj.triage as Record<string, unknown>;
    if (!Array.isArray(t.history)) t.history = [];
    if (typeof t.expires_at !== "string") t.expires_at = "";
    if (typeof t.reassess_hint !== "string") t.reassess_hint = "";
    if (typeof t.last_status !== "string") t.last_status = "";
    if (typeof t.last_explain !== "string") t.last_explain = "";
  }
  return obj as unknown as Issue;
}

function nullableIssue(data: Issue | undefined | null): Issue | null {
  if (data === undefined || data === null) return null;
  return normalizeLoadedIssue(data);
}

/**
 * Fetch one row keyed by `(repo_name, id)`. Null when no match. Used by
 * `loadLocal`.
 */
export async function dbSelectIssueById(
  repoName: string,
  id: string,
): Promise<Issue | null> {
  const rows = await queryFn<{ data: Issue }>(
    `SELECT data FROM issues WHERE repo_name = $1 AND id = $2 LIMIT 1`,
    [repoName, id],
  );
  return nullableIssue(rows[0]?.data);
}

/**
 * Fetch one row by `(repo_name, external_id)`. Null when no match. Used
 * by `findByExternalId`. The external_id is a generated column on the
 * issues table; no index yet — a sequential scan within the repo's rows
 * is acceptable at current scale (per design doc — the index list does
 * not include external_id). If this grows hot a future migration adds a
 * dedicated index.
 */
export async function dbSelectIssueByExternalId(
  repoName: string,
  externalId: string,
): Promise<Issue | null> {
  if (!externalId) return null;
  const rows = await queryFn<{ data: Issue }>(
    `SELECT data FROM issues WHERE repo_name = $1 AND external_id = $2 LIMIT 1`,
    [repoName, externalId],
  );
  return nullableIssue(rows[0]?.data);
}

/**
 * Fetch every non-terminal (not Done / Cancelled) issue for the repo.
 * Replaces the YAML walk over `<repo>/.danxbot/issues/open/`. The result
 * mirrors the file-walk it replaced: every Issue whose YAML lived in
 * `open/` had a non-terminal status; a closed YAML lived in `closed/`
 * and was skipped. Done / Cancelled rows in the DB correspond to closed/
 * entries — the status filter excludes them.
 *
 * `mirrorUpdatedAtMs` is the FIFO sort signal that replaces file mtime.
 */
export async function dbListOpenIssues(
  repoName: string,
): Promise<DbIssueRow[]> {
  const rows = await queryFn<RawRow>(
    `SELECT data, mirror_updated_at FROM issues
       WHERE repo_name = $1 AND status NOT IN ('Done', 'Cancelled')`,
    [repoName],
  );
  return rows.map(toRow);
}

/**
 * DX-217 (Event-Driven Worker Phase 2) — dependents lookup. Returns
 * every issue in the repo whose `waiting_on.by[]` array contains the
 * supplied id. Used by `reconcileIssue` step 10 (recurse on dependents)
 * to schedule a reconcile for every card waiting on the just-changed
 * issue, so dep-chain unblocks propagate the same tick instead of
 * waiting for the next 60s poll.
 *
 * Filters by repo (`repo_name = $1`) and uses the JSON containment
 * operator `@>` against a single-element `by[]` array — Postgres can
 * use the GIN index on `data` if one exists; absent that, the cost is
 * a scan over the repo's rows, which is acceptable at current scale.
 *
 * `data->'waiting_on' IS NOT NULL` guards against cards whose link was
 * already null. With the DX-219 follow-up that removed the auto-clear
 * pass, closed (Done / Cancelled) cards MAY still carry a non-null
 * `waiting_on` (durable audit trail) — reconcile step 10 will recurse
 * onto those closed dependents and exit early at the heal step, which
 * is a no-op. The filter just keeps the candidate set small.
 */
export async function dbListDependentsByWaitingOnId(
  repoName: string,
  id: string,
): Promise<Issue[]> {
  const containment = JSON.stringify({ waiting_on: { by: [id] } });
  const rows = await queryFn<{ data: Issue }>(
    `SELECT data FROM issues
       WHERE repo_name = $1
         AND data->'waiting_on' IS NOT NULL
         AND data @> $2::jsonb`,
    [repoName, containment],
  );
  return rows.map((r) => normalizeLoadedIssue(r.data));
}

/**
 * Children of a parent — used by `recomputeParentStatuses`. Returns
 * children in any status (open or closed) so a Done child still
 * contributes to the parent-status derivation. The `(repo_name,
 * parent_id)` partial index covers this query.
 */
export async function dbListChildrenByParent(
  repoName: string,
  parentId: string,
): Promise<Issue[]> {
  const rows = await queryFn<{ data: Issue }>(
    `SELECT data FROM issues WHERE repo_name = $1 AND parent_id = $2`,
    [repoName, parentId],
  );
  return rows.map((r) => normalizeLoadedIssue(r.data));
}

/**
 * Issues with non-empty `children[]` and non-terminal status — drives
 * the parent-status recompute pass. The walker filters waiting_on /
 * derive-skip cases in JS; the SQL layer just bounds the candidate set.
 */
export async function dbListParentsToRecompute(
  repoName: string,
): Promise<Issue[]> {
  const rows = await queryFn<{ data: Issue }>(
    `SELECT data FROM issues
       WHERE repo_name = $1
         AND status NOT IN ('Done', 'Cancelled')
         AND jsonb_array_length(data->'children') > 0`,
    [repoName],
  );
  return rows.map((r) => normalizeLoadedIssue(r.data));
}

/**
 * Phase 5 of the Issues DB Mirror epic (DX-151 / DX-156).
 *
 * Fetch every issue for the repo regardless of status. Replaces the
 * dashboard's old YAML walk over `open/` + `closed/`. The dashboard's
 * `listIssues` slice + sort logic runs in JS on top of this set; SQL
 * just bounds the candidate rows by `repo_name`.
 *
 * `mirrorUpdatedAtMs` is the file-mtime equivalent — the watcher stamps
 * it on every content-changing upsert.
 *
 * **Scale guard (`DASHBOARD_MAX_ROWS`):** the dashboard does its
 * referenced-extras walk in JS over the full row set, which means the
 * SQL has to return every row to compute it. At today's scale (~150
 * closed YAMLs per repo) that's a few hundred kilobytes — fine. A
 * runaway repo with thousands of closed issues would silently grow the
 * payload. The hard cap exists so the dashboard fails loudly instead
 * of serving multi-MB responses on every poll. When this trips,
 * follow-up work should split into "all open" + "newest-N closed" +
 * "explicit referenced ids" — see DX-156 review notes.
 */
export const DASHBOARD_MAX_ROWS = 5000;

export class IssuesPayloadTooLargeError extends Error {
  constructor(repoName: string, count: number) {
    super(
      `dbListAllIssues: ${repoName} returned ${count} rows (cap = ${DASHBOARD_MAX_ROWS}). ` +
        "Split into open + recent-closed + explicit-referenced queries; full-table pull is no longer safe.",
    );
    this.name = "IssuesPayloadTooLargeError";
  }
}

/**
 * Batch-fetch a subset of issues by id. Returns rows in any order;
 * caller indexes into a `Map<id, Issue>` for lookup. Used by the
 * dispatch reader to enrich its open-only `byId` with closed
 * dependencies referenced from any open card's `waiting_on.by[]`, so
 * `effectiveWaitingOn` can verify each dep's terminal status without a
 * per-dep round-trip.
 *
 * Empty `ids` returns `[]` without touching the DB.
 */
export async function dbSelectIssuesByIds(
  repoName: string,
  ids: string[],
): Promise<Issue[]> {
  if (ids.length === 0) return [];
  const rows = await queryFn<{ data: Issue }>(
    `SELECT data FROM issues WHERE repo_name = $1 AND id = ANY($2::text[])`,
    [repoName, ids],
  );
  return rows.map((r) => normalizeLoadedIssue(r.data));
}

export async function dbListAllIssues(
  repoName: string,
): Promise<DbIssueRow[]> {
  const rows = await queryFn<RawRow>(
    `SELECT data, mirror_updated_at FROM issues
       WHERE repo_name = $1
       LIMIT ${DASHBOARD_MAX_ROWS + 1}`,
    [repoName],
  );
  if (rows.length > DASHBOARD_MAX_ROWS) {
    throw new IssuesPayloadTooLargeError(repoName, rows.length);
  }
  return rows.map(toRow);
}

/**
 * Phase 5 of the Issues DB Mirror epic (DX-151 / DX-156).
 *
 * Fetch one issue with its mirror timestamp, regardless of terminal
 * status. Used by the dashboard's `readIssueDetail` to project the
 * detail body + the `updated_at` field. Returns null when no row
 * exists for `(repo_name, id)`.
 */
export async function dbSelectIssueDetail(
  repoName: string,
  id: string,
): Promise<DbIssueRow | null> {
  const rows = await queryFn<RawRow>(
    `SELECT data, mirror_updated_at FROM issues
       WHERE repo_name = $1 AND id = $2 LIMIT 1`,
    [repoName, id],
  );
  if (rows.length === 0) return null;
  return toRow(rows[0]);
}

/**
 * Phase 5 of the Issues DB Mirror epic (DX-151 / DX-156).
 *
 * Per-issue change history — RFC 6902 patches stamped by the mirror
 * writer on every content-changing upsert + every tombstone. Returned
 * in ascending `changed_at` order so a timeline UI can render in
 * arrival order without a client-side sort.
 *
 * Tiebreaker `id ASC` resolves rows whose `changed_at` lands on the
 * same instant — `id` is the `issue_history.id` `bigserial` PK
 * (migration 016), so it advances monotonically per INSERT. Same-
 * timestamp rows therefore preserve insertion order. Without the
 * tiebreaker, two same-timestamp inserts would expose PG's natural
 * order, which is unstable across query planner choices.
 *
 * `limit`: row cap (default 200). Must be a positive finite integer;
 * the route layer is responsible for clamping to the public maximum
 * before calling.
 */
export interface DbIssueHistoryRow {
  changedAt: string;
  source: string;
  prevHash: string | null;
  nextHash: string;
  patch: unknown;
}

export async function dbListIssueHistory(
  repoName: string,
  id: string,
  limit: number = 200,
): Promise<DbIssueHistoryRow[]> {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(
      `dbListIssueHistory: limit must be a positive finite integer (got ${limit})`,
    );
  }
  const rows = await queryFn<{
    changed_at: string | Date;
    source: string;
    prev_hash: string | null;
    next_hash: string;
    patch: unknown;
  }>(
    `SELECT changed_at, "source", prev_hash, next_hash, patch
       FROM issue_history
       WHERE repo_name = $1 AND issue_id = $2
       ORDER BY changed_at ASC, id ASC
       LIMIT $3`,
    [repoName, id, limit],
  );
  return rows.map((r) => ({
    changedAt:
      r.changed_at instanceof Date
        ? r.changed_at.toISOString()
        : new Date(r.changed_at).toISOString(),
    source: r.source,
    prevHash: r.prev_hash,
    nextHash: r.next_hash,
    patch: r.patch,
  }));
}
