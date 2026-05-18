import { reactive, watch } from "vue";
import type { IssueListItem } from "../types";

export type BoardSortKey =
  | "dispatch"
  | "created"
  | "updated"
  | "type"
  | "id"
  | "title";

export type BoardSortDirection = "asc" | "desc";

export interface BoardColumnSort {
  key: BoardSortKey;
  direction: BoardSortDirection;
}

export const BOARD_SORT_OPTIONS: { key: BoardSortKey; label: string }[] = [
  { key: "dispatch", label: "Priority order" },
  { key: "created", label: "Created at" },
  { key: "updated", label: "Updated at" },
  { key: "type", label: "Type" },
  { key: "id", label: "Card ID" },
  { key: "title", label: "Title" },
];

export const DEFAULT_BOARD_SORT: BoardColumnSort = {
  key: "dispatch",
  direction: "asc",
};

const STORAGE_KEY = "danxbot.issueBoard.sort.v1";

function readStored(): Record<string, BoardColumnSort> {
  if (typeof localStorage === "undefined") return {};
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, BoardColumnSort> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const sort = v as Partial<BoardColumnSort>;
    if (!isSortKey(sort.key) || !isDirection(sort.direction)) continue;
    out[k] = { key: sort.key, direction: sort.direction };
  }
  return out;
}

function isSortKey(v: unknown): v is BoardSortKey {
  return (
    typeof v === "string" &&
    BOARD_SORT_OPTIONS.some((o) => o.key === v)
  );
}

function isDirection(v: unknown): v is BoardSortDirection {
  return v === "asc" || v === "desc";
}

function idNumeric(id: string): number {
  const m = id.match(/-(\d+)$/);
  return m ? Number(m[1]) : Number.NaN;
}

function compare(a: IssueListItem, b: IssueListItem, key: BoardSortKey): number {
  switch (key) {
    case "created":
      return (a.created_at ?? 0) - (b.created_at ?? 0);
    case "updated":
      return (a.updated_at ?? 0) - (b.updated_at ?? 0);
    case "type":
      return a.type.localeCompare(b.type);
    case "id": {
      const an = idNumeric(a.id);
      const bn = idNumeric(b.id);
      if (Number.isNaN(an) || Number.isNaN(bn)) return a.id.localeCompare(b.id);
      return an - bn;
    }
    case "title":
      return a.title.localeCompare(b.title);
    case "dispatch":
      return 0;
  }
}

export function sortIssuesBy(
  issues: IssueListItem[],
  sort: BoardColumnSort,
): IssueListItem[] {
  if (sort.key === "dispatch") return issues;
  const sign = sort.direction === "desc" ? -1 : 1;
  const indexed = issues.map((iss, idx) => ({ iss, idx }));
  indexed.sort((a, b) => {
    const c = compare(a.iss, b.iss, sort.key);
    if (c !== 0) return sign * c;
    return a.idx - b.idx;
  });
  return indexed.map((e) => e.iss);
}

export interface BoardSortApi {
  state: Record<string, BoardColumnSort>;
  getSort(columnKey: string): BoardColumnSort;
  setSort(columnKey: string, sort: BoardColumnSort): void;
  resetSort(columnKey: string): void;
  isDefault(columnKey: string): boolean;
  sortedIssues(columnKey: string, issues: IssueListItem[]): IssueListItem[];
}

export function useBoardSort(): BoardSortApi {
  const state = reactive<Record<string, BoardColumnSort>>(readStored());

  watch(
    state,
    (next) => {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    },
    { deep: true },
  );

  function getSort(columnKey: string): BoardColumnSort {
    return state[columnKey] ?? DEFAULT_BOARD_SORT;
  }

  function setSort(columnKey: string, sort: BoardColumnSort): void {
    state[columnKey] = { key: sort.key, direction: sort.direction };
  }

  function resetSort(columnKey: string): void {
    delete state[columnKey];
  }

  function isDefault(columnKey: string): boolean {
    const s = state[columnKey];
    return !s || s.key === "dispatch";
  }

  function sortedIssues(
    columnKey: string,
    issues: IssueListItem[],
  ): IssueListItem[] {
    return sortIssuesBy(issues, getSort(columnKey));
  }

  return { state, getSort, setSort, resetSort, isDefault, sortedIssues };
}
