import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import DrawerHeader from "./DrawerHeader.vue";
import type { Issue, IssueDetail } from "../../types";

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
    schema_version: 6,
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
    assigned_agent: null,
    updated_at: 0,
    created_at: 0,
    raw_yaml: "",
    ...overrides,
  } as unknown as IssueDetail;
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
    const input = w.get('[data-test="drawer-title-input"]');
    expect((input.element as HTMLInputElement).value).toBe("Original Title");
    // Original h2 is gone.
    expect(w.find('[data-test="drawer-title"]').exists()).toBe(false);
  });

  it("Enter saves: calls patchIssue with the new title and emits update:issue", async () => {
    const patched = makeDetail({ title: "New Title" }) as unknown as Issue;
    patchMock.mockResolvedValue(patched);

    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    const input = w.get('[data-test="drawer-title-input"]');
    await input.setValue("New Title");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();

    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
      title: "New Title",
    });
    const events = w.emitted("update:issue");
    expect(events).toBeTruthy();
    expect(events![0][0]).toBe(patched);
    // Exits edit mode after success.
    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(false);
  });

  it("Esc cancels: does not call patchIssue and reverts to the read state", async () => {
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    const input = w.get('[data-test="drawer-title-input"]');
    await input.setValue("Half-typed never sent");
    await input.trigger("keydown", { key: "Escape" });
    await flushPromises();

    expect(patchMock).not.toHaveBeenCalled();
    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(false);
    expect(w.get('[data-test="drawer-title"]').text()).toBe("Original Title");
  });

  it("empty title is rejected client-side — error shown, stay in edit mode, no PATCH fired", async () => {
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    const input = w.get('[data-test="drawer-title-input"]');
    await input.setValue("   ");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();

    expect(patchMock).not.toHaveBeenCalled();
    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true);
    expect(w.get('[data-test="drawer-title-error"]').text()).toContain(
      "Title cannot be empty",
    );
  });

  it("no PATCH fires when the title is unchanged after Enter", async () => {
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    await w.get('[data-test="drawer-title-input"]')
      .trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(false);
  });

  it("switching to a different issue mid-edit resets to read state", async () => {
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true);

    await w.setProps({ issue: makeDetail({ id: "DX-2", title: "Other" }) });

    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(false);
    expect(w.get('[data-test="drawer-title"]').text()).toBe("Other");
  });

  it("Enter on the read-mode title (keyboard activation) enters edit mode", async () => {
    const w = mountHeader();
    await w
      .get('[data-test="drawer-title"]')
      .trigger("keydown", { key: "Enter" });
    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true);
  });

  it("surfaces the server error on PATCH failure and stays in edit mode", async () => {
    patchMock.mockRejectedValue(new Error("conflict"));
    const w = mountHeader();
    await w.get('[data-test="drawer-title"]').trigger("click");
    const input = w.get('[data-test="drawer-title-input"]');
    await input.setValue("Different");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();

    expect(w.find('[data-test="drawer-title-input"]').exists()).toBe(true);
    expect(w.get('[data-test="drawer-title-error"]').text()).toContain(
      "conflict",
    );
    expect(w.emitted("update:issue")).toBeUndefined();
  });
});
