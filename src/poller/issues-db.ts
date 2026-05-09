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
  return { issue: raw.data, mirrorUpdatedAtMs: ts };
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
  return rows[0]?.data ?? null;
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
  return rows[0]?.data ?? null;
}

/**
 * Fetch every non-terminal (not Done / Cancelled) issue for the repo.
 * Replaces the YAML walk over `<repo>/.danxbot/issues/open/`. The result
 * mirrors the legacy walker's output exactly: every Issue whose YAML
 * lived in `open/` had a non-terminal status; a closed YAML lived in
 * `closed/` and was skipped. Done / Cancelled rows in the DB correspond
 * to closed/ entries — the status filter excludes them.
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
  return rows.map((r) => r.data);
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
  return rows.map((r) => r.data);
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
