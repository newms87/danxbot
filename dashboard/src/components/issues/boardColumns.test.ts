import { describe, it, expect } from "vitest";
import type { IssueListItem, IssueStatus, List } from "../../types";
import {
  RECENT_DONE_WINDOW_MS,
  ladderIdx,
  orderColumns,
  buildDefaultByType,
  listForIssue,
  isCompletedRecent,
  groupIssuesByColumns,
  testIdFor,
  buildColumnRows,
} from "./boardColumns";

const SEED_LISTS: List[] = [
  { id: "lst-arc", name: "Backlog",     type: "archived",    order: 0, is_default_for_type: true, color: "#64748b" },
  { id: "lst-rev", name: "Review",      type: "review",      order: 1, is_default_for_type: true, color: "#3b82f6" },
  { id: "lst-rdy", name: "To Do",       type: "ready",       order: 2, is_default_for_type: true, color: "#22d3ee" },
  { id: "lst-wip", name: "In Progress", type: "in_progress", order: 4, is_default_for_type: true, color: "#f59e0b" },
  { id: "lst-don", name: "Done",        type: "completed",   order: 5, is_default_for_type: true, color: "#22c55e" },
  { id: "lst-cnl", name: "Cancelled",   type: "cancelled",   order: 6, is_default_for_type: true, color: "#71717a" },
];

function makeIssue(
  id: string,
  status: IssueStatus,
  overrides: Partial<IssueListItem> = {},
): IssueListItem {
  return {
    id,
    title: `Card ${id}`,
    description: "",
    status,
    type: "Feature",
    priority: 1000,
    list_name: null,
    parent_id: null,
    children: [],
    blocked: null,
    waiting_on: null,
    requires_human: null,
    conflict_on: [],
    assigned_agent: null,
    dispatch: null,
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    updated_at: Math.floor(Date.now() / 1000),
    db_updated_at: new Date().toISOString(),
    ...overrides,
  } as IssueListItem;
}

describe("ladderIdx", () => {
  it("returns ladder position for known type", () => {
    expect(ladderIdx("archived")).toBe(0);
    expect(ladderIdx("review")).toBe(1);
    expect(ladderIdx("cancelled")).toBe(5);
  });
  it("returns end index for unknown type", () => {
    // @ts-expect-error — testing defensive branch
    expect(ladderIdx("unknown-type")).toBe(6);
  });
});

describe("orderColumns", () => {
  it("orders by ladder, then by `order`, then by name", () => {
    const out = orderColumns(SEED_LISTS, true);
    expect(out.map((l) => l.name)).toEqual([
      "Backlog", "Review", "To Do", "In Progress", "Done", "Cancelled",
    ]);
  });
  it("breaks ladder ties by `order`", () => {
    const lists: List[] = [
      { id: "a", name: "Sprint 2", type: "archived", order: 2, is_default_for_type: false, color: "#000" },
      { id: "b", name: "Sprint 1", type: "archived", order: 1, is_default_for_type: false, color: "#000" },
      { id: "c", name: "Sprint 3", type: "archived", order: 3, is_default_for_type: true, color: "#000" },
    ];
    expect(orderColumns(lists, true).map((l) => l.name)).toEqual(["Sprint 1", "Sprint 2", "Sprint 3"]);
  });
  it("falls back to name when ladder + order tie", () => {
    const lists: List[] = [
      { id: "a", name: "Zeta",  type: "review", order: 1, is_default_for_type: false, color: "#000" },
      { id: "b", name: "Alpha", type: "review", order: 1, is_default_for_type: true, color: "#000" },
    ];
    expect(orderColumns(lists, true).map((l) => l.name)).toEqual(["Alpha", "Zeta"]);
  });
  it("drops cancelled columns when showClosed=false", () => {
    const names = orderColumns(SEED_LISTS, false).map((l) => l.name);
    expect(names).not.toContain("Cancelled");
    expect(names).toContain("Done");
  });
  it("keeps cancelled columns when showClosed=true", () => {
    const names = orderColumns(SEED_LISTS, true).map((l) => l.name);
    expect(names).toContain("Cancelled");
  });
  it("does not mutate input", () => {
    const original = [...SEED_LISTS];
    orderColumns(SEED_LISTS, false);
    expect(SEED_LISTS).toEqual(original);
  });
});

describe("buildDefaultByType", () => {
  it("maps each type to its default list", () => {
    const m = buildDefaultByType(SEED_LISTS);
    expect(m.get("archived")?.name).toBe("Backlog");
    expect(m.get("completed")?.name).toBe("Done");
    expect(m.size).toBe(6);
  });
  it("ignores non-default lists", () => {
    const extra: List[] = [
      ...SEED_LISTS,
      { id: "lst-arc2", name: "Sprint 1", type: "archived", order: 7, is_default_for_type: false, color: "#000" },
    ];
    expect(buildDefaultByType(extra).get("archived")?.name).toBe("Backlog");
  });
});

describe("listForIssue", () => {
  it("resolves a card to its type's default list", () => {
    const m = buildDefaultByType(SEED_LISTS);
    expect(listForIssue(makeIssue("a", "Done"), m)?.name).toBe("Done");
    expect(listForIssue(makeIssue("b", "In Progress"), m)?.name).toBe("In Progress");
    expect(listForIssue(makeIssue("c", "Review"), m)?.name).toBe("Review");
  });
  it("returns null when no default exists for the projected type", () => {
    const m = buildDefaultByType(SEED_LISTS.filter((l) => l.type !== "completed"));
    expect(listForIssue(makeIssue("a", "Done"), m)).toBeNull();
  });
});

describe("isCompletedRecent", () => {
  const NOW = 1_700_000_000_000;
  it("returns true when within window", () => {
    const updated = (NOW - 60_000) / 1000;
    expect(isCompletedRecent(updated, NOW)).toBe(true);
  });
  it("returns false when outside window", () => {
    const updated = (NOW - RECENT_DONE_WINDOW_MS - 1) / 1000;
    expect(isCompletedRecent(updated, NOW)).toBe(false);
  });
  it("inclusive at the boundary", () => {
    const updated = (NOW - RECENT_DONE_WINDOW_MS) / 1000;
    expect(isCompletedRecent(updated, NOW)).toBe(true);
  });
  it("honors a custom windowMs override", () => {
    const updated = (NOW - 5000) / 1000;
    expect(isCompletedRecent(updated, NOW, 10_000)).toBe(true);
    expect(isCompletedRecent(updated, NOW, 1000)).toBe(false);
  });
});

describe("groupIssuesByColumns", () => {
  const NOW = 1_700_000_000_000;
  it("buckets cards by derived column", () => {
    const cols = orderColumns(SEED_LISTS, true);
    const m = buildDefaultByType(SEED_LISTS);
    const issues = [
      makeIssue("a", "ToDo"),
      makeIssue("b", "In Progress"),
      makeIssue("c", "Done", { updated_at: Math.floor(NOW / 1000) }),
    ];
    const grouped = groupIssuesByColumns(issues, cols, m, true, NOW);
    expect(grouped["To Do"].map((i) => i.id)).toEqual(["a"]);
    expect(grouped["In Progress"].map((i) => i.id)).toEqual(["b"]);
    expect(grouped["Done"].map((i) => i.id)).toEqual(["c"]);
  });
  it("pre-seeds empty arrays for every column", () => {
    const cols = orderColumns(SEED_LISTS, true);
    const m = buildDefaultByType(SEED_LISTS);
    const grouped = groupIssuesByColumns([], cols, m, true, NOW);
    for (const col of cols) expect(grouped[col.name]).toEqual([]);
  });
  it("drops cancelled cards when showClosed=false", () => {
    const cols = orderColumns(SEED_LISTS, false);
    const m = buildDefaultByType(SEED_LISTS);
    const grouped = groupIssuesByColumns([makeIssue("x", "Cancelled")], cols, m, false, NOW);
    expect(grouped["Cancelled"]).toBeUndefined();
  });
  it("drops stale completed cards when showClosed=false", () => {
    const cols = orderColumns(SEED_LISTS, false);
    const m = buildDefaultByType(SEED_LISTS);
    const stale = makeIssue("old", "Done", {
      updated_at: Math.floor((NOW - RECENT_DONE_WINDOW_MS - 1000) / 1000),
    });
    const recent = makeIssue("new", "Done", { updated_at: Math.floor(NOW / 1000) });
    const grouped = groupIssuesByColumns([stale, recent], cols, m, false, NOW);
    expect(grouped["Done"].map((i) => i.id)).toEqual(["new"]);
  });
  it("keeps stale completed cards when showClosed=true", () => {
    const cols = orderColumns(SEED_LISTS, true);
    const m = buildDefaultByType(SEED_LISTS);
    const stale = makeIssue("old", "Done", {
      updated_at: Math.floor((NOW - RECENT_DONE_WINDOW_MS - 1000) / 1000),
    });
    const grouped = groupIssuesByColumns([stale], cols, m, true, NOW);
    expect(grouped["Done"].map((i) => i.id)).toEqual(["old"]);
  });
  it("lazy-creates a bucket when dest is outside the passed columns", () => {
    // Edge case: dest column resolved from defaultByType but absent from
    // the `columns` arg (operator hid the cancelled column from the
    // taxonomy view but the type's default still resolves).
    const cols = orderColumns(SEED_LISTS.filter((l) => l.type !== "cancelled"), true);
    const m = buildDefaultByType(SEED_LISTS);
    const grouped = groupIssuesByColumns([makeIssue("x", "Cancelled")], cols, m, true, NOW);
    expect(grouped["Cancelled"]).toEqual([expect.objectContaining({ id: "x" })]);
  });
  it("silently drops cards whose projected type has no default", () => {
    const cols = orderColumns(SEED_LISTS.filter((l) => l.type !== "completed"), true);
    const m = buildDefaultByType(SEED_LISTS.filter((l) => l.type !== "completed"));
    const grouped = groupIssuesByColumns([makeIssue("x", "Done")], cols, m, true, NOW);
    expect(Object.values(grouped).flat()).toEqual([]);
  });
});

describe("testIdFor", () => {
  it("lowercases + kebabs alphanumerics", () => {
    expect(testIdFor("In Progress")).toBe("in-progress");
    expect(testIdFor("Sprint 1 Backlog")).toBe("sprint-1-backlog");
  });
  it("trims leading/trailing separators", () => {
    expect(testIdFor("  Done!  ")).toBe("done");
  });
  it("collapses runs of non-alphanumerics", () => {
    expect(testIdFor("a // b  c")).toBe("a-b-c");
  });
  it("returns empty string for empty or all-non-alphanumeric input", () => {
    expect(testIdFor("")).toBe("");
    expect(testIdFor("!!!")).toBe("");
  });
});

describe("buildColumnRows", () => {
  it("emits head slot + interleaved card/slot pairs", () => {
    const a = makeIssue("a", "ToDo");
    const b = makeIssue("b", "ToDo");
    const rows = buildColumnRows("col-1", [a, b]);
    expect(rows.map((r) => r.kind)).toEqual(["slot", "card", "slot", "card", "slot"]);
    expect((rows[0] as { kind: "slot"; before: unknown; after: { id: string } }).after.id).toBe("a");
    expect((rows[2] as { before: { id: string }; after: { id: string } }).before.id).toBe("a");
    expect((rows[2] as { before: { id: string }; after: { id: string } }).after.id).toBe("b");
    expect((rows[4] as { before: { id: string }; after: null }).after).toBeNull();
  });
  it("emits a single head/tail slot for an empty column", () => {
    const rows = buildColumnRows("col-x", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "slot", before: null, after: null });
    expect(rows[0].key).toBe("slot:col-x:head:tail");
  });
  it("produces stable card keys + neighbor-keyed slot keys", () => {
    const a = makeIssue("a", "ToDo");
    const b = makeIssue("b", "ToDo");
    const rows = buildColumnRows("col-1", [a, b]);
    expect(rows[1].key).toBe("card:a");
    expect(rows[2].key).toBe("slot:col-1:a:b");
    expect(rows[3].key).toBe("card:b");
    expect(rows[4].key).toBe("slot:col-1:b:tail");
  });
});
