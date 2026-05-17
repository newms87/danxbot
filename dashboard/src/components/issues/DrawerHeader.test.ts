import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import DrawerHeader from "./DrawerHeader.vue";
import type { IssueDetail } from "../../types";

// DanxEditableDiv shipped in @thehammer/danx-ui@0.7.3. Tests still
// inject a deterministic input-shaped fake at the module boundary so
// Enter-commit assertions don't have to drive the real
// contenteditable surface.
vi.mock("@thehammer/danx-ui", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@thehammer/danx-ui",
  );
  const { defineComponent, h } = await import("vue");
  return {
    ...actual,
    DanxEditableDiv: defineComponent({
      name: "DanxEditableDiv",
      props: ["modelValue", "as", "mode", "size", "minLength", "saving", "placeholder"],
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h("input", {
            value: props.modelValue,
            onKeydown: (e: KeyboardEvent) => {
              if (e.key === "Enter") {
                emit("update:modelValue", (e.target as HTMLInputElement).value);
              }
            },
          });
      },
    }),
  };
});

vi.mock("../../api", () => ({
  patchIssue: vi.fn(),
  getIssueSubtree: vi.fn(),
  deleteIssue: vi.fn(),
  // DX-586 — drawer's List dropdown consumes `useListColors`, which
  // calls `fetchLists` on init. Return a deterministic 7-list seed so
  // the dropdown surfaces the canonical options for click tests.
  fetchLists: vi.fn(async () => ({
    lists: [
      { id: "lst-arc", name: "Backlog",     type: "archived",    order: 0, is_default_for_type: true, color: "#64748b" },
      { id: "lst-rev", name: "Review",      type: "review",      order: 1, is_default_for_type: true, color: "#3b82f6" },
      { id: "lst-rdy", name: "To Do",       type: "ready",       order: 2, is_default_for_type: true, color: "#22d3ee" },
      { id: "lst-blk", name: "Blocked",     type: "blocked",     order: 3, is_default_for_type: true, color: "#ef4444" },
      { id: "lst-wip", name: "In Progress", type: "in_progress", order: 4, is_default_for_type: true, color: "#f59e0b" },
      { id: "lst-don", name: "Done",        type: "completed",   order: 5, is_default_for_type: true, color: "#22c55e" },
      { id: "lst-cnl", name: "Cancelled",   type: "cancelled",   order: 6, is_default_for_type: true, color: "#71717a" },
    ],
    tombstone_ids: [],
  })),
}));

import { getIssueSubtree, patchIssue } from "../../api";
const patchMock = vi.mocked(patchIssue);
const subtreeMock = vi.mocked(getIssueSubtree);

function installClipboardStub(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return { writeText };
}

const IssueAgeBadgeStub = defineComponent({
  name: "IssueAgeBadge",
  props: { updatedAt: Number, createdAt: Number },
  setup: () => () => h("div", { class: "stub-age" }),
});

// DanxPopover lazy-mounts its panel. Stub renders both trigger + panel
// inline so menu option selectors are findable without simulating the
// open/close cascade.
const DanxPopoverStub = defineComponent({
  name: "DanxPopover",
  props: { modelValue: Boolean, trigger: String, placement: String },
  emits: ["update:modelValue"],
  setup: (_p, { slots }) => () => [
    h("div", { class: "stub-popover-trigger" }, slots.trigger?.()),
    h("div", { class: "stub-popover-panel" }, slots.default?.()),
  ],
});
const DanxTooltipStub = defineComponent({
  name: "DanxTooltip",
  props: { tooltip: String },
  setup: (p, { slots }) => () =>
    h("div", { class: "stub-tooltip", "data-tooltip": p.tooltip }, slots.trigger?.()),
});

function makeDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    schema_version: 10,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Original Title",
    description: "",
    priority: 3,
    position: null,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [],
    comments: [],
    history: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    assigned_agent: null,
    updated_at: 0,
    created_at: 0,
    raw_yaml: "",
    requires_human_child_count: 0,
    ...overrides,
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };
}

function mountHeader(detail: IssueDetail = makeDetail()) {
  return mount(DrawerHeader, {
    props: { issue: detail, repo: "danxbot" },
    global: {
      stubs: {
        IssueAgeBadge: IssueAgeBadgeStub,
        DanxPopover: DanxPopoverStub,
        DanxTooltip: DanxTooltipStub,
      },
    },
  });
}

describe("DrawerHeader — meta row layout", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("renders id, priority, type, list, copy, delete, close, and rh-flag in the meta row", () => {
    const w = mountHeader();
    expect(w.find('[data-test="drawer-id"]').text()).toBe("DX-1");
    expect(w.find('[data-test="drawer-priority-pill"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-type-pill"]').exists()).toBe(true);
    // DX-586 — `drawer-status-pill` retired in favor of `drawer-list-pill`.
    expect(w.find('[data-test="drawer-list-pill"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-copy"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-delete"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-close"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-rh-flag"]').exists()).toBe(true);
  });

  it("emits close when the close button is clicked", async () => {
    const w = mountHeader();
    await w.find('[data-test="drawer-close"]').trigger("click");
    expect(w.emitted("close")).toBeTruthy();
  });

  it("does NOT render close when showClose=false (dialog mode handles its own)", () => {
    const w = mount(DrawerHeader, {
      props: { issue: makeDetail(), repo: "danxbot", showClose: false },
      global: { stubs: { IssueAgeBadge: IssueAgeBadgeStub, DanxPopover: DanxPopoverStub, DanxTooltip: DanxTooltipStub } },
    });
    expect(w.find('[data-test="drawer-close"]').exists()).toBe(false);
  });

  it("emits open-rh-editor when the flag button is clicked", async () => {
    const w = mountHeader();
    await w.find('[data-test="drawer-rh-flag"]').trigger("click");
    expect(w.emitted("open-rh-editor")).toBeTruthy();
  });

  it("emits jump-issue when the parent chip is clicked", async () => {
    const w = mountHeader(makeDetail({ parent_id: "DX-9" }));
    await w.find('[data-test="drawer-parent-DX-9"]').trigger("click");
    expect(w.emitted("jump-issue")?.[0]).toEqual(["DX-9"]);
  });

  it("epic guard: epic-with-children renders inert status, NOT a clickable list pill", () => {
    const w = mountHeader(
      makeDetail({ type: "Epic", children: ["DX-2"] }),
    );
    expect(w.find('[data-test="drawer-status-pill-inert"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-list-pill"]').exists()).toBe(false);
  });
});

describe("DrawerHeader — title editor", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("renders the title via DanxEditableDiv with the current value", () => {
    const w = mountHeader();
    const titleEl = w.find('[data-test="drawer-title"]');
    expect(titleEl.exists()).toBe(true);
    expect((titleEl.element as HTMLInputElement).value).toBe("Original Title");
  });

  it("commits an Enter-fired update via patchIssue + emits update:issue", async () => {
    patchMock.mockResolvedValue({ ...makeDetail(), title: "Renamed" } as never);
    const w = mountHeader();
    const titleEl = w.find('[data-test="drawer-title"]');
    (titleEl.element as HTMLInputElement).value = "Renamed";
    await titleEl.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", { title: "Renamed" });
    expect(w.emitted("update:issue")).toBeTruthy();
  });

  it("no-op when commit equals current title", async () => {
    const w = mountHeader();
    const titleEl = w.find('[data-test="drawer-title"]');
    (titleEl.element as HTMLInputElement).value = "Original Title";
    await titleEl.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("blocks empty commits + surfaces the error", async () => {
    const w = mountHeader();
    const titleEl = w.find('[data-test="drawer-title"]');
    (titleEl.element as HTMLInputElement).value = "   ";
    await titleEl.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
    expect(w.find('[data-test="drawer-title-error"]').exists()).toBe(true);
  });
});

describe("DrawerHeader — type menu (DX-NEW)", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("renders every IssueType as a menu option (popover stubbed to render the panel inline)", () => {
    const w = mountHeader();
    expect(w.find('[data-test="drawer-type-menu"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-type-option-epic"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-type-option-feature"]').exists()).toBe(true);
  });

  it("PATCHes type when a different type is selected", async () => {
    patchMock.mockResolvedValue({ ...makeDetail(), type: "Epic" } as never);
    const w = mountHeader();
    await w.find('[data-test="drawer-type-option-epic"]').trigger("click");
    await flushPromises();
    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", { type: "Epic" });
  });
});

describe("DrawerHeader — Copy button (DX-519)", () => {
  beforeEach(() => {
    patchMock.mockReset();
    subtreeMock.mockReset();
  });

  it("fetches the subtree and writes JSON to clipboard", async () => {
    const { writeText } = installClipboardStub();
    subtreeMock.mockResolvedValue({
      schema_version: 1,
      exported_at: "",
      repo: "danxbot",
      root_id: "DX-1",
      issues: [makeDetail()],
    } as never);
    const w = mountHeader();
    await w.find('[data-test="drawer-copy"]').trigger("click");
    await flushPromises();
    expect(subtreeMock).toHaveBeenCalledWith("danxbot", "DX-1");
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
