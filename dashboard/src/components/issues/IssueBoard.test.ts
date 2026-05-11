import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import IssueBoard from "./IssueBoard.vue";
import type { IssueListItem, IssueStatus } from "../../types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let nextChildSeq = 0;

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
    priority: 3,
    assigned_agent: null,
    parent_id: null,
    children: [],
    children_detail: [],
    ac_done: 0,
    ac_total: 0,
    has_retro: false,
    comments_count: 0,
    waiting_on: null,
    waiting_on_reason: null,
    waiting_on_by: [],
    blocked: null,
    requires_human: null,
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

function dragEvent(type: string, dt: FakeDataTransfer = makeDt()): DragEvent {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
  return ev;
}

function mountBoard(
  initial: IssueListItem[],
  opts: { showClosed?: boolean } = {},
) {
  const issues = ref<IssueListItem[]>(initial);
  const moveSpy = vi.fn<(issue: IssueListItem, to: IssueStatus) => void>();
  const Host = defineComponent({
    setup() {
      return () =>
        h(IssueBoard, {
          issues: issues.value,
          repo: "danxbot",
          showClosed: opts.showClosed ?? false,
          scopedEpicId: null,
          scopeMode: "filter",
          onMove: (issue: IssueListItem, to: IssueStatus) => {
            moveSpy(issue, to);
          },
        });
    },
  });
  const wrapper = mount(Host, { attachTo: document.body });
  return { wrapper, issues, moveSpy };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("IssueBoard — drag and drop", () => {
  it("dragging a card from ToDo and dropping on In Progress emits move with target status", async () => {
    const issue = makeIssue("DX-1", "ToDo");
    const { wrapper, moveSpy } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain("DX-1");

    await card.trigger("dragstart", { dataTransfer: makeDt() });

    const target = wrapper.find('[data-test="column-in_progress"]');
    expect(target.exists()).toBe(true);

    await target.trigger("dragover", { dataTransfer: makeDt() });
    await target.trigger("drop", { dataTransfer: makeDt() });
    await card.trigger("dragend");

    expect(moveSpy).toHaveBeenCalledOnce();
    const [calledIssue, calledStatus] = moveSpy.mock.calls[0];
    expect(calledIssue.id).toBe("DX-1");
    expect(calledStatus).toBe("In Progress");

    wrapper.unmount();
  });

  it("dropping on the same column does NOT emit move", async () => {
    const issue = makeIssue("DX-2", "ToDo");
    const { wrapper, moveSpy } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });

    const sameCol = wrapper.find('[data-test="column-todo"]');
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
    // Simulate Esc — browser fires dragend on the source without a drop event.
    await card.trigger("dragend");

    expect(moveSpy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("active drag source gets the `is-dragging` class (opacity ≤0.4 + pointer-events: none)", async () => {
    const issue = makeIssue("DX-4", "ToDo");
    const { wrapper } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });
    await flushPromises();

    expect(card.classes()).toContain("is-dragging");

    await card.trigger("dragend");
    await flushPromises();

    expect(card.classes()).not.toContain("is-dragging");
    wrapper.unmount();
  });

  it("hovered drop target gets the `drop-hover` class while a drag is active", async () => {
    const issue = makeIssue("DX-5", "ToDo");
    const { wrapper } = mountBoard([issue]);

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });

    const target = wrapper.find('[data-test="column-in_progress"]');
    await target.trigger("dragover", { dataTransfer: makeDt() });
    await flushPromises();
    expect(target.classes()).toContain("drop-hover");

    await card.trigger("dragend");
    await flushPromises();
    expect(target.classes()).not.toContain("drop-hover");
    wrapper.unmount();
  });

  it("dropping on Done emits move with target status Done (AC6 — backend handles file move)", async () => {
    const issue = makeIssue("DX-D", "ToDo");
    const { wrapper, moveSpy } = mountBoard([issue], { showClosed: true });

    const card = wrapper.find('[draggable="true"]');
    await card.trigger("dragstart", { dataTransfer: makeDt() });

    const target = wrapper.find('[data-test="column-done"]');
    expect(target.exists()).toBe(true);
    await target.trigger("dragover", { dataTransfer: makeDt() });
    await target.trigger("drop", { dataTransfer: makeDt() });
    await card.trigger("dragend");

    expect(moveSpy).toHaveBeenCalledOnce();
    expect(moveSpy.mock.calls[0][1]).toBe("Done");
    wrapper.unmount();
  });

  it("synthetic done_recent column has no drop binding — drops on it are inert", async () => {
    const todoCard = makeIssue("DX-T", "ToDo");
    // Use updated_at within the recent window so the synthetic column is non-empty.
    const recentDone = makeIssue("DX-R", "Done", {
      updated_at: Math.floor(Date.now() / 1000),
    });
    const { wrapper, moveSpy } = mountBoard([todoCard, recentDone]);

    const cards = wrapper.findAll('[draggable="true"]');
    const draggable = cards.find((c) => c.text().includes("DX-T"))!;
    await draggable.trigger("dragstart", { dataTransfer: makeDt() });

    const recentCol = wrapper.find('[data-test="column-done_recent"]');
    expect(recentCol.exists()).toBe(true);
    // No bindColumn → no preventDefault on dragover, no drop handler firing.
    await recentCol.trigger("dragover", { dataTransfer: makeDt() });
    await recentCol.trigger("drop", { dataTransfer: makeDt() });
    await draggable.trigger("dragend");

    expect(moveSpy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("cards in different columns each get their own drag binding", async () => {
    const a = makeIssue("DX-A", "ToDo");
    const b = makeIssue("DX-B", "Blocked");
    const { wrapper, moveSpy } = mountBoard([a, b]);

    const cards = wrapper.findAll('[draggable="true"]');
    expect(cards).toHaveLength(2);

    // Drag the Blocked card into ToDo.
    const blockedCard = cards.find((c) => c.text().includes("DX-B"))!;
    await blockedCard.trigger("dragstart", { dataTransfer: makeDt() });
    const todoCol = wrapper.find('[data-test="column-todo"]');
    await todoCol.trigger("dragover", { dataTransfer: makeDt() });
    await todoCol.trigger("drop", { dataTransfer: makeDt() });
    await blockedCard.trigger("dragend");

    expect(moveSpy).toHaveBeenCalledOnce();
    expect(moveSpy.mock.calls[0][0].id).toBe("DX-B");
    expect(moveSpy.mock.calls[0][1]).toBe("ToDo");
    wrapper.unmount();
  });
});
