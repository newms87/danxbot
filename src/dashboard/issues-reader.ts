import type {
  Issue,
  IssueStatus,
  IssueType,
  RequiresHuman,
} from "../issue-tracker/interface.js";
import { ISSUE_STATUSES } from "../issue-tracker/interface.js";
import { sortInputsForStatus } from "../issue-tracker/sort.js";
import { serializeIssue } from "../issue-tracker/yaml.js";
import {
  dbListAllIssues,
  dbListIssueHistory,
  dbSelectIssueDetail,
  dbSelectIssuesByIds,
  type DbIssueRow,
} from "../poller/issues-db.js";
import { repoNameFromPath } from "../poller/repo-name.js";
import { createLogger } from "../logger.js";
import { effectiveWaitingOn } from "../issue/effective-waiting-on.js";

const log = createLogger("issues-reader");

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
  /**
   * True when the child's `requires_human != null`. Drives the 👤 glyph
   * shown next to the child row in the parent's checklist (DX-239 / P8 of
   * DX-231). Boolean instead of the full record because the checklist row
   * does not surface the reason / steps — those live on the child's own
   * drawer; the indicator is structural-only.
   */
  requires_human: boolean;
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
   * Card creation time in epoch ms. Derived from `external_id` when the
   * tracker uses MongoDB ObjectId-shaped ids (Trello: first 8 hex chars
   * = unix seconds — deterministic). Falls back to `mirror_updated_at`
   * (first-seen by chokidar) for cards that have not yet been mirrored
   * outbound (`external_id: ""`). For those, `created_at === updated_at`
   * on first render and stabilizes once the row is touched again.
   */
  created_at: number;
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
   * Operator manual ordering knob inside a status column (DX-264).
   * `null` (default) means "fall back to the canonical ICE → priority →
   * mtime tier"; a finite number sorts ASC ahead of every `null`-
   * positioned sibling in the same priority bucket. The board does NOT
   * re-sort using this field — the backend's `sortIssuesForStatus`
   * applies the position tier and ships rows in canonical order. The
   * SPA only reads `position` for the drag affordance (compute the
   * neighbor midpoint on intra-column drop and PATCH `/api/issues/:id`
   * with the new value).
   */
  position: number | null;
  /**
   * Resolved persona name (`AGENT_NAME_SHAPE`) when the multi-worker pick
   * algorithm has claimed this card for a specific agent (DX-200 / DX-164).
   * `null` when no agent owns the card. Surfaced on the list item so the
   * SPA renders the `<AgentBadge>` chip on issue rows + drawer header
   * without a per-row detail fetch.
   */
  assigned_agent: string | null;
  /**
   * Orthogonal "this card needs a human" indicator (DX-231 / P8). `null`
   * when no human action is needed; full record (reason + steps + set_by
   * + set_at) when set. Surfaced on the list item so every card view
   * (board, drawer header, child rows) can render the 👤 indicator and
   * the dashboard's `RequiresHumanPanel` can show the reason without a
   * per-row detail fetch. Passthrough of the YAML field — the SPA never
   * mutates this; mutations go through `PATCH /api/issues/:id`.
   */
  requires_human: RequiresHuman | null;
  /**
   * DX-267 — count of this card's children whose `requires_human != null`.
   * Computed on every projection from `children_detail`; emitted on every
   * list item (Epic and non-Epic). Zero for cards with no children. The
   * SPA's `IssueCard.vue` gates an Epic-level rollup chip on this count;
   * the drawer header on Epics renders "<N> phase(s) need human action".
   * Missing children (orphaned id references) do not count — their
   * `requires_human` boolean is forced to `false` upstream so the rollup
   * does not over-report. Computed, not persisted — the YAML never carries
   * this field; the watcher mirrors only the underlying `requires_human`
   * record on each child.
   */
  requires_human_child_count: number;
}

/**
 * Full Issue plus the mirror-write timestamp (ms), creation time (ms),
 * a serialized YAML rendering of the current state, and the DX-267
 * rollup count of children whose `requires_human != null`. Same field
 * name as on `IssueListItem` so the SPA can read it identically on the
 * drawer header (DrawerHeader.vue) and the board card (IssueCard.vue).
 */
export type IssueDetail = Issue & {
  updated_at: number;
  created_at: number;
  raw_yaml: string;
  requires_human_child_count: number;
};

export { deriveCreatedAt } from "./issue-created-at.js";
import { deriveCreatedAt } from "./issue-created-at.js";

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
          requires_human: false,
          missing: true,
        };
      }
      const childEffective = effectiveWaitingOn(child, byId);
      return {
        id: cid,
        name: child.title,
        type: child.type,
        status: child.status,
        waiting_on: childEffective !== null,
        waiting_on_by_card:
          childEffective !== null && childEffective.by.length > 0,
        requires_human: child.requires_human !== null,
        missing: false,
      };
    });
  const effective = effectiveWaitingOn(issue, byId);
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
    waiting_on: effective !== null,
    waiting_on_reason: effective?.reason ?? null,
    waiting_on_by: effective?.by ?? [],
    comments_count: issue.comments.length,
    has_retro:
      issue.retro.good.length > 0 ||
      issue.retro.bad.length > 0 ||
      issue.retro.action_item_ids.length > 0 ||
      issue.retro.commits.length > 0,
    updated_at: mtimeMs,
    created_at: deriveCreatedAt(issue.external_id, mtimeMs),
    priority: issue.priority,
    position: issue.position,
    assigned_agent: issue.assigned_agent,
    requires_human: issue.requires_human,
    requires_human_child_count: childrenDetail.filter(
      (c) => c.requires_human,
    ).length,
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
  // Skip-and-log on per-row corruption rather than throw — a single
  // transient bad row (mid-write chokidar event, partially-mirrored
  // create) used to crash the entire `/api/issues` endpoint. The
  // mirror's invariant guarantees data.id matches the YAML stem, so
  // `toRawIssue` shouldn't throw; the catch is defense-in-depth.
  const all: RawIssue[] = [];
  for (const row of dbRows) {
    try {
      all.push(toRawIssue(row));
    } catch (err) {
      log.warn(
        `Skipping rogue issue row in ${repoName}: ${(err as Error).message}`,
      );
    }
  }

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
  // Project the response `waiting_on` to its EFFECTIVE value: null when
  // every dep is terminal so the SPA's "Waiting on …" pill hides without
  // a SPA-side change. The on-disk YAML retains the raw record as the
  // durable audit trail — `raw_yaml` below still serializes from the
  // unprojected issue, so a developer inspecting the raw YAML through
  // the dashboard sees the original link.
  // Union `waiting_on.by` (effective-resolution deps) + `children`
  // (DX-267 rollup count) into ONE SELECT so a Blocked Epic whose
  // `waiting_on.by` overlaps its phase `children` doesn't fan out into
  // two round-trips that both fetch the same rows. The set-union also
  // dedupes the overlapping ids before the SELECT touches the DB.
  const idsToFetch = new Set<string>();
  if (raw.issue.waiting_on !== null) {
    for (const id of raw.issue.waiting_on.by) idsToFetch.add(id);
  }
  for (const cid of raw.issue.children) idsToFetch.add(cid);

  let waiting_on = raw.issue.waiting_on;
  let requires_human_child_count = 0;
  if (idsToFetch.size > 0) {
    const rows = await dbSelectIssuesByIds(repoName, [...idsToFetch]);
    const byId = new Map<string, Issue>();
    for (const r of rows) byId.set(r.id, r);
    if (waiting_on !== null) {
      waiting_on = effectiveWaitingOn(raw.issue, byId);
    }
    // DX-267 — count phase children whose YAML carries a structured
    // `requires_human` record. Missing children (orphaned id references)
    // are absent from `byId` and excluded — matches the `IssueListItem`
    // projection's "missing ⟹ false" semantics. Loose `!= null` catches
    // both `null` and the rare malformed row whose `requires_human`
    // field is `undefined` (mirror passes `_malformed: true` rows
    // through; defense-in-depth so the rollup doesn't inflate).
    requires_human_child_count = raw.issue.children.filter((cid) => {
      const child = byId.get(cid);
      return child !== undefined && child.requires_human != null;
    }).length;
  }
  return {
    ...raw.issue,
    waiting_on,
    updated_at: raw.mtimeMs,
    created_at: deriveCreatedAt(raw.issue.external_id, raw.mtimeMs),
    raw_yaml: serializeIssue(raw.issue),
    requires_human_child_count,
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
