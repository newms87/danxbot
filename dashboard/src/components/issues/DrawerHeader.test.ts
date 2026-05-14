import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import DrawerHeader from "./DrawerHeader.vue";
import type { IssueDetail } from "../../types";

vi.mock("../../api", () => ({
  patchIssue: vi.fn(),
}));

import { patchIssue } from "../../api";
const patchMock = vi.mocked(patchIssue);

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
    schema_version: 7,
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
