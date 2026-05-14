import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import DrawerHeader from "./DrawerHeader.vue";
import type { IssueDetail } from "../../types";

vi.mock("../../api", () => ({
  patchIssue: vi.fn(),
  getIssueSubtree: vi.fn(),
}));

import { getIssueSubtree, patchIssue } from "../../api";
const patchMock = vi.mocked(patchIssue);
const subtreeMock = vi.mocked(getIssueSubtree);

// Replace navigator.clipboard so Copy tests can intercept writeText. The
// happy-dom build doesn't ship a real clipboard implementation, and the
// component refuses to copy when `navigator.clipboard?.writeText` is
// undefined.
function installClipboardStub(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return { writeText };
}

const AgentBadgeStub = defineComponent({
  name: "AgentBadge",
  props: { repo: String, agentName: String, size: String },
  setup: () => () => h("div", { class: "stub-agent-badge" }),
});
const IssueAgeBadgeStub = defineComponent({
  name: "IssueAgeBadge",
  props: { updatedAt: Number, createdAt: Number },
  setup: () => () => h("div", { class: "stub-age" }),
});
const TypeBadgeStub = defineComponent({
  name: "TypeBadge",
  props: { type: String },
  setup: () => () => h("div", { class: "stub-type" }),
});

function makeDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    schema_version: 8,
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
  };
}

function mountHeader(detail: IssueDetail = makeDetail()) {
  return mount(DrawerHeader, {
    props: {
      issue: detail,
      repo: "danxbot",
      scopedEpicId: null,
    },
    global: {
      stubs: {
        AgentBadge: AgentBadgeStub,
        IssueAgeBadge: IssueAgeBadgeStub,
        TypeBadge: TypeBadgeStub,
      },
    },
  });
}

describe("DrawerHeader title editor", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("renders the title as a clickable element initially", () => {
    const w = mountHeader();
    expect(w.get('[data-test="drawer-title"]').text()).toBe("Original Title");
    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(false);
  });

  it("clicking the title switches to an input prefilled with the current title", async () => {
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    // DX-299: v-if mount race under full-suite CPU contention — vi.waitFor
    // polls until the input element is observable in the DOM. See DX-262
    // RequiresHumanPanel.test.ts for the canonical mechanism description.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true),
    );
    const input = w.get('[data-test="drawer-title-input"]');
    expect((input.element as HTMLInputElement).value).toBe("Original Title");
    // Original h2 is gone.
    expect(w.find('[data-test="drawer-title"]').exists()).toBe(false);
  });

  it("Enter saves: calls patchIssue with the new title and emits update:issue", async () => {
    const patched = makeDetail({ title: "New Title" });
    patchMock.mockResolvedValue(patched);

    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true),
    );
    const input = w.get('[data-test="drawer-title-input"]');
    await input.setValue("New Title");
    await input.trigger("keydown", { key: "Enter" });

    // DX-299: post-Enter PATCH call-count race after the async save cascade.
    await vi.waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
        title: "New Title",
      });
    });
    // DX-299: the emit fires AFTER the awaited PATCH resolves, in the
    // microtask after the call-count is observable; wrap in its own
    // vi.waitFor to match the DX-262 canonical pattern (see
    // RequiresHumanPanel.test.ts L147 — `expect(w.emitted(...))` inside
    // a second vi.waitFor).
    await vi.waitFor(() => {
      const events = w.emitted("update:issue");
      expect(events).toBeTruthy();
      expect(events![0][0]).toBe(patched);
    });
    // DX-299: exit-edit-mode transition race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(false),
    );
  });

  it("Esc cancels: does not call patchIssue and reverts to the read state", async () => {
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true),
    );
    const input = w.get('[data-test="drawer-title-input"]');
    await input.setValue("Half-typed never sent");
    await input.trigger("keydown", { key: "Escape" });

    // DX-299: exit-edit-mode transition race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(false),
    );
    // DX-299: negative assertion — vi.waitFor can't gate "should never be
    // called"; flushPromises drains the macrotask queue before the check.
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
    expect(w.get('[data-test="drawer-title"]').text()).toBe("Original Title");
  });

  it("empty title is rejected client-side — error shown, stay in edit mode, no PATCH fired", async () => {
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true),
    );
    const input = w.get('[data-test="drawer-title-input"]');
    await input.setValue("   ");
    await input.trigger("keydown", { key: "Enter" });

    // DX-299: client-side error-render state-transition race.
    await vi.waitFor(() => {
      expect(w.get('[data-test="drawer-title-error"]').text()).toContain(
        "Title cannot be empty",
      );
    });
    // DX-299: negative — drain macrotasks before the not-called check.
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true);
  });

  it("no PATCH fires when the title is unchanged after Enter", async () => {
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true),
    );
    await w.get('[data-test="drawer-title-input"]')
      .trigger("keydown", { key: "Enter" });
    // DX-299: exit-edit-mode transition race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(false),
    );
    // DX-299: negative — drain macrotasks before the not-called check.
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("switching to a different issue mid-edit resets to read state", async () => {
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true),
    );

    await w.setProps({ issue: makeDetail({ id: "DX-2", title: "Other" }) });

    // DX-299: prop-change unmount race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(false),
    );
    expect(w.get('[data-test="drawer-title"]').text()).toBe("Other");
  });

  it("Enter on the read-mode title (keyboard activation) enters edit mode", async () => {
    const w = mountHeader();
    await w
      .get('[data-test="drawer-title"]')
      .trigger("keydown", { key: "Enter" });
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true),
    );
  });

  it("surfaces the server error on PATCH failure and stays in edit mode", async () => {
    patchMock.mockRejectedValue(new Error("conflict"));
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true),
    );
    const input = w.get('[data-test="drawer-title-input"]');
    await input.setValue("Different");
    await input.trigger("keydown", { key: "Enter" });

    // DX-299: server-error render state-transition race.
    await vi.waitFor(() => {
      expect(w.get('[data-test="drawer-title-error"]').text()).toContain(
        "conflict",
      );
    });
    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true);
    expect(w.emitted("update:issue")).toBeUndefined();
  });
});

// DX-267 — Epic drawer header surfaces the count of children whose
// `requires_human != null`. Reads `issue.requires_human_child_count`
// (backend-computed); live updates flow through the SSE `issue:updated`
// pipeline which reprojects the IssueDetail and resets the prop.
describe("DrawerHeader requires_human rollup (DX-267)", () => {
  it("does NOT render the children rollup line on non-Epic cards (even with count > 0)", () => {
    const w = mountHeader(
      makeDetail({
        type: "Feature",
        requires_human_child_count: 2,
      }),
    );
    expect(w.find('[data-test="drawer-rh-children-line"]').exists()).toBe(
      false,
    );
  });

  it("does NOT render the children rollup line on Epics when count = 0", () => {
    const w = mountHeader(
      makeDetail({
        type: "Epic",
        requires_human_child_count: 0,
      }),
    );
    expect(w.find('[data-test="drawer-rh-children-line"]').exists()).toBe(
      false,
    );
  });

  it("renders 'N phases need human action' on Epics with count > 1", () => {
    const w = mountHeader(
      makeDetail({
        type: "Epic",
        requires_human_child_count: 3,
      }),
    );
    const line = w.get('[data-test="drawer-rh-children-line"]');
    expect(line.text()).toContain("3 phases need human action");
  });

  it("uses singular '1 phase needs human action' on Epics with count = 1", () => {
    const w = mountHeader(
      makeDetail({
        type: "Epic",
        requires_human_child_count: 1,
      }),
    );
    const line = w.get('[data-test="drawer-rh-children-line"]');
    expect(line.text()).toContain("1 phase needs human action");
  });

  it("re-renders the count when the prop updates (live update path)", async () => {
    const w = mountHeader(
      makeDetail({
        type: "Epic",
        requires_human_child_count: 0,
      }),
    );
    expect(w.find('[data-test="drawer-rh-children-line"]').exists()).toBe(
      false,
    );

    await w.setProps({
      issue: makeDetail({ type: "Epic", requires_human_child_count: 2 }),
    });

    expect(
      w.get('[data-test="drawer-rh-children-line"]').text(),
    ).toContain("2 phases need human action");
  });
});

describe("DrawerHeader Copy button (DX-519)", () => {
  beforeEach(() => {
    subtreeMock.mockReset();
  });

  function samplePayload(n: number) {
    return {
      schema_version: 8 as const,
      issues: Array.from({ length: n }).map((_, i) => ({
        ...makeDetail({ id: `DX-${100 + i}` }),
        // IssueCopyPayload.issues is Issue[], drop the IssueDetail-only
        // fields the API never returns from /subtree.
      })),
    };
  }

  it("fetches the subtree, writes the JSON to clipboard, surfaces a 'Copied N cards' toast", async () => {
    const payload = samplePayload(3);
    subtreeMock.mockResolvedValue(payload as never);
    const clip = installClipboardStub();

    const w = mountHeader();
    await w.get('[data-test="drawer-copy"]').trigger("click");

    await vi.waitFor(() => {
      expect(subtreeMock).toHaveBeenCalledWith("danxbot", "DX-1");
    });
    await vi.waitFor(() => {
      expect(clip.writeText).toHaveBeenCalledTimes(1);
    });
    const writtenText = clip.writeText.mock.calls[0][0] as string;
    const parsed = JSON.parse(writtenText);
    expect(parsed.schema_version).toBe(8);
    expect(parsed.issues).toHaveLength(3);

    await vi.waitFor(() => {
      expect(w.get('[data-test="drawer-copy-toast"]').text()).toContain(
        "Copied 3 cards",
      );
    });
  });

  it("singular-pluralizes the toast for a single-card payload", async () => {
    const payload = samplePayload(1);
    subtreeMock.mockResolvedValue(payload as never);
    installClipboardStub();

    const w = mountHeader();
    await w.get('[data-test="drawer-copy"]').trigger("click");
    await vi.waitFor(() => {
      expect(w.get('[data-test="drawer-copy-toast"]').text()).toContain(
        "Copied 1 card",
      );
    });
  });

  it("surfaces an error toast when the subtree fetch fails", async () => {
    subtreeMock.mockRejectedValue(new Error("Issue \"DX-1\" not found"));
    installClipboardStub();

    const w = mountHeader();
    await w.get('[data-test="drawer-copy"]').trigger("click");
    await vi.waitFor(() => {
      const toast = w.get('[data-test="drawer-copy-toast"]');
      expect(toast.text()).toContain("not found");
      expect(toast.classes()).toContain("copy-toast-error");
    });
  });

  it("surfaces an error toast when navigator.clipboard is unavailable", async () => {
    subtreeMock.mockResolvedValue(samplePayload(1) as never);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    const w = mountHeader();
    await w.get('[data-test="drawer-copy"]').trigger("click");
    await vi.waitFor(() => {
      const toast = w.get('[data-test="drawer-copy-toast"]');
      expect(toast.text()).toContain("Clipboard API not available");
      expect(toast.classes()).toContain("copy-toast-error");
    });
  });
});

// DX-522 — inline status + priority editors. Stubs DanxPopover and
// DanxTooltip so the default-slot panel content is always queryable
// without simulating the click → popover-open → wait-for-portal
// cascade. The trigger slot's button is rendered normally so the
// editor's own click handler still wires up.
const DanxPopoverStub = defineComponent({
  name: "DanxPopover",
  props: {
    modelValue: Boolean,
    trigger: String,
    placement: String,
  },
  emits: ["update:modelValue"],
  setup: (_props, { slots }) => () => [
    h("div", { class: "stub-popover-trigger" }, slots.trigger?.()),
    h("div", { class: "stub-popover-panel" }, slots.default?.()),
  ],
});
const DanxTooltipStub = defineComponent({
  name: "DanxTooltip",
  props: { tooltip: String },
  setup: (props, { slots }) => () =>
    h(
      "div",
      { class: "stub-tooltip", "data-tooltip": props.tooltip },
      slots.trigger?.(),
    ),
});

function mountHeaderWithMenuStubs(detail: IssueDetail = makeDetail()) {
  return mount(DrawerHeader, {
    props: {
      issue: detail,
      repo: "danxbot",
      scopedEpicId: null,
    },
    global: {
      stubs: {
        AgentBadge: AgentBadgeStub,
        IssueAgeBadge: IssueAgeBadgeStub,
        TypeBadge: TypeBadgeStub,
        DanxPopover: DanxPopoverStub,
        DanxTooltip: DanxTooltipStub,
      },
    },
  });
}

describe("DrawerHeader — status menu (DX-522)", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("renders every IssueStatus value as a menu option on non-epic cards", () => {
    const w = mountHeaderWithMenuStubs(makeDetail({ type: "Feature" }));
    const menu = w.get('[data-test="drawer-status-menu"]');
    const options = menu.findAll(
      '[data-test^="drawer-status-option-"]',
    );
    const labels = options.map((o) => o.text());
    expect(labels).toEqual([
      "Review",
      "ToDo",
      "In Progress",
      "Blocked",
      "Done",
      "Cancelled",
    ]);
  });

  it("clicking a status option calls patchIssue with that status and emits update:issue", async () => {
    const patched = makeDetail({ status: "Blocked" });
    patchMock.mockResolvedValue(patched);

    const w = mountHeaderWithMenuStubs(makeDetail({ status: "ToDo" }));
    await w.get('[data-test="drawer-status-option-blocked"]').trigger("click");

    await vi.waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
        status: "Blocked",
      });
    });
    await vi.waitFor(() => {
      const events = w.emitted("update:issue");
      expect(events).toBeTruthy();
      expect(events![0][0]).toBe(patched);
    });
  });

  it("clicking the same status as current is a no-op (no PATCH fired)", async () => {
    const w = mountHeaderWithMenuStubs(makeDetail({ status: "ToDo" }));
    await w.get('[data-test="drawer-status-option-todo"]').trigger("click");
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("surfaces server error inline when patchIssue rejects", async () => {
    patchMock.mockRejectedValue(new Error("write conflict"));
    const w = mountHeaderWithMenuStubs(makeDetail({ status: "ToDo" }));
    await w.get('[data-test="drawer-status-option-done"]').trigger("click");
    await vi.waitFor(() => {
      expect(w.get('[data-test="drawer-status-error"]').text()).toContain(
        "write conflict",
      );
    });
  });
});

describe("DrawerHeader — epic guard (DX-522)", () => {
  it("renders an INERT status pill + DanxTooltip when type=Epic AND children.length > 0", () => {
    const w = mountHeaderWithMenuStubs(
      makeDetail({ type: "Epic", children: ["DX-2", "DX-3"] }),
    );
    // Inert pill present, clickable pill + menu absent.
    expect(w.find('[data-test="drawer-status-pill-inert"]').exists()).toBe(
      true,
    );
    expect(w.find('[data-test="drawer-status-pill"]').exists()).toBe(false);
    expect(w.find('[data-test="drawer-status-menu"]').exists()).toBe(false);
    // Tooltip copy is verbatim from the AC.
    const tooltip = w.get(".stub-tooltip");
    expect(tooltip.attributes("data-tooltip")).toBe(
      "Epic status is computed from phase statuses — edit a child phase to change this.",
    );
  });

  it("renders the editable status menu on an Epic with empty children (recovery affordance)", () => {
    const w = mountHeaderWithMenuStubs(
      makeDetail({ type: "Epic", children: [] }),
    );
    expect(w.find('[data-test="drawer-status-pill-inert"]').exists()).toBe(
      false,
    );
    expect(w.find('[data-test="drawer-status-pill"]').exists()).toBe(true);
    expect(w.find('[data-test="drawer-status-menu"]').exists()).toBe(true);
  });

  it("keeps the priority pill editable on Epics with children", () => {
    const w = mountHeaderWithMenuStubs(
      makeDetail({ type: "Epic", children: ["DX-2"] }),
    );
    // Priority menu renders the six tier options regardless of epic status.
    const options = w.findAll('[data-test^="drawer-priority-option-"]');
    expect(options.map((o) => o.attributes("data-test"))).toEqual([
      "drawer-priority-option-lowest",
      "drawer-priority-option-low",
      "drawer-priority-option-medium",
      "drawer-priority-option-high",
      "drawer-priority-option-very_high",
      "drawer-priority-option-critical",
    ]);
  });
});

describe("DrawerHeader — priority menu (DX-522)", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("renders six tier options low → high in the canonical order", () => {
    const w = mountHeaderWithMenuStubs(makeDetail({ priority: 3 }));
    const options = w.findAll('[data-test^="drawer-priority-option-"]');
    expect(options).toHaveLength(6);
    expect(options[0].text()).toContain("Lowest");
    expect(options[5].text()).toContain("Critical");
  });

  it("clicking the 'high' tier commits 3.5 (the tier midpoint) via patchIssue", async () => {
    const patched = makeDetail({ priority: 3.5 });
    patchMock.mockResolvedValue(patched);

    const w = mountHeaderWithMenuStubs(makeDetail({ priority: 2.5 }));
    await w.get('[data-test="drawer-priority-option-high"]').trigger("click");

    await vi.waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
        priority: 3.5,
      });
    });
    await vi.waitFor(() => {
      const events = w.emitted("update:issue");
      expect(events).toBeTruthy();
      expect(events![0][0]).toBe(patched);
    });
  });

  it("clicking the current tier is a no-op (no PATCH fired)", async () => {
    // priority 3.5 → high; clicking high again should not PATCH.
    const w = mountHeaderWithMenuStubs(makeDetail({ priority: 3.5 }));
    await w.get('[data-test="drawer-priority-option-high"]').trigger("click");
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("trigger pill shows the current tier's label next to the icon", () => {
    const w = mountHeaderWithMenuStubs(makeDetail({ priority: 5.5 }));
    const pill = w.get('[data-test="drawer-priority-pill"]');
    expect(pill.text()).toContain("Critical");
  });

  // Accessibility — the pill's aria-label must reflect the CURRENT
  // tier so a screen reader user announcing the pill hears the
  // up-to-date priority value, not a stale one. Guards against a
  // future refactor that hardcodes "Priority — click to change" and
  // drops the tier label.
  it("aria-label tracks the current tier label across prop updates", async () => {
    const w = mountHeaderWithMenuStubs(makeDetail({ priority: 0.5 }));
    let pill = w.get('[data-test="drawer-priority-pill"]');
    expect(pill.attributes("aria-label")).toContain("Lowest");

    await w.setProps({ issue: makeDetail({ priority: 5.5 }) });
    pill = w.get('[data-test="drawer-priority-pill"]');
    expect(pill.attributes("aria-label")).toContain("Critical");
  });

  it("surfaces server error inline when patchIssue rejects", async () => {
    patchMock.mockRejectedValue(new Error("Invalid priority"));
    const w = mountHeaderWithMenuStubs(makeDetail({ priority: 2.5 }));
    await w
      .get('[data-test="drawer-priority-option-very_high"]')
      .trigger("click");
    await vi.waitFor(() => {
      expect(w.get('[data-test="drawer-priority-error"]').text()).toContain(
        "Invalid priority",
      );
    });
  });
});
