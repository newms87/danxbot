/**
 * Phase 4 of the Issues DB Mirror epic (DX-151 / DX-155).
 *
 * Low-level SQL helpers consumed by the migrated poller readers
 * (`local-issues.ts`, `yaml-lifecycle.ts`, `epic-status.ts`). Every
 * reader function builds on these primitives so the SQL surface is
 * isolated in one module and the readers stay focused on filtering /
 * sorting semantics.
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
