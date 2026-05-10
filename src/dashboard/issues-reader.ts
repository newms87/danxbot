import type {
  Issue,
  IssueStatus,
  IssueType,
} from "../issue-tracker/interface.js";
import { ISSUE_STATUSES } from "../issue-tracker/interface.js";
import { sortInputsForStatus } from "../issue-tracker/sort.js";
import { serializeIssue } from "../issue-tracker/yaml.js";
import {
  dbListAllIssues,
  dbListIssueHistory,
  dbSelectIssueDetail,
  type DbIssueRow,
} from "../poller/issues-db.js";
import { repoNameFromPath } from "../poller/repo-name.js";

/**
 * Slim child entry on the list shape — child id + title + type + raw
 * status + raw waiting_on flag + missing flag. Every field is a literal
 * passthrough of the child's YAML; the SPA renders verbatim. `missing`
 * is true when the child id was referenced but no Issue was loaded
 * (e.g. closed beyond the recent-50 cap, or genuinely orphaned); the
 * SPA renders such rows with the unknown placeholder name. Used for
 * both epic phases and non-epic sub-cards (the shape is identical; the
 * SPA relabels the section header per parent type).
 */
export interface IssueListChild {
  id: string;
  name: string;
  type: IssueType;
  status: IssueStatus;
  waiting_on: boolean;
  /**
   * True when the child's `waiting_on.by[]` is non-empty — i.e. the child
   * is waiting on another card, not on a human / external. Drives the
   * yellow ⏸ glyph variant in the children checklist; plain `waiting_on`
   * (no card refs) keeps a different variant.
   */
  waiting_on_by_card: boolean;
  missing: boolean;
}

/**
 * List-card projection of an Issue. Sized for the Issues-tab board view —
 * AC / child / comment counts are pre-rolled so the SPA can render the
 * card without a per-row detail fetch. `children_detail[]` is included on
 * cards that have any children so the board can render the per-child
 * checklist (labelled "Phases" on epics, "Children" on non-epics) without
 * a detail fetch.
 */
export interface IssueListItem {
  id: string;
  type: IssueType;
  title: string;
  /** Full markdown body. Included so the SPA's search filter can match against the description without a per-row detail fetch. */
  description: string;
  status: IssueStatus;
  parent_id: string | null;
  children: string[];
  ac_total: number;
  ac_done: number;
  /** Detail array for rendering. Empty when `children.length === 0`. SPA derives total/done counts from this. */
  children_detail: IssueListChild[];
  waiting_on: boolean;
  /** Set when `waiting_on === true`; null otherwise. Surfaces reason on the card without a detail fetch. */
  waiting_on_reason: string | null;
  /** Issue ids (`ISS-N[]`) this card is waiting on. Empty when `waiting_on === false` OR when the record has no by[] (rare — schema requires `by[]` non-empty when `waiting_on` set, but defensive default is `[]`). */
  waiting_on_by: string[];
  comments_count: number;
  has_retro: boolean;
  updated_at: number;
  /**
   * Operator priority knob. `[1.0, 5.0]`; default `3.0`. Surfaced on the
   * list item so the SPA mirror (`dashboard/src/types.ts`) can render it
   * and so a future Agents-tab edit affordance has the value pre-loaded.
   * The board's per-column order already incorporates priority via the
   * backend's `sortIssuesForStatus`; the SPA should NEVER re-sort using
   * this field. ISS-210.
   */
  priority: number;
  /**
   * Resolved persona name (`AGENT_NAME_SHAPE`) when the multi-worker pick
   * algorithm has claimed this card for a specific agent (DX-200 / DX-164).
   * `null` when no agent owns the card. Surfaced on the list item so the
   * SPA renders the `<AgentBadge>` chip on issue rows + drawer header
   * without a per-row detail fetch.
   */
  assigned_agent: string | null;
}

/** Full Issue plus the mirror-write timestamp (ms) and a serialized YAML rendering of the current state. */
export type IssueDetail = Issue & { updated_at: number; raw_yaml: string };

/**
 * Per-issue history entry projected from `issue_history`. The mirror
 * stamps a row on every content-changing upsert + every tombstone; the
 * dashboard exposes them as a timeline. RFC 6902 patch ops live in
 * `patch` verbatim — the SPA is free to render them directly or apply
 * them to a synthetic prior snapshot.
 */
export interface IssueHistoryEntry {
  changed_at: string;
  source: string;
  prev_hash: string | null;
  next_hash: string;
  patch: unknown;
}

const DEFAULT_CLOSED_LIMIT = 50;

const STEM_SHAPE = /^([A-Z]{2,4})-\d+$/;

interface RawIssue {
  issue: Issue;
  mtimeMs: number;
}

/**
 * Phase 5 of the Issues DB Mirror epic (DX-151 / DX-156).
 *
 * Project a DB row into the shape the JS slice + sort logic consumes.
 * Throws on malformed entries (mirror writer stores `{_malformed: true}`
 * for unparseable YAML bytes) — fail loud, no silent skip, matching
 * the pre-DX-156 reader's behaviour for rogue YAMLs on disk.
 */
function toRawIssue(row: DbIssueRow): RawIssue {
  const data = row.issue as unknown as Record<string, unknown>;
  if (data._malformed === true) {
    const id = typeof data.id === "string" ? data.id : "<unknown>";
    throw new Error(
      `issues-reader: malformed YAML mirrored for ${id} — refusing to surface in the dashboard. Operator must fix the YAML on disk.`,
    );
  }
  // Defensive: a row whose `data.id` doesn't match the per-prefix shape
  // is a regression in the mirror writer (the (repo_name, id) PK is fed
  // by `data->>'id'`, so the row could not have landed without an id).
  // Throw so the dashboard surfaces the corruption rather than silently
  // dropping the row.
  const id = typeof data.id === "string" ? data.id : "";
  if (!STEM_SHAPE.test(id)) {
    throw new Error(
      `issues-reader: rogue id "${id}" in DB row — id must match ${STEM_SHAPE}.`,
    );
  }
  return { issue: row.issue, mtimeMs: row.mirrorUpdatedAtMs };
}

function toListItem(
  raw: RawIssue,
  byId: Map<string, Issue>,
): IssueListItem {
  const { issue, mtimeMs } = raw;
  const childrenDetail: IssueListChild[] = issue.children
    .map((cid) => {
      const child = byId.get(cid);
      if (!child) {
        // Surface as waiting_on so the SPA's projection routes the row
        // into the red ⛔ chip — visually distinct from a real ToDo
        // child. `missing: true` is the canonical discriminator.
        return {
          id: cid,
          name: `<${cid}: unknown>`,
          type: "Feature" as IssueType,
          status: "ToDo" as IssueStatus,
          waiting_on: true,
          waiting_on_by_card: false,
          missing: true,
        };
      }
      return {
        id: cid,
        name: child.title,
        type: child.type,
        status: child.status,
        waiting_on: child.waiting_on !== null,
        waiting_on_by_card:
          child.waiting_on !== null && child.waiting_on.by.length > 0,
        missing: false,
      };
    });
  // No projection. The literal YAML `status` + `waiting_on` are the
  // single source of truth for both the board's column placement and
  // the card's "Blocked by" pill. If an epic should surface as Blocked,
  // the worker / operator writes that into the YAML directly. Epics
  // whose only deps are intra-sibling children — and the Issues tab's
  // child glyph badges — communicate the structural relationship
  // without the dashboard inventing a different status from what the
  // tracker says.

  return {
    id: issue.id,
    type: issue.type,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    parent_id: issue.parent_id,
    children: [...issue.children],
    ac_total: issue.ac.length,
    ac_done: issue.ac.filter((a) => a.checked).length,
    children_detail: childrenDetail,
    waiting_on: issue.waiting_on !== null,
    waiting_on_reason: issue.waiting_on?.reason ?? null,
    waiting_on_by: issue.waiting_on?.by ?? [],
    comments_count: issue.comments.length,
    has_retro:
      issue.retro.good.length > 0 ||
      issue.retro.bad.length > 0 ||
      issue.retro.action_item_ids.length > 0 ||
      issue.retro.commits.length > 0,
    updated_at: mtimeMs,
    priority: issue.priority,
    assigned_agent: issue.assigned_agent,
  };
}

function isClosed(status: IssueStatus): boolean {
  return status === "Done" || status === "Cancelled";
}

/**
 * Phase 5 of the Issues DB Mirror epic (DX-151 / DX-156).
 *
 * List every Issue currently mirrored into the `issues` table for the
 * named repo. Replaces the pre-DX-156 YAML walk over
 * `<repoCwd>/.danxbot/issues/{open,closed}/*.yml`.
 *
 * - Closed cap: `recent` (default) returns the 50 newest by
 *   `mirror_updated_at` PLUS every closed card referenced from an open
 *   card or a recent-closed parent. `all` returns every closed row.
 * - Final list is grouped by status, sorted per-status via
 *   `sortInputsForStatus`, and concatenated in `ISSUE_STATUSES` order so
 *   debug dumps land in a stable column order. The SPA re-groups by
 *   `status` for board rendering.
 */
export async function listIssues(
  repoCwd: string,
  opts: { includeClosed: "recent" | "all" } = { includeClosed: "recent" },
): Promise<IssueListItem[]> {
  const repoName = repoNameFromPath(repoCwd);
  const dbRows = await dbListAllIssues(repoName);
  const all = dbRows.map(toRawIssue);

  const openRaw: RawIssue[] = [];
  const closedRaw: RawIssue[] = [];
  for (const r of all) {
    if (isClosed(r.issue.status)) {
      closedRaw.push(r);
    } else {
      openRaw.push(r);
    }
  }

  // Sort closed by mtime BEFORE slicing — the cap (50) is "newest 50",
  // so the slice is correctness-bound, not cosmetic.
  closedRaw.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let closedSlice: RawIssue[];
  if (opts.includeClosed === "all") {
    closedSlice = closedRaw;
  } else {
    // Recent-50 by mtime PLUS every closed card referenced by an open
    // card's children[] / parent_id / waiting_on.by[]. Without the
    // referenced-pull, an Epic with 8 phase children whose 3 oldest
    // Done phases fall past the 50-cap renders "3 children not in
    // current view" — operator-visible noise even though the data is
    // on disk. The board's recency window is preserved (recent-50 still
    // sets the floor); referenced extras are additive, not a re-sort.
    const recent = closedRaw.slice(0, DEFAULT_CLOSED_LIMIT);
    const recentIds = new Set(recent.map((r) => r.issue.id));
    const referencedIds = new Set<string>();
    // Walk BOTH open AND recent-closed parents so a recent-but-old-children
    // closed Epic (DX-99 lives in recent-50, its DX-100 / DX-101 / DX-103
    // phase children fall past the cap) still pulls its children into view.
    // The walk is single-level — good enough for the operator-visible
    // "show me what's still referenced" guarantee without unbounded
    // pull-in.
    for (const r of [...openRaw, ...recent]) {
      for (const cid of r.issue.children) referencedIds.add(cid);
      if (r.issue.parent_id) referencedIds.add(r.issue.parent_id);
      if (r.issue.waiting_on) {
        for (const id of r.issue.waiting_on.by) referencedIds.add(id);
      }
    }
    const referencedExtras = closedRaw.filter(
      (r) => referencedIds.has(r.issue.id) && !recentIds.has(r.issue.id),
    );
    closedSlice = [...recent, ...referencedExtras];
  }

  const slice = [...openRaw, ...closedSlice];
  // Build an id → Issue map across BOTH open + closed so parents can
  // resolve their `children[]` ids regardless of where each child lives.
  const byId = new Map<string, Issue>();
  for (const r of slice) byId.set(r.issue.id, r.issue);
  // Group by status, run the canonical per-status sort, and
  // concatenate. The SPA renders the resulting order verbatim — no
  // column-level re-sort. Status order in the concatenation follows
  // `ISSUE_STATUSES` so columns the SPA cares about appear in a stable
  // order on debugging dumps; the SPA itself re-groups by `status` in
  // `IssueBoard.vue` so the actual on-screen column placement is
  // unchanged.
  const grouped = new Map<IssueStatus, RawIssue[]>();
  for (const status of ISSUE_STATUSES) grouped.set(status, []);
  for (const r of slice) grouped.get(r.issue.status)?.push(r);

  const ordered: RawIssue[] = [];
  for (const status of ISSUE_STATUSES) {
    const rows = grouped.get(status) ?? [];
    if (rows.length === 0) continue;
    const sorted = sortInputsForStatus(
      rows.map((r) => ({
        issue: r.issue,
        payload: r,
        updatedAtMs: r.mtimeMs,
      })),
      status,
      byId,
    );
    for (const r of sorted) ordered.push(r);
  }
  return ordered.map((r) => toListItem(r, byId));
}

/**
 * Phase 5 of the Issues DB Mirror epic (DX-151 / DX-156).
 *
 * Read a single issue by `<PREFIX>-N`. Pre-DX-156 the helper looked at
 * `<repoCwd>/.danxbot/issues/{open,closed}/<id>.yml`; under the DB
 * mirror there is exactly one row per `(repo_name, id)` regardless of
 * status, so a single SELECT replaces the open/closed two-step.
 *
 * `raw_yaml` is rendered from the canonicalized `data` jsonb via
 * `serializeIssue` rather than re-reading the file. The mirror writer's
 * `data` column carries the parsed YAML state authoritatively; the
 * round-trip serialization is byte-stable for any YAML originally
 * written by `serializeIssue` (every tracker / agent / dashboard write
 * goes through that path). Hand-edited YAMLs with non-canonical
 * formatting will lose those formatting choices in the rendered string
 * — acceptable, the field is for read-only display.
 */
export async function readIssueDetail(
  repoCwd: string,
  id: string,
): Promise<IssueDetail | null> {
  const repoName = repoNameFromPath(repoCwd);
  const row = await dbSelectIssueDetail(repoName, id);
  if (!row) return null;
  const raw = toRawIssue(row);
  return {
    ...raw.issue,
    updated_at: raw.mtimeMs,
    raw_yaml: serializeIssue(raw.issue),
  };
}

/**
 * Phase 5 of the Issues DB Mirror epic (DX-151 / DX-156).
 *
 * Per-issue change history — RFC 6902 patches the mirror stamps on
 * every content-changing upsert + every tombstone. Returned in
 * ascending `changed_at` order so a timeline UI renders without a
 * client-side sort.
 *
 * `limit` defaults to 200. Pass a higher value when an export needs
 * the full lifecycle.
 */
export async function readIssueHistory(
  repoCwd: string,
  id: string,
  opts: { limit?: number } = {},
): Promise<IssueHistoryEntry[]> {
  const repoName = repoNameFromPath(repoCwd);
  const rows = await dbListIssueHistory(repoName, id, opts.limit ?? 200);
  return rows.map((r) => ({
    changed_at: r.changedAt,
    source: r.source,
    prev_hash: r.prevHash,
    next_hash: r.nextHash,
    patch: r.patch,
  }));
}
