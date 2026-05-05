import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  Issue,
  IssueStatus,
  IssueType,
  PhaseStatus,
} from "../issue-tracker/interface.js";
import { parseIssue } from "../issue-tracker/yaml.js";
import { createLogger } from "../logger.js";

const log = createLogger("issues-reader");

/** Phase status id used by the design system's PHASE_STATUS_META palette. */
export type PhaseStatusId = "done" | "todo" | "blocked";

const PHASE_STATUS_TO_ID: Record<PhaseStatus, PhaseStatusId> = {
  Complete: "done",
  Pending: "todo",
  Blocked: "blocked",
};

/** Slim phase entry on the list shape — name + design-cased status id. */
export interface IssueListPhase {
  name: string;
  status: PhaseStatusId;
}

/**
 * List-card projection of an Issue. Sized for the Issues-tab board view —
 * AC / phase / comment counts are pre-rolled so the SPA can render the
 * card without a per-row detail fetch. `phases[]` is included on epics
 * so the board can render the per-phase checklist without a detail fetch.
 */
export interface IssueListItem {
  id: string;
  type: IssueType;
  title: string;
  status: IssueStatus;
  parent_id: string | null;
  children: string[];
  ac_total: number;
  ac_done: number;
  phases_total: number;
  phases_done: number;
  /** Present only when `type === "Epic"`. Empty array = epic with no phases. */
  phases?: IssueListPhase[];
  blocked: boolean;
  /** Set when `blocked === true`; null otherwise. Surfaces blocker reason on the card without a detail fetch. */
  blocked_reason: string | null;
  comments_count: number;
  has_retro: boolean;
  updated_at: number;
}

/** Full Issue plus the file's mtime in ms. */
export type IssueDetail = Issue & { updated_at: number };

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
}

async function readIssueFile(path: string): Promise<RawIssue | null> {
  let mtimeMs: number;
  let text: string;
  try {
    const s = await stat(path);
    mtimeMs = s.mtimeMs;
    text = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is the normal "no such issue" path for detail lookups; do not
    // pollute logs with it. Anything else (EACCES, EIO, etc.) is real.
    if (code !== "ENOENT" && !warnedPaths.has(path)) {
      warnedPaths.add(path);
      log.warn(
        `Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
  try {
    const issue = parseIssue(text);
    return { issue, mtimeMs };
  } catch (err) {
    if (!warnedPaths.has(path)) {
      warnedPaths.add(path);
      log.warn(
        `Skipping malformed issue YAML ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
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

function toListItem(raw: RawIssue): IssueListItem {
  const { issue, mtimeMs } = raw;
  const isEpic = issue.type === "Epic";
  return {
    id: issue.id,
    type: issue.type,
    title: issue.title,
    status: issue.status,
    parent_id: issue.parent_id,
    children: [...issue.children],
    ac_total: issue.ac.length,
    ac_done: issue.ac.filter((a) => a.checked).length,
    phases_total: issue.phases.length,
    phases_done: issue.phases.filter((p) => p.status === "Complete").length,
    ...(isEpic
      ? {
          phases: issue.phases.map((p) => ({
            name: p.title,
            status: PHASE_STATUS_TO_ID[p.status],
          })),
        }
      : {}),
    blocked: issue.blocked !== null,
    blocked_reason: issue.blocked?.reason ?? null,
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
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all.map(toListItem);
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
      return { ...raw.issue, updated_at: raw.mtimeMs };
    }
  }
  return null;
}
