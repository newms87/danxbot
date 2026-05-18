import { describe, it, expect, beforeEach } from "vitest";
import { nextTick } from "vue";
import {
  useBoardSort,
  sortIssuesBy,
  DEFAULT_BOARD_SORT,
} from "./useBoardSort";
import type { IssueListItem } from "../types";

function issue(
  id: string,
  overrides: Partial<IssueListItem> = {},
): IssueListItem {
  return {
    id,
    title: `Card ${id}`,
    description: "",
    status: "ToDo",
    type: "Feature",
    priority: 3,
    assigned_agent: null,
    parent_id: null,
    children: [],
    children_detail: [],
    ac_done: 0,
    ac_total: 0,
    has_retro: false,
    comments_count: 0,
    waiting_on: false,
    waiting_on_reason: null,
    waiting_on_by: [],
    blocked: null,
    requires_human: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as unknown as IssueListItem;
}

describe("useBoardSort — defaults + persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to dispatch/asc when localStorage is empty", () => {
    const sort = useBoardSort();
    expect(sort.getSort("todo")).toEqual(DEFAULT_BOARD_SORT);
    expect(sort.isDefault("todo")).toBe(true);
  });

  it("setSort persists to localStorage under the versioned key", async () => {
    const sort = useBoardSort();
    sort.setSort("review", { key: "created", direction: "desc" });
    await nextTick();
    const raw = localStorage.getItem("danxbot.issueBoard.sort.v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.review).toEqual({ key: "created", direction: "desc" });
  });

  it("hydrates per-column sort from localStorage on construction", () => {
    localStorage.setItem(
      "danxbot.issueBoard.sort.v1",
      JSON.stringify({ todo: { key: "title", direction: "asc" } }),
    );
    const sort = useBoardSort();
    expect(sort.getSort("todo")).toEqual({ key: "title", direction: "asc" });
    expect(sort.isDefault("todo")).toBe(false);
  });

  it("ignores garbage / invalid sort entries in localStorage", () => {
    localStorage.setItem(
      "danxbot.issueBoard.sort.v1",
      JSON.stringify({
        todo: { key: "wat", direction: "asc" },
        review: { key: "title", direction: "sideways" },
      }),
    );
    const sort = useBoardSort();
    expect(sort.isDefault("todo")).toBe(true);
    expect(sort.isDefault("review")).toBe(true);
  });

  it("resetSort removes the column entry and reverts to default", async () => {
    const sort = useBoardSort();
    sort.setSort("todo", { key: "id", direction: "desc" });
    sort.resetSort("todo");
    await nextTick();
    expect(sort.isDefault("todo")).toBe(true);
    expect(sort.getSort("todo")).toEqual(DEFAULT_BOARD_SORT);
  });
});

describe("useBoardSort — independent columns", () => {
  beforeEach(() => localStorage.clear());

  it("setting sort on one column does not affect another", () => {
    const sort = useBoardSort();
    sort.setSort("todo", { key: "id", direction: "asc" });
    sort.setSort("review", { key: "title", direction: "desc" });
    expect(sort.getSort("todo")).toEqual({ key: "id", direction: "asc" });
    expect(sort.getSort("review")).toEqual({ key: "title", direction: "desc" });
  });
});

describe("sortIssuesBy", () => {
  it("dispatch returns the input order verbatim", () => {
    const a = issue("DX-5");
    const b = issue("DX-1");
    expect(sortIssuesBy([a, b], { key: "dispatch", direction: "asc" })).toEqual(
      [a, b],
    );
  });

  it("created ASC sorts oldest first", () => {
    const a = issue("DX-1", { created_at: 200 });
    const b = issue("DX-2", { created_at: 100 });
    const out = sortIssuesBy([a, b], { key: "created", direction: "asc" });
    expect(out.map((i) => i.id)).toEqual(["DX-2", "DX-1"]);
  });

  it("updated DESC sorts newest first", () => {
    const a = issue("DX-1", { updated_at: 200 });
    const b = issue("DX-2", { updated_at: 100 });
    const out = sortIssuesBy([a, b], { key: "updated", direction: "desc" });
    expect(out.map((i) => i.id)).toEqual(["DX-1", "DX-2"]);
  });

  it("id sorts by numeric DX-N suffix, not string compare", () => {
    const a = issue("DX-10");
    const b = issue("DX-2");
    const c = issue("DX-100");
    const out = sortIssuesBy([a, b, c], { key: "id", direction: "asc" });
    expect(out.map((i) => i.id)).toEqual(["DX-2", "DX-10", "DX-100"]);
  });

  it("type sorts alphabetically", () => {
    const a = issue("DX-1", { type: "Feature" as const });
    const b = issue("DX-2", { type: "Bug" as const });
    const c = issue("DX-3", { type: "Epic" as const });
    const out = sortIssuesBy([a, b, c], { key: "type", direction: "asc" });
    expect(out.map((i) => i.id)).toEqual(["DX-2", "DX-3", "DX-1"]);
  });

  it("title uses locale-compare", () => {
    const a = issue("DX-1", { title: "banana" });
    const b = issue("DX-2", { title: "apple" });
    const out = sortIssuesBy([a, b], { key: "title", direction: "asc" });
    expect(out.map((i) => i.id)).toEqual(["DX-2", "DX-1"]);
  });

  it("ties preserve input (stable) order", () => {
    const a = issue("DX-1", { created_at: 100 });
    const b = issue("DX-2", { created_at: 100 });
    const out = sortIssuesBy([a, b], { key: "created", direction: "asc" });
    expect(out.map((i) => i.id)).toEqual(["DX-1", "DX-2"]);
  });
});

describe("useBoardSort — no setInterval, no api import", () => {
  it("source has no setInterval and no api.ts import", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "useBoardSort.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/setInterval\s*\(/);
    expect(src).not.toMatch(/from\s+["']\.\.\/api["']/);
  });
});
