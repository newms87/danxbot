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
 * status + raw blocked flag + missing flag. The SPA projects
 * `(status, blocked)` into its design-system `done | todo | blocked`
 * palette via `projectChildStatus` in
 * `dashboard/src/components/issues/issuePalette.ts`. `missing` is true
 * when the child id was referenced but no Issue was loaded (e.g. closed
 * beyond the recent-50 cap, or genuinely orphaned); the SPA renders
 * such rows with the unknown placeholder name. Used for both epic
 * phases and non-epic sub-cards (the shape is identical; the SPA
 * relabels the section header per parent type).
 */
export interface IssueListChild {
  id: string;
  name: string;
  type: IssueType;
  status: IssueStatus;
  blocked: boolean;
  /**
   * True when the child's `blocked.by[]` is non-empty — i.e. the child
   * is waiting on another card, not on a human / external. Drives the
   * yellow ⏸ glyph variant in the children checklist; plain `blocked`
   * (no card refs) keeps the red ⛔ variant.
   */
  blocked_by_card: boolean;
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
  blocked: boolean;
  /** Set when `blocked === true`; null otherwise. Surfaces blocker reason on the card without a detail fetch. */
  blocked_reason: string | null;
  /** Issue ids (`ISS-N[]`) this card is waiting on. Empty when `blocked === false` OR when the block has no by[] (rare — schema requires `by[]` non-empty when `blocked` set, but defensive default is `[]`). */
  blocked_by: string[];
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
        // Surface as blocked so the SPA's projection routes the row
        // into the red ⛔ chip — visually distinct from a real ToDo
        // child. `missing: true` is the canonical discriminator.
        return {
          id: cid,
          name: `<${cid}: unknown>`,
          type: "Feature" as IssueType,
          status: "ToDo" as IssueStatus,
          blocked: true,
          blocked_by_card: false,
          missing: true,
        };
      }
      return {
        id: cid,
        name: child.title,
        type: child.type,
        status: child.status,
        blocked: child.blocked !== null,
        blocked_by_card:
          child.blocked !== null && child.blocked.by.length > 0,
        missing: false,
      };
    });
  // Epics are not "blocked" by their own children — the children ARE
  // the epic's completion criteria. If every blocker on the epic is
  // one of its own children, the projection drops the blocked state
  // entirely so the board doesn't render the epic with a ⛔ pill that
  // misrepresents the relationship. External blockers (other epics,
  // unrelated cards) still surface as normal.
  const childSet = new Set(issue.children);
  const isEpic = issue.type === "Epic";
  const rawBy = issue.blocked?.by ?? [];
  const externalBy = isEpic ? rawBy.filter((id) => !childSet.has(id)) : rawBy;
  const epicSelfBlocked =
    isEpic &&
    issue.blocked !== null &&
    rawBy.length > 0 &&
    externalBy.length === 0;

  // Inherited block: an epic with at least one Blocked, In Progress
  // (Needs Help / Needs Approval / blocked-record) child surfaces on
  // the board in the Blocked column with a yellow ⏸ "Blocked by"
  // banner listing those children. The epic's own status field stays
  // untouched in the YAML — this is purely a read-side projection so
  // the operator sees the impedance immediately without waiting for
  // the agent to stamp `blocked` on the epic.
  const blockedChildIds = isEpic
    ? childrenDetail
        .filter((c) =>
          c.blocked || c.status === "Needs Help" || c.status === "Needs Approval",
        )
        .map((c) => c.id)
    : [];
  const inheritedBlock = isEpic && blockedChildIds.length > 0;

  let projectedStatus: IssueStatus = issue.status;
  let projectedBlocked = issue.blocked !== null && !epicSelfBlocked;
  let projectedBlockedReason: string | null = epicSelfBlocked
    ? null
    : issue.blocked?.reason ?? null;
  let projectedBlockedBy = externalBy;
  if (inheritedBlock) {
    // Don't override Done / Cancelled — those are terminal regardless
    // of stragglers. In Progress / ToDo / Review get pulled to Needs
    // Help so the epic surfaces in the Blocked column.
    if (
      issue.status !== "Done" &&
      issue.status !== "Cancelled" &&
      issue.status !== "Needs Help"
    ) {
      projectedStatus = "Needs Help";
    }
    projectedBlocked = true;
    projectedBlockedBy = blockedChildIds;
    projectedBlockedReason =
      `Waiting on ${blockedChildIds.length} blocked child` +
      (blockedChildIds.length === 1 ? "" : "ren") +
      `: ${blockedChildIds.join(", ")}.`;
  }

  return {
    id: issue.id,
    type: issue.type,
    title: issue.title,
    description: issue.description,
    status: projectedStatus,
    parent_id: issue.parent_id,
    children: [...issue.children],
    ac_total: issue.ac.length,
    ac_done: issue.ac.filter((a) => a.checked).length,
    children_detail: childrenDetail,
    blocked: projectedBlocked,
    blocked_reason: projectedBlockedReason,
    blocked_by: projectedBlockedBy,
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
  const closedSlice =
    opts.includeClosed === "all"
      ? closedRaw
      : closedRaw.slice(0, DEFAULT_CLOSED_LIMIT);

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
      const issue = applyEpicBlockedProjection(raw.issue);
      return { ...issue, updated_at: raw.mtimeMs, raw_yaml: raw.text };
    }
  }
  return null;
}

/**
 * Strip the `blocked` block from epics that are blocked solely by
 * their own children. Mirrors the projection in `toListItem` so the
 * drawer (which reads the full `Issue` shape) doesn't render a ⛔
 * panel that contradicts the board card.
 */
function applyEpicBlockedProjection(issue: Issue): Issue {
  if (issue.type !== "Epic" || issue.blocked === null) return issue;
  const childSet = new Set(issue.children);
  const externalBy = issue.blocked.by.filter((id) => !childSet.has(id));
  if (issue.blocked.by.length > 0 && externalBy.length === 0) {
    return { ...issue, blocked: null };
  }
  if (externalBy.length !== issue.blocked.by.length) {
    return { ...issue, blocked: { ...issue.blocked, by: externalBy } };
  }
  return issue;
}
