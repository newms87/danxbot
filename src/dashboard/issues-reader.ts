import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  Issue,
  IssueStatus,
  IssueType,
} from "../issue-tracker/interface.js";
import { parseIssue } from "../issue-tracker/yaml.js";
import { createLogger } from "../logger.js";

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
}

/** Full Issue plus the file's mtime in ms and the raw YAML source text. */
export type IssueDetail = Issue & { updated_at: number; raw_yaml: string };

const DEFAULT_CLOSED_LIMIT = 50;

// Module-scoped log-once dedupe for malformed / unreadable YAMLs. Surfaced
// to tests via `__resetWarnedPathsForTests`.
const warnedPaths = new Set<string>();

export function __resetWarnedPathsForTests(): void {
  warnedPaths.clear();
}

interface RawIssue {
  issue: Issue;
  mtimeMs: number;
  text: string;
}

const STEM_SHAPE = /^([A-Z]{2,4})-\d+$/;

async function readIssueFile(path: string): Promise<RawIssue | null> {
  let mtimeMs: number;
  let text: string;
  try {
    const s = await stat(path);
    mtimeMs = s.mtimeMs;
    text = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is the normal "no such issue" path for detail lookups —
    // surface as null. Anything else (EACCES, EIO, ENOTDIR) is a real
    // disk anomaly and propagates: the route's 500 handler turns it
    // into an operator-visible error rather than a silently empty list.
    if (code === "ENOENT") return null;
    throw err;
  }
  // Derive expectedPrefix from the filename stem, not from a per-repo
  // config field. `external_id`/`id` are stable across the tracker; the
  // file's own stem is the canonical prefix for THAT card. This makes
  // the reader robust to mixed-prefix repos AND to stale cached
  // `loadIssuePrefix` values inside long-running dashboard processes.
  // A rogue filename (no stem-shape match) is a real disk anomaly →
  // throw, no silent skip.
  const stem = path.split("/").pop()!.replace(/\.yml$/, "");
  const match = STEM_SHAPE.exec(stem);
  if (!match) {
    throw new Error(
      `readIssueFile: rogue filename "${stem}.yml" at ${path} — stem must match ${STEM_SHAPE}.`,
    );
  }
  // parseIssue throws on schema / id-shape / prefix mismatch. Let it
  // propagate — corrupt YAML in the issues tree is operator-fix
  // territory, never silent-skip territory.
  const issue = parseIssue(text, { expectedPrefix: match[1]! });
  return { issue, mtimeMs, text };
}

async function listYamlNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((n) => n.endsWith(".yml"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT = the issues subtree doesn't exist yet (fresh repo). Anything
    // else (EACCES, EIO, ENOTDIR) is real and would otherwise render as
    // "no issues" silently — surface it once per dir.
    if (code !== "ENOENT" && !warnedPaths.has(dir)) {
      warnedPaths.add(dir);
      log.warn(
        `Failed to list ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return [];
  }
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
  };
}

/**
 * List every parseable Issue under `<repoCwd>/.danxbot/issues/{open,closed}/*.yml`.
 *
 * - Malformed / unreadable YAMLs are skipped with a single warn log per path.
 * - Closed cap: `recent` (default) returns the 50 newest by mtime; `all`
 *   returns every closed file.
 * - Final list is sorted by `updated_at` (mtime ms) descending.
 */
export async function listIssues(
  repoCwd: string,
  opts: { includeClosed: "recent" | "all" } = { includeClosed: "recent" },
): Promise<IssueListItem[]> {
  const openDir = join(repoCwd, ".danxbot", "issues", "open");
  const closedDir = join(repoCwd, ".danxbot", "issues", "closed");

  const [openNames, closedNames] = await Promise.all([
    listYamlNames(openDir),
    listYamlNames(closedDir),
  ]);

  const openRaw = (
    await Promise.all(openNames.map((n) => readIssueFile(join(openDir, n))))
  ).filter((r): r is RawIssue => r !== null);

  const closedRaw = (
    await Promise.all(closedNames.map((n) => readIssueFile(join(closedDir, n))))
  ).filter((r): r is RawIssue => r !== null);

  // Sort closed by mtime BEFORE slicing — the cap (50) is "newest 50",
  // so the slice is correctness-bound, not cosmetic. The combined `all`
  // is sorted again below to interleave open + closed by mtime.
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
    for (const r of openRaw) {
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

  const all = [...openRaw, ...closedSlice];
  // Build an id → Issue map across BOTH open + closed so parents can
  // resolve their `children[]` ids regardless of where each child lives.
  const byId = new Map<string, Issue>();
  for (const r of all) byId.set(r.issue.id, r.issue);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all.map((r) => toListItem(r, byId));
}

/**
 * Read a single issue by `ISS-N` from `<repoCwd>/.danxbot/issues/{open,closed}/<id>.yml`.
 * Returns null when neither file exists or when the file is malformed.
 */
export async function readIssueDetail(
  repoCwd: string,
  id: string,
): Promise<IssueDetail | null> {
  for (const sub of ["open", "closed"] as const) {
    const path = join(repoCwd, ".danxbot", "issues", sub, `${id}.yml`);
    const raw = await readIssueFile(path);
    if (raw) {
      return { ...raw.issue, updated_at: raw.mtimeMs, raw_yaml: raw.text };
    }
  }
  return null;
}
