import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import IssueListMenu from "./IssueListMenu.vue";

vi.mock("../../api", () => ({
  patchIssue: vi.fn(),
  fetchLists: vi.fn(async () => ({
    lists: [
      { id: "lst-arc", name: "Backlog",     type: "archived",    order: 0, is_default_for_type: true, color: "#64748b" },
      { id: "lst-rev", name: "Review",      type: "review",      order: 1, is_default_for_type: true, color: "#3b82f6" },
      { id: "lst-rdy", name: "To Do",       type: "ready",       order: 2, is_default_for_type: true, color: "#22d3ee" },
      { id: "lst-wip", name: "In Progress", type: "in_progress", order: 3, is_default_for_type: true, color: "#f59e0b" },
      { id: "lst-don", name: "Done",        type: "completed",   order: 4, is_default_for_type: true, color: "#22c55e" },
      { id: "lst-cnl", name: "Cancelled",   type: "cancelled",   order: 5, is_default_for_type: true, color: "#71717a" },
    ],
    tombstone_ids: [],
  })),
}));

import { patchIssue } from "../../api";
const patchMock = vi.mocked(patchIssue);

// DanxPopover stub renders both trigger + panel inline (real popover
// lazy-mounts the panel on open; tests need the panel reachable).
const DanxPopoverStub = defineComponent({
  name: "DanxPopover",
  props: { modelValue: Boolean, trigger: String, placement: String },
  emits: ["update:modelValue"],
  setup: (_p, { slots }) => () => [
    h("div", { class: "stub-popover-trigger" }, slots.trigger?.()),
    h("div", { class: "stub-popover-panel" }, slots.default?.()),
  ],
});

function mountMenu(props: {
  currentListName?: string | null;
  statusFallback?: string;
  issueId?: string;
} = {}) {
  return mount(IssueListMenu, {
    props: {
      repo: "danxbot",
      issueId: props.issueId ?? "DX-1",
      currentListName: props.currentListName ?? null,
      statusFallback: props.statusFallback ?? "ToDo",
    },
    global: { stubs: { DanxPopover: DanxPopoverStub } },
  });
}

describe("IssueListMenu", () => {
  beforeEach(() => patchMock.mockReset());

  it("renders the list pill with status fallback when currentListName is null", () => {
    const w = mountMenu({ statusFallback: "ToDo" });
    const pill = w.find('[data-test="drawer-list-pill"]');
    expect(pill.exists()).toBe(true);
    expect(pill.text()).toContain("ToDo");
  });

  it("renders every list as a menu option grouped by ListType", async () => {
    const w = mountMenu();
    await flushPromises();
    expect(w.find('[data-test="drawer-list-menu"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-list-option-lst-arc"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-list-option-lst-rev"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-list-option-lst-don"]').exists()).toBe(true);
  });

  it("PATCHes list_name when a new list is selected and emits update:issue", async () => {
    patchMock.mockResolvedValue({ issue: { id: "DX-1", list_name: "Done" } } as never);
    const w = mountMenu({ currentListName: "Review" });
    await flushPromises();
    await w.find('[data-test="drawer-list-option-lst-don"]').trigger("click");
    await flushPromises();
    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", { list_name: "Done" });
    expect(w.emitted("update:issue")).toBeTruthy();
  });

  it("no-op PATCH when the selected list equals currentListName", async () => {
    const w = mountMenu({ currentListName: "Review" });
    await flushPromises();
    await w.find('[data-test="drawer-list-option-lst-rev"]').trigger("click");
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
  });

});
