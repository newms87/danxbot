import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import OverviewTab from "./OverviewTab.vue";
import type { IssueDetail } from "../../types";

vi.mock("../../api", () => ({
  patchIssue: vi.fn(),
}));

import { patchIssue } from "../../api";
const patchMock = vi.mocked(patchIssue);

const MarkdownEditorStub = defineComponent({
  name: "MarkdownEditor",
  props: {
    modelValue: { type: String, default: "" },
    readonly: { type: Boolean, default: false },
    hideFooter: { type: Boolean, default: false },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h(
        "div",
        { class: "md-stub", "data-readonly": props.readonly ? "yes" : "no" },
        [
          h("textarea", {
            class: "md-stub-input",
            value: props.modelValue,
            onInput: (e: Event) =>
              emit(
                "update:modelValue",
                (e.target as HTMLTextAreaElement).value,
              ),
          }),
        ],
      );
  },
});

function makeDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    schema_version: 12,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Card",
    description: "Original description body",
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

function mountTab(detail: IssueDetail = makeDetail()) {
  return mount(OverviewTab, {
    props: { issue: detail, repo: "danxbot" },
    global: { stubs: { MarkdownEditor: MarkdownEditorStub } },
  });
}

describe("OverviewTab description editor", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("renders the description in readonly mode by default with an Edit button", () => {
    const w = mountTab();
    expect(w.find('[data-test="overview-edit-description"]').exists()).toBe(
      true,
    );
    // Initial editor is readonly (assertion via the stub's data attribute).
    expect(w.get(".md-stub").attributes("data-readonly")).toBe("yes");
    expect(w.find('[data-test="overview-description-editor"]').exists()).toBe(
      false,
    );
  });

  it("clicking Edit mounts the MarkdownEditor in edit mode pre-filled with the current description", async () => {
    const w = mountTab();
    await w.get('[data-test="overview-edit-description"]').trigger("click");
    // DX-299: v-if mount race under full-suite CPU contention — vi.waitFor
    // polls until the editor is observable. See DX-262
    // RequiresHumanPanel.test.ts for the canonical mechanism description.
    await vi.waitFor(() =>
      expect(
        w.find('[data-test="overview-description-editor"]').exists(),
      ).toBe(true),
    );
    const editor = w.get('[data-test="overview-description-editor"]');
    expect(editor.attributes("data-readonly")).toBe("no");
    expect(w.find('[data-test="overview-save-description"]').exists()).toBe(
      true,
    );
    expect(w.find('[data-test="overview-cancel-description"]').exists()).toBe(
      true,
    );
  });

  it("Save calls patchIssue with the edited description and emits update:issue", async () => {
    const patched = makeDetail({
      description: "Rewritten body",
    });
    patchMock.mockResolvedValue({ issue: patched, item: patched as unknown as import("../../types").IssueListItem });

    const w = mountTab();
    await w.get('[data-test="overview-edit-description"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(
        w.find('[data-test="overview-description-editor"]').exists(),
      ).toBe(true),
    );
    await w
      .get('[data-test="overview-description-editor"]')
      .find("textarea")
      .setValue("Rewritten body");
    await w.get('[data-test="overview-save-description"]').trigger("click");

    // DX-299: post-click PATCH call-count race after the async save cascade.
    await vi.waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
        description: "Rewritten body",
      });
    });
    // DX-299: the emit fires AFTER the awaited PATCH resolves; wrap in
    // its own vi.waitFor (DX-262 canonical pattern).
    await vi.waitFor(() => {
      const events = w.emitted("update:issue");
      expect(events).toBeTruthy();
      expect(events![0][0]).toBe(patched);
    });
    // DX-299: exit-edit-mode transition race.
    await vi.waitFor(() =>
      expect(
        w.find('[data-test="overview-description-editor"]').exists(),
      ).toBe(false),
    );
  });

  it("Cancel exits edit mode without writing — no PATCH, original description retained", async () => {
    const w = mountTab();
    await w.get('[data-test="overview-edit-description"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(
        w.find('[data-test="overview-description-editor"]').exists(),
      ).toBe(true),
    );
    await w
      .get('[data-test="overview-description-editor"]')
      .find("textarea")
      .setValue("Cancelled draft");
    await w.get('[data-test="overview-cancel-description"]').trigger("click");

    // DX-299: exit-edit-mode transition race.
    await vi.waitFor(() =>
      expect(
        w.find('[data-test="overview-description-editor"]').exists(),
      ).toBe(false),
    );
    // DX-299: negative — drain macrotasks before the not-called check.
    await flushPromises();
    expect(patchMock).not.toHaveBeenCalled();
    expect(w.emitted("update:issue")).toBeUndefined();
    expect(w.get(".md-stub").attributes("data-readonly")).toBe("yes");
  });

  it("switching to a different issue mid-edit drops the edit state and clears the draft", async () => {
    const w = mountTab();
    await w.get('[data-test="overview-edit-description"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(
        w.find('[data-test="overview-description-editor"]').exists(),
      ).toBe(true),
    );
    await w
      .get('[data-test="overview-description-editor"]')
      .find("textarea")
      .setValue("Draft text");

    await w.setProps({
      issue: makeDetail({ id: "DX-2", description: "Other body" }),
    });

    // DX-299: prop-change unmount race.
    await vi.waitFor(() =>
      expect(
        w.find('[data-test="overview-description-editor"]').exists(),
      ).toBe(false),
    );
    expect(w.find('[data-test="overview-edit-description"]').exists()).toBe(
      true,
    );
  });

  it("surfaces the server error on save failure and keeps edit mode active", async () => {
    patchMock.mockRejectedValue(new Error("write failed"));

    const w = mountTab();
    await w.get('[data-test="overview-edit-description"]').trigger("click");
    // DX-299: v-if mount race.
    await vi.waitFor(() =>
      expect(
        w.find('[data-test="overview-description-editor"]').exists(),
      ).toBe(true),
    );
    await w
      .get('[data-test="overview-description-editor"]')
      .find("textarea")
      .setValue("Whatever");
    await w.get('[data-test="overview-save-description"]').trigger("click");

    // DX-299: server-error render state-transition race.
    await vi.waitFor(() => {
      expect(
        w.get('[data-test="overview-description-error"]').text(),
      ).toContain("write failed");
    });
    expect(w.find('[data-test="overview-description-editor"]').exists()).toBe(
      true,
    );
    expect(w.emitted("update:issue")).toBeUndefined();
  });
});

// Dispatch-gates coverage migrated to DispatchGatesSection.test.ts — the
// gates section was lifted out of OverviewTab into a pinned sub-header
// rendered by IssueDetailView between DrawerHeader and the tabs.
