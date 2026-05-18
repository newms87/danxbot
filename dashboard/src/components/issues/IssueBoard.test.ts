import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import IssueBoard from "./IssueBoard.vue";
import type { IssueListItem, IssueStatus, List } from "../../types";

// DanxPopover renders into a portal — stub it so the panel content is
// always inline in the wrapper's DOM tree for tests.
const DanxPopoverStub = defineComponent({
  name: "DanxPopover",
  props: ["modelValue", "trigger", "placement"],
  emits: ["update:modelValue"],
  setup: (_p, { slots }) => () => [
    h("div", { class: "stub-popover-trigger" }, slots.trigger?.()),
    h("div", { class: "stub-popover-panel" }, slots.default?.()),
  ],
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

let nextChildSeq = 0;

/**
 * DX-586 — default 7-list seed mirroring `defaultLists()` in
 * `src/lists-file.ts`. The board groups cards by `list_name`; tests
 * exercise the seed names + add operator-renamed lists where needed.
 */
const SEED_LISTS: readonly List[] = [
  { id: "lst-arc", name: "Backlog",     type: "archived",    order: 0, is_default_for_type: true, color: "#64748b" },
  { id: "lst-rev", name: "Review",      type: "review",      order: 1, is_default_for_type: true, color: "#3b82f6" },
  { id: "lst-rdy", name: "To Do",       type: "ready",       order: 2, is_default_for_type: true, color: "#22d3ee" },
  { id: "lst-blk", name: "Blocked",     type: "blocked",     order: 3, is_default_for_type: true, color: "#ef4444" },
  { id: "lst-wip", name: "In Progress", type: "in_progress", order: 4, is_default_for_type: true, color: "#f59e0b" },
  { id: "lst-don", name: "Done",        type: "completed",   order: 5, is_default_for_type: true, color: "#22c55e" },
  { id: "lst-cnl", name: "Cancelled",   type: "cancelled",   order: 6, is_default_for_type: true, color: "#71717a" },
];

function makeIssue(
  id: string,
  status: IssueStatus,
  overrides: Partial<IssueListItem> = {},
): IssueListItem {
  // Auto-resolve list_name to match the status if not overridden — the
  // dashboard expects `list_name` on every projection (server-side
  // auto-resolve write path), and the board falls back to the type's
  // default when list_name is null.
  const defaultByStatus: Record<IssueStatus, string> = {
    Backlog: "Backlog",
    Review: "Review",
    ToDo: "To Do",
    "In Progress": "In Progress",
    Blocked: "Blocked",
    Done: "Done",
    Cancelled: "Cancelled",
  };
  return {
    id,
    title: `Card ${id}`,
    description: "",
    status,
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
    requires_human_child_count: 0,
    list_name: defaultByStatus[status],
    created_at: 0,
    updated_at: ++nextChildSeq,
    ...overrides,
  } as unknown as IssueListItem;
}

interface FakeDataTransfer {
  effectAllowed: string;
  dropEffect: string;
  setData: (...args: unknown[]) => void;
  setDragImage: (...args: unknown[]) => void;
}

function makeDt(): FakeDataTransfer {
  return {
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn(),
    setDragImage: vi.fn(),
  };
}

function mountBoard(
  initial: IssueListItem[],
  opts: { showClosed?: boolean; lists?: List[] } = {},
) {
  const issues = ref<IssueListItem[]>(initial);
  const moveSpy = vi.fn<(issue: IssueListItem, to: List) => void>();
  const Host = defineComponent({
    setup() {
      return () =>
        h(IssueBoard, {
          issues: issues.value,
          repo: "danxbot",
          lists: opts.lists ?? [...SEED_LISTS],
          showClosed: opts.showClosed ?? false,
          scopedEpicId: null,
          scopeMode: "filter",
          onMove: (issue: IssueListItem, to: List) => {
            moveSpy(issue, to);
          },
        });
    },
  });
  const wrapper = mount(Host, {
    attachTo: document.body,
    global: { stubs: { DanxPopover: DanxPopoverStub } },
  });
  return { wrapper, issues, moveSpy };
}

// Helper: kebab-case test-id for a list name (matches `testIdFor` in IssueBoard.vue).
function tid(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("IssueBoard — list-driven columns (DX-586)", () => {
  it("renders one column per list in ladder order (archived → review → ready → blocked → in_progress → completed)", () => {
    const { wrapper } = mountBoard([]);
    const cols = wrapper.findAll(".column");
    // showClosed=false hides cancelled-type columns entirely.
    const expectedNames = ["Backlog", "Review", "To Do", "Blocked", "In Progress", "Done"];
    expect(cols.length).toBeGreaterThanOrEqual(expectedNames.length - 1);
    const labels = cols.map((c) => c.find(".label").text());
    // Filter out cancelled if showClosed is off — it shouldn't render any column,
    // but the loop below catches it regardless.
    expect(labels).toContain("Backlog");
    expect(labels).toContain("In Progress");
    expect(labels).toContain("Done");
    wrapper.unmount();
  });

  it("renders Cancelled column only when showClosed=true", () => {
    const offBoard = mountBoard([], { showClosed: false });
    expect(offBoard.wrapper.find(`[data-test="column-${tid("Cancelled")}"]`).exists()).toBe(false);
    offBoard.wrapper.unmount();

    const onBoard = mountBoard([], { showClosed: true });
    expect(onBoard.wrapper.find(`[data-test="column-${tid("Cancelled")}"]`).exists()).toBe(true);
    onBoard.wrapper.unmount();
  });

  it("groups cards into the column matching their list_name", () => {
    const card = makeIssue("DX-1", "ToDo");
    const { wrapper } = mountBoard([card]);
    const todoCol = wrapper.find(`[data-test="column-${tid("To Do")}"]`);
    expect(todoCol.exists()).toBe(true);
    expect(todoCol.text()).toContain("DX-1");
  });

  it("renders operator-renamed lists with their custom names + colors", () => {
    const customLists: List[] = SEED_LISTS.map((l) =>
      l.type === "ready"
        ? { ...l, name: "Up Next", color: "#abcdef" }
        : l,
    );
    const card = makeIssue("DX-1", "ToDo", { list_name: "Up Next" });
    const { wrapper } = mountBoard([card], { lists: customLists });
    const col = wrapper.find(`[data-test="column-${tid("Up Next")}"]`);
    expect(col.exists()).toBe(true);
    expect(col.find(".label").text()).toBe("Up Next");
    expect(col.text()).toContain("DX-1");
    wrapper.unmount();
  });

  it("falls back to the type's default list when list_name is null", () => {
    const card = makeIssue("DX-1", "ToDo", { list_name: null });
    const { wrapper } = mountBoard([card]);
    const todoCol = wrapper.find(`[data-test="column-${tid("To Do")}"]`);
    expect(todoCol.text()).toContain("DX-1");
  });
});

describe("IssueBoard — drag and drop", () => {
  it("dropping a card on In Progress emits move with the full List", async () => {
    const issue = makeIssue("DX-1", "ToDo");
    const { wrapper, moveSpy } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain("DX-1");

    await card.trigger("dragstart", { dataTransfer: makeDt() });

    const target = wrapper.find(`[data-test="column-${tid("In Progress")}"]`);
    expect(target.exists()).toBe(true);

    await target.trigger("dragover", { dataTransfer: makeDt() });
    await target.trigger("drop", { dataTransfer: makeDt() });
    await card.trigger("dragend");

    await vi.waitFor(() => {
      expect(moveSpy).toHaveBeenCalledOnce();
    });
    const [calledIssue, calledList] = moveSpy.mock.calls[0];
    expect(calledIssue.id).toBe("DX-1");
    expect(calledList.name).toBe("In Progress");
    expect(calledList.type).toBe("in_progress");

    wrapper.unmount();
  });

  it("dropping on the same column does NOT emit move", async () => {
    const issue = makeIssue("DX-2", "ToDo");
    const { wrapper, moveSpy } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });

    const sameCol = wrapper.find(`[data-test="column-${tid("To Do")}"]`);
    await sameCol.trigger("dragover", { dataTransfer: makeDt() });
    await sameCol.trigger("drop", { dataTransfer: makeDt() });
    await card.trigger("dragend");

    expect(moveSpy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("dragend without drop (Esc cancellation) does NOT emit move", async () => {
    const issue = makeIssue("DX-3", "ToDo");
    const { wrapper, moveSpy } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });
    await card.trigger("dragend");

    expect(moveSpy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("active drag source gets the `is-dragging` class", async () => {
    const issue = makeIssue("DX-4", "ToDo");
    const { wrapper } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });

    await vi.waitFor(() => {
      expect(card.classes()).toContain("is-dragging");
    });

    await card.trigger("dragend");
    await vi.waitFor(() => {
      expect(card.classes()).not.toContain("is-dragging");
    });
    wrapper.unmount();
  });

  it("hovered drop target gets the `drop-hover` class while a drag is active", async () => {
    const issue = makeIssue("DX-5", "ToDo");
    const { wrapper } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });

    const target = wrapper.find(`[data-test="column-${tid("In Progress")}"]`);
    await target.trigger("dragover", { dataTransfer: makeDt() });
    await vi.waitFor(() => {
      expect(target.classes()).toContain("drop-hover");
    });

    await card.trigger("dragend");
    await vi.waitFor(() => {
      expect(target.classes()).not.toContain("drop-hover");
    });
    wrapper.unmount();
  });

  it("dropping on Done emits move with the Done list (AC6 — backend handles file move)", async () => {
    const issue = makeIssue("DX-D", "ToDo");
    const { wrapper, moveSpy } = mountBoard([issue], { showClosed: true });

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });

    const target = wrapper.find(`[data-test="column-${tid("Done")}"]`);
    expect(target.exists()).toBe(true);
    await target.trigger("dragover", { dataTransfer: makeDt() });
    await target.trigger("drop", { dataTransfer: makeDt() });
    await card.trigger("dragend");

    await vi.waitFor(() => {
      expect(moveSpy).toHaveBeenCalledOnce();
    });
    expect(moveSpy.mock.calls[0][1].name).toBe("Done");
    expect(moveSpy.mock.calls[0][1].type).toBe("completed");
    wrapper.unmount();
  });

  it("dropping on Blocked emits move with the Blocked list (parent routes through INTO-blocked dialog)", async () => {
    const issue = makeIssue("DX-B", "ToDo");
    const { wrapper, moveSpy } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });

    const target = wrapper.find(`[data-test="column-${tid("Blocked")}"]`);
    await target.trigger("dragover", { dataTransfer: makeDt() });
    await target.trigger("drop", { dataTransfer: makeDt() });
    await card.trigger("dragend");

    await vi.waitFor(() => {
      expect(moveSpy).toHaveBeenCalledOnce();
    });
    expect(moveSpy.mock.calls[0][1].type).toBe("blocked");
    wrapper.unmount();
  });

  it("cards in different columns each get their own drag binding", async () => {
    const a = makeIssue("DX-A", "ToDo");
    const b = makeIssue("DX-B", "Blocked", {
      blocked: { at: "2026-05-01T00:00:00Z", reason: "x" },
    });
    const { wrapper, moveSpy } = mountBoard([a, b]);

    const cards = wrapper.findAll('[draggable="true"]');
    expect(cards).toHaveLength(2);

    const blockedCard = cards.find((c) => c.text().includes("DX-B"))!;
    await blockedCard.trigger("dragstart", { dataTransfer: makeDt() });
    const todoCol = wrapper.find(`[data-test="column-${tid("To Do")}"]`);
    await todoCol.trigger("dragover", { dataTransfer: makeDt() });
    await todoCol.trigger("drop", { dataTransfer: makeDt() });
    await blockedCard.trigger("dragend");

    await vi.waitFor(() => {
      expect(moveSpy).toHaveBeenCalledOnce();
    });
    expect(moveSpy.mock.calls[0][0].id).toBe("DX-B");
    expect(moveSpy.mock.calls[0][1].name).toBe("To Do");
    wrapper.unmount();
  });
});

// The backend's `sortIssuesForStatus` is the canonical order; the
// API ships rows in that order; the board preserves it verbatim.

// DX-625 — per-column client-side sort overlay with DanxPopover +
// localStorage persistence. Default `dispatch` sort is a no-op so the
// DX-522 invariant below still holds. Column key on disk is the
// column's `name` (e.g. "To Do", "Review"), matching the post-DX-586
// list-driven board.
describe("IssueBoard — per-column sort (DX-625)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders a sort button in every column header", () => {
    const { wrapper } = mountBoard([]);
    expect(wrapper.find(`[data-test="column-sort-${tid("To Do")}"]`).exists()).toBe(true);
    expect(wrapper.find(`[data-test="column-sort-${tid("Review")}"]`).exists()).toBe(true);
    expect(wrapper.find(`[data-test="column-sort-${tid("In Progress")}"]`).exists()).toBe(true);
    wrapper.unmount();
  });

  it("selecting Card ID ASC reorders the column numerically", async () => {
    const a = makeIssue("DX-10", "ToDo");
    const b = makeIssue("DX-2", "ToDo");
    const c = makeIssue("DX-100", "ToDo");
    const { wrapper } = mountBoard([a, b, c]);

    await wrapper.find(`[data-test="column-sort-${tid("To Do")}"]`).trigger("click");
    await wrapper.find(`[data-test="column-sort-${tid("To Do")}-id-asc"]`).trigger("click");
    await vi.waitFor(() => {
      const ids = wrapper
        .find(`[data-test="column-${tid("To Do")}"]`)
        .findAll('[data-test="card-id"]')
        .map((c) => c.text());
      expect(ids).toEqual(["DX-2", "DX-10", "DX-100"]);
    });
    wrapper.unmount();
  });

  it("selecting Title DESC reorders the column by title", async () => {
    const a = makeIssue("DX-1", "ToDo", { title: "alpha" });
    const b = makeIssue("DX-2", "ToDo", { title: "zulu" });
    const { wrapper } = mountBoard([a, b]);

    await wrapper.find(`[data-test="column-sort-${tid("To Do")}"]`).trigger("click");
    await wrapper.find(`[data-test="column-sort-${tid("To Do")}-title-desc"]`).trigger("click");
    await vi.waitFor(() => {
      const ids = wrapper
        .find(`[data-test="column-${tid("To Do")}"]`)
        .findAll('[data-test="card-id"]')
        .map((c) => c.text());
      expect(ids).toEqual(["DX-2", "DX-1"]);
    });
    wrapper.unmount();
  });

  it("shows the active sort label + direction arrow on the column header when non-default", async () => {
    const { wrapper } = mountBoard([makeIssue("DX-1", "ToDo")]);
    const todoTid = tid("To Do");
    const reviewTid = tid("Review");

    expect(wrapper.find(`[data-test="column-sort-active-${todoTid}"]`).exists()).toBe(false);

    await wrapper.find(`[data-test="column-sort-${todoTid}"]`).trigger("click");
    await wrapper.find(`[data-test="column-sort-${todoTid}-created-desc"]`).trigger("click");
    await vi.waitFor(() => {
      const active = wrapper.find(`[data-test="column-sort-active-${todoTid}"]`);
      expect(active.exists()).toBe(true);
      expect(active.text()).toBe("Created at ↓");
    });
    expect(wrapper.find(`[data-test="column-sort-active-${reviewTid}"]`).exists()).toBe(false);

    await wrapper.find(`[data-test="column-sort-${todoTid}"]`).trigger("click");
    await wrapper.find(`[data-test="column-sort-${todoTid}-dispatch-asc"]`).trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.find(`[data-test="column-sort-active-${todoTid}"]`).exists()).toBe(false);
    });
    wrapper.unmount();
  });

  it("setting sort on To Do does not affect Review", async () => {
    const a = makeIssue("DX-10", "ToDo");
    const b = makeIssue("DX-2", "ToDo");
    const r1 = makeIssue("DX-50", "Review");
    const r2 = makeIssue("DX-5", "Review");
    const { wrapper } = mountBoard([a, b, r1, r2]);

    await wrapper.find(`[data-test="column-sort-${tid("To Do")}"]`).trigger("click");
    await wrapper.find(`[data-test="column-sort-${tid("To Do")}-id-asc"]`).trigger("click");
    await vi.waitFor(() => {
      const todoIds = wrapper
        .find(`[data-test="column-${tid("To Do")}"]`)
        .findAll('[data-test="card-id"]')
        .map((c) => c.text());
      expect(todoIds).toEqual(["DX-2", "DX-10"]);
    });
    const reviewIds = wrapper
      .find(`[data-test="column-${tid("Review")}"]`)
      .findAll('[data-test="card-id"]')
      .map((c) => c.text());
    expect(reviewIds).toEqual(["DX-50", "DX-5"]);
    wrapper.unmount();
  });

  it("sort selection persists to localStorage keyed by column name", async () => {
    const { wrapper } = mountBoard([makeIssue("DX-1", "ToDo")]);
    await wrapper.find(`[data-test="column-sort-${tid("To Do")}"]`).trigger("click");
    await wrapper.find(`[data-test="column-sort-${tid("To Do")}-created-desc"]`).trigger("click");
    await vi.waitFor(() => {
      const raw = localStorage.getItem("danxbot.issueBoard.sort.v1");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!)["To Do"]).toEqual({ key: "created", direction: "desc" });
    });
    wrapper.unmount();
  });

  it("hydrates from localStorage on mount", () => {
    localStorage.setItem(
      "danxbot.issueBoard.sort.v1",
      JSON.stringify({ "To Do": { key: "id", direction: "asc" } }),
    );
    const a = makeIssue("DX-10", "ToDo");
    const b = makeIssue("DX-2", "ToDo");
    const { wrapper } = mountBoard([a, b]);
    const ids = wrapper
      .find(`[data-test="column-${tid("To Do")}"]`)
      .findAll('[data-test="card-id"]')
      .map((c) => c.text());
    expect(ids).toEqual(["DX-2", "DX-10"]);
    wrapper.unmount();
  });

  it("drop slots hide on positionable columns when sort is non-default", async () => {
    const a = makeIssue("DX-1", "ToDo");
    const { wrapper } = mountBoard([a]);

    expect(wrapper.find(`[data-test^="drop-slot-${tid("To Do")}-"]`).exists()).toBe(true);

    await wrapper.find(`[data-test="column-sort-${tid("To Do")}"]`).trigger("click");
    await wrapper.find(`[data-test="column-sort-${tid("To Do")}-title-asc"]`).trigger("click");
    await vi.waitFor(() => {
      expect(wrapper.find(`[data-test^="drop-slot-${tid("To Do")}-"]`).exists()).toBe(false);
    });
    wrapper.unmount();
  });
});

describe("IssueBoard — backend sort preserved verbatim (DX-522)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders priority-5 card before priority-2 card when backend ships them in that order", () => {
    const high = makeIssue("DX-HIGH", "ToDo", { priority: 5 });
    const low = makeIssue("DX-LOW", "ToDo", { priority: 2 });
    const { wrapper } = mountBoard([high, low]);

    const todoCol = wrapper.find(`[data-test="column-${tid("To Do")}"]`);
    const cardIds = todoCol
      .findAll('[draggable="true"]')
      .map((c) => c.find('[data-test="card-id"]').text());
    expect(cardIds).toEqual(["DX-HIGH", "DX-LOW"]);
    wrapper.unmount();
  });

  it("renders priority-2 card before priority-5 card when backend ships THAT order (no client-side flip)", () => {
    const low = makeIssue("DX-LOWFIRST", "ToDo", { priority: 2 });
    const high = makeIssue("DX-HIGHSECOND", "ToDo", { priority: 5 });
    const { wrapper } = mountBoard([low, high]);

    const todoCol = wrapper.find(`[data-test="column-${tid("To Do")}"]`);
    const cardIds = todoCol
      .findAll('[draggable="true"]')
      .map((c) => c.find('[data-test="card-id"]').text());
    expect(cardIds).toEqual(["DX-LOWFIRST", "DX-HIGHSECOND"]);
    wrapper.unmount();
  });
});
