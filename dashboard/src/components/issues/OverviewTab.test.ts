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
    schema_version: 7,
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
    const editor = w.get('[data-test="overview-description-editor"]');
    // `get` would have thrown if missing — capture the assertion as a
    // sanity check via attributes() instead.
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
    patchMock.mockResolvedValue(patched);

    const w = mountTab();
    await w.get('[data-test="overview-edit-description"]').trigger("click");
    // Type into the stubbed editor.
    await w
      .get('[data-test="overview-description-editor"]')
      .find("textarea")
      .setValue("Rewritten body");
    await w.get('[data-test="overview-save-description"]').trigger("click");
    await flushPromises();

    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
      description: "Rewritten body",
    });
    const events = w.emitted("update:issue");
    expect(events).toBeTruthy();
    expect(events![0][0]).toBe(patched);
    // Exits edit mode.
    expect(w.find('[data-test="overview-description-editor"]').exists()).toBe(
      false,
    );
  });

  it("Cancel exits edit mode without writing — no PATCH, original description retained", async () => {
    const w = mountTab();
    await w.get('[data-test="overview-edit-description"]').trigger("click");
    await w
      .get('[data-test="overview-description-editor"]')
      .find("textarea")
      .setValue("Cancelled draft");
    await w.get('[data-test="overview-cancel-description"]').trigger("click");
    await flushPromises();

    expect(patchMock).not.toHaveBeenCalled();
    expect(w.find('[data-test="overview-description-editor"]').exists()).toBe(
      false,
    );
    expect(w.emitted("update:issue")).toBeUndefined();
    // Read-mode editor is back with the original content.
    expect(w.get(".md-stub").attributes("data-readonly")).toBe("yes");
  });

  it("switching to a different issue mid-edit drops the edit state and clears the draft", async () => {
    const w = mountTab();
    await w.get('[data-test="overview-edit-description"]').trigger("click");
    await w
      .get('[data-test="overview-description-editor"]')
      .find("textarea")
      .setValue("Draft text");
    expect(w.find('[data-test="overview-description-editor"]').exists()).toBe(
      true,
    );

    await w.setProps({
      issue: makeDetail({ id: "DX-2", description: "Other body" }),
    });

    expect(w.find('[data-test="overview-description-editor"]').exists()).toBe(
      false,
    );
    expect(w.find('[data-test="overview-edit-description"]').exists()).toBe(
      true,
    );
  });

  it("surfaces the server error on save failure and keeps edit mode active", async () => {
    patchMock.mockRejectedValue(new Error("write failed"));

    const w = mountTab();
    await w.get('[data-test="overview-edit-description"]').trigger("click");
    await w
      .get('[data-test="overview-description-editor"]')
      .find("textarea")
      .setValue("Whatever");
    await w.get('[data-test="overview-save-description"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="overview-description-editor"]').exists()).toBe(
      true,
    );
    expect(w.get('[data-test="overview-description-error"]').text()).toContain(
      "write failed",
    );
    expect(w.emitted("update:issue")).toBeUndefined();
  });
});

describe("OverviewTab — Dispatch gates section (DX-309)", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("hides the section iff every gate is empty", () => {
    const w = mountTab();
    expect(w.find('[data-test="dispatch-gates"]').exists()).toBe(false);
  });

  it("renders only the Blocked subsection when blocked is set", () => {
    const w = mountTab(
      makeDetail({
        status: "Blocked",
        blocked: { reason: "needs creds", timestamp: "2026-05-12T00:00:00Z" },
      }),
    );
    expect(w.get('[data-test="gate-blocked"]').text()).toContain("needs creds");
    expect(w.find('[data-test="gate-waiting"]').exists()).toBe(false);
    expect(w.find('[data-test="gate-conflict"]').exists()).toBe(false);
  });

  it("Clear button on Blocked PATCHes blocked: null + status: ToDo", async () => {
    patchMock.mockResolvedValue(
      makeDetail({ status: "ToDo", blocked: null }) as never,
    );
    const w = mountTab(
      makeDetail({
        status: "Blocked",
        blocked: { reason: "x", timestamp: "2026-05-12T00:00:00Z" },
      }),
    );
    await w.get('[data-test="clear-blocked"]').trigger("click");
    await flushPromises();
    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
      blocked: null,
      status: "ToDo",
    });
    expect(w.emitted("update:issue")).toHaveLength(1);
  });

  it("renders Waiting-on subsection with partner chips and resolved status", () => {
    const w = mountTab(
      makeDetail({
        waiting_on: {
          reason: "phase 1 first",
          timestamp: "2026-05-12T00:00:00Z",
          by: ["DX-5"],
        },
        conflict_on_partners: {
          "DX-5": { status: "In Progress", title: "Phase 1 schema" },
        },
      }),
    );
    const section = w.get('[data-test="gate-waiting"]');
    expect(section.text()).toContain("phase 1 first");
    expect(section.text()).toContain("DX-5");
    expect(section.text()).toContain("In Progress");
    expect(section.text()).toContain("Phase 1 schema");
  });

  it("renders Conflict subsection with forward entries + per-entry Clear button", async () => {
    patchMock.mockResolvedValue(
      makeDetail({ conflict_on: [] }) as never,
    );
    const w = mountTab(
      makeDetail({
        conflict_on: [{ id: "DX-9", reason: "scheduler.ts collision" }],
        conflict_on_partners: {
          "DX-9": { status: "In Progress", title: "Other work" },
        },
      }),
    );
    const section = w.get('[data-test="gate-conflict"]');
    expect(section.text()).toContain("DX-9");
    expect(section.text()).toContain("scheduler.ts collision");
    await w.get('[data-test="clear-conflict-DX-9"]').trigger("click");
    await flushPromises();
    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
      conflict_on: [],
    });
  });

  it("renders reverse-conflict entries from conflict_on_reverse", () => {
    const w = mountTab(
      makeDetail({
        conflict_on_reverse: [{ id: "DX-9", reason: "partner declared" }],
        conflict_on_partners: {
          "DX-9": { status: "In Progress", title: "Partner work" },
        },
      }),
    );
    const section = w.get('[data-test="gate-conflict"]');
    expect(section.text()).toContain("declared on partner");
    expect(section.text()).toContain("DX-9");
  });

  it("renders all three subsections together when every gate is active", () => {
    const w = mountTab(
      makeDetail({
        status: "Blocked",
        blocked: { reason: "a", timestamp: "2026-05-12T00:00:00Z" },
        waiting_on: {
          reason: "b",
          timestamp: "2026-05-12T00:00:00Z",
          by: ["DX-2"],
        },
        conflict_on: [{ id: "DX-9", reason: "c" }],
      }),
    );
    expect(w.find('[data-test="gate-blocked"]').exists()).toBe(true);
    expect(w.find('[data-test="gate-waiting"]').exists()).toBe(true);
    expect(w.find('[data-test="gate-conflict"]').exists()).toBe(true);
  });
});
