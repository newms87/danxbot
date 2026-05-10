import type { IssueStatus, IssueType } from "../../types";

/**
 * Child-status palette key used by `CHILD_STATUS_META`. Owned by the SPA
 * because the palette is a 5-color design-system decision: Cancelled is
 * conflated with Done; `waiting` is the dep-chain queue rendered as a
 * yellow ⏸ glyph; `blocked` is self-block (status === "Blocked")
 * rendered as a red ⛔ glyph; `in_progress` distinguishes a child
 * currently being worked on (amber ◐ glyph) from idle ToDo / Review
 * siblings. DX-231 retired the legacy `Needs Approval` status; the
 * orthogonal `requires_human` field will get its own indicator in
 * Phase 8 of the epic.
 */
export type ChildStatusId =
  | "done"
  | "todo"
  | "in_progress"
  | "blocked"
  | "waiting";

/**
 * Project a child issue's raw `(status, waiting_on)` into the
 * `done | todo | in_progress | blocked | waiting` palette key.
 *
 *  - Done / Cancelled                                     → "done"
 *  - status === "Blocked"                                 → "blocked"
 *  - waiting_on === true                                  → "waiting"
 *  - status === "In Progress"                             → "in_progress"
 *  - Anything else (Review, ToDo)                         → "todo"
 *
 * Done / Cancelled win over a self-block because both are terminal — a
 * card cannot be "blocked" once shipped or dropped. Self-block beats
 * waiting-on because a card stuck on its own work is a stronger signal
 * than queued-behind-deps. Waiting beats In Progress so a child queued
 * behind a dep doesn't masquerade as actively running.
 */
export function projectChildStatus(
  status: IssueStatus,
  waitingOn: boolean,
  waitingOnByCard: boolean = false,
): ChildStatusId {
  if (status === "Done" || status === "Cancelled") return "done";
  if (status === "Blocked") return "blocked";
  if (waitingOnByCard || waitingOn) return "waiting";
  if (status === "In Progress") return "in_progress";
  return "todo";
}

/** Lowercase column id used by the design system. */
export type ColumnId =
  | "review"
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled";

/** Lowercase type id used by the design system's palette lookup. */
export type IssueTypeId = "epic" | "bug" | "feature";

interface TypeMeta {
  label: string;
  fg: string;
  bg: string;
  border: string;
}

interface ChildStatusMeta {
  fg: string;
  bg: string;
  glyph: string;
}

interface ColumnAccent {
  id: ColumnId;
  label: string;
  accent: string;
  collapsedByDefault: boolean;
}

export const ISSUE_TYPE_META: Record<IssueTypeId, TypeMeta> = {
  epic:    { label: "Epic",    fg: "#a5b4fc", bg: "rgb(99 102 241 / 0.15)", border: "rgb(99 102 241 / 0.35)" },
  bug:     { label: "Bug",     fg: "#fca5a5", bg: "rgb(239 68 68 / 0.15)",  border: "rgb(239 68 68 / 0.35)" },
  feature: { label: "Feature", fg: "#86efac", bg: "rgb(16 185 129 / 0.15)", border: "rgb(16 185 129 / 0.35)" },
};

/**
 * Status palette for child cards (epic phases or non-epic sub-cards).
 * The wire shape `IssueListChild` carries the child's raw `status` +
 * `blocked` flag; consumers project them into a `ChildStatusId` via
 * `projectChildStatus` (above) before indexing this map.
 */
export const CHILD_STATUS_META: Record<ChildStatusId, ChildStatusMeta> = {
  done:        { fg: "#6ee7b7", bg: "rgb(16 185 129 / 0.18)", glyph: "✓" },
  todo:        { fg: "#cbd5e1", bg: "rgb(51 65 85 / 0.40)",   glyph: "○" },
  in_progress: { fg: "#fcd34d", bg: "rgb(245 158 11 / 0.18)", glyph: "◐" },
  blocked:     { fg: "#fca5a5", bg: "rgb(239 68 68 / 0.18)",  glyph: "⛔" },
  waiting:     { fg: "#fcd34d", bg: "rgb(245 158 11 / 0.20)", glyph: "⏸" },
};

export const COLUMN_ACCENTS: Record<IssueStatus, ColumnAccent> = {
  "Review":      { id: "review",      label: "Review",      accent: "#a78bfa", collapsedByDefault: false },
  "ToDo":        { id: "todo",        label: "To Do",       accent: "#64748b", collapsedByDefault: false },
  "In Progress": { id: "in_progress", label: "In Progress", accent: "#fcd34d", collapsedByDefault: false },
  "Blocked":     { id: "blocked",     label: "Blocked",     accent: "#ef4444", collapsedByDefault: false },
  "Done":        { id: "done",        label: "Done",        accent: "#10b981", collapsedByDefault: true  },
  "Cancelled":   { id: "cancelled",   label: "Cancelled",   accent: "#475569", collapsedByDefault: true  },
};

const TYPE_TO_ID: Record<IssueType, IssueTypeId> = {
  Epic: "epic",
  Bug: "bug",
  Feature: "feature",
};

export function statusToColumnId(status: IssueStatus): ColumnId {
  return COLUMN_ACCENTS[status].id;
}

export function typeToId(type: IssueType): IssueTypeId {
  return TYPE_TO_ID[type];
}

