import type { IssueStatus, IssueType } from "../../types";
import type { PhaseStatusId } from "@backend/dashboard/issues-reader.js";

/** Lowercase column id used by the design system. */
export type ColumnId =
  | "review"
  | "todo"
  | "in_progress"
  | "needs_help"
  | "needs_approval"
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

interface PhaseStatusMeta {
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
 * Status palette for child cards (epic phases or non-epic sub-cards). The
 * backend's `IssueListChild.status` is one of `done | todo | blocked`,
 * derived from each child's own `Issue.status` + `Issue.blocked` per
 * `projectChildStatus` in `src/dashboard/issues-reader.ts`.
 */
export const PHASE_STATUS_META: Record<PhaseStatusId, PhaseStatusMeta> = {
  done:    { fg: "#6ee7b7", bg: "rgb(16 185 129 / 0.18)", glyph: "✓" },
  todo:    { fg: "#cbd5e1", bg: "rgb(51 65 85 / 0.40)",   glyph: "○" },
  blocked: { fg: "#fca5a5", bg: "rgb(239 68 68 / 0.18)",  glyph: "⛔" },
};

export const COLUMN_ACCENTS: Record<IssueStatus, ColumnAccent> = {
  "Review":      { id: "review",      label: "Review",      accent: "#a78bfa", collapsedByDefault: false },
  "ToDo":        { id: "todo",        label: "To Do",       accent: "#64748b", collapsedByDefault: false },
  "In Progress": { id: "in_progress", label: "In Progress", accent: "#fcd34d", collapsedByDefault: false },
  "Needs Help":  { id: "needs_help",  label: "Needs Help",  accent: "#ef4444", collapsedByDefault: false },
  "Needs Approval": { id: "needs_approval", label: "Needs Approval", accent: "#f59e0b", collapsedByDefault: false },
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

