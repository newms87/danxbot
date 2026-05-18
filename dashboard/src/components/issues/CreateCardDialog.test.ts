import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import type { Component } from "vue";
import CreateCardDialog from "./CreateCardDialog.vue";
import type { Issue } from "../../types";

vi.mock("../../api", () => ({
  createIssue: vi.fn(),
  fleshOutIssue: vi.fn(),
}));

import { createIssue, fleshOutIssue } from "../../api";
const createMock = vi.mocked(createIssue);
const fleshMock = vi.mocked(fleshOutIssue);

// Wraps a stub Issue into the {issue, item} wire shape the server returns.
// Component only reads `.issue.id`; `item` is a typed placeholder.
function wrap(
  issue: Issue,
): { issue: Issue; item: import("../../types").IssueListItem } {
  return { issue, item: issue as unknown as import("../../types").IssueListItem };
}

/**
 * DanxDialog stub renders the dialog inline as a teleport-less wrapper
 * so `@vue/test-utils` can reach the inner form. We expose the v-model
 * via attrs and re-emit `confirm` / `close` directly so the dialog's
 * built-in buttons can drive the component without rendering the real
 * (CSS-token-dependent) DanxDialog markup.
 */
const DanxDialogStub = defineComponent({
  name: "DanxDialog",
  props: [
    "modelValue",
    "title",
    "subtitle",
    "persistent",
    "isSaving",
    "disabled",
    "closeButton",
    "confirmButton",
    "width",
  ],
  emits: ["update:modelValue", "close", "confirm"],
  template: `
    <div v-if="modelValue" class="dialog-stub" data-test="danx-dialog-stub">
      <h2>{{ title }}</h2>
      <p>{{ subtitle }}</p>
      <slot />
      <button
        type="button"
        data-test="dialog-confirm"
        :disabled="disabled || isSaving"
        @click="$emit('confirm')"
      >{{ confirmButton }}</button>
      <button
        type="button"
        data-test="dialog-close"
        :disabled="persistent"
        @click="$emit('close'); $emit('update:modelValue', false)"
      >{{ closeButton }}</button>
    </div>
  `,
});

/**
 * DX-544 — DanxTabs stub. The real component reads `tabs[]` + emits
 * `update:modelValue` on tab click. We render one button per tab with
 * a data-test target containing the tab value so the test can assert
 * (a) the tab list, (b) per-tab `color` propagation, and (c) click →
 * model update.
 */
const DanxTabsStub = defineComponent({
  name: "DanxTabs",
  props: {
    modelValue: { type: String, required: true },
    tabs: { type: Array, required: true },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h(
        "div",
        { class: "danx-tabs-stub" },
        (
          props.tabs as Array<{ value: string; label: string; activeColor?: string }>
        )
          .map((t) =>
            h(
              "button",
              {
                type: "button",
                "data-test": `tab-${t.value}`,
                "data-active-color": t.activeColor ?? "",
                class: props.modelValue === t.value ? "active" : "",
                onClick: () => emit("update:modelValue", t.value),
              },
              t.label,
            ),
          ),
      );
  },
});

/**
 * DX-544 — MarkdownEditor stub. The real component is a heavy markdown
 * surface; for the dialog tests we only need v-model parity so submission
 * sees the operator's text. Render as a `<textarea>` with a stable
 * data-test target.
 */
const MarkdownEditorStub = defineComponent({
  name: "MarkdownEditor",
  props: {
    modelValue: { type: String, default: "" },
    hideFooter: { type: Boolean, default: false },
    readonly: { type: Boolean, default: false },
  },
  emits: ["update:modelValue"],
  inheritAttrs: false,
  methods: {
    onInput(e: Event): void {
      (this as unknown as { $emit: (n: string, v: string) => void }).$emit(
        "update:modelValue",
        (e.target as HTMLTextAreaElement).value,
      );
    },
  },
  template: `
    <textarea
      data-test="markdown-editor-stub"
      :value="modelValue"
      @input="onInput"
    />
  `,
});

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 11,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "Review",
    type: "Feature",
    title: "Test",
    description: "Body",
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
    ...overrides,
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };
}

function mountDialog(open = true) {
  return mount(CreateCardDialog, {
    props: { modelValue: open, repo: "danxbot" },
    global: {
      stubs: {
        DanxDialog: DanxDialogStub as unknown as Component,
        DanxTabs: DanxTabsStub as unknown as Component,
        MarkdownEditor: MarkdownEditorStub as unknown as Component,
      },
    },
  });
}

describe("CreateCardDialog", () => {
  beforeEach(() => {
    createMock.mockReset();
    fleshMock.mockReset();
  });

  it("renders title, status tabs, type tabs, priority, description editor when open", () => {
    const w = mountDialog(true);
    expect(w.find("[data-test='create-card-title']").exists()).toBe(true);
    expect(w.find("[data-test='create-card-status']").exists()).toBe(true);
    expect(w.find("[data-test='create-card-type']").exists()).toBe(true);
    expect(w.find("[data-test='create-card-priority']").exists()).toBe(true);
    expect(w.find("[data-test='create-card-description-wrap']").exists()).toBe(true);
    expect(w.find("[data-test='markdown-editor-stub']").exists()).toBe(true);
  });

  it("DX-544 — Status tabs render Review + ToDo with per-tab color", () => {
    const w = mountDialog(true);
    const review = w.get("[data-test='tab-Review']");
    const todo = w.get("[data-test='tab-ToDo']");
    expect(review.attributes("data-active-color")).toBe("#a78bfa");
    expect(todo.attributes("data-active-color")).toBe("#64748b");
  });

  it("DX-544 — Type tabs render Bug/Feature/Epic/Chore with per-tab color", () => {
    const w = mountDialog(true);
    expect(w.find("[data-test='tab-Bug']").exists()).toBe(true);
    expect(w.find("[data-test='tab-Feature']").exists()).toBe(true);
    expect(w.find("[data-test='tab-Epic']").exists()).toBe(true);
    expect(w.find("[data-test='tab-Chore']").exists()).toBe(true);
    expect(w.get("[data-test='tab-Bug']").attributes("data-active-color")).toBe("#fca5a5");
    expect(w.get("[data-test='tab-Feature']").attributes("data-active-color")).toBe("#86efac");
  });

  it("DX-544 — defaults status=Review, type=Feature, priority=medium (3.0)", () => {
    const w = mountDialog(true);
    expect(w.get("[data-test='tab-Review']").classes()).toContain("active");
    expect(w.get("[data-test='tab-Feature']").classes()).toContain("active");
    expect(w.get("[data-test='priority-medium']").classes()).toContain("active");
  });

  it("DX-544 — clicking a status tab updates the bound status", async () => {
    const w = mountDialog(true);
    await w.get("[data-test='tab-ToDo']").trigger("click");
    expect(w.get("[data-test='tab-ToDo']").classes()).toContain("active");
    expect(w.get("[data-test='tab-Review']").classes()).not.toContain("active");
  });

  it("DX-544 — clicking a priority tier commits its defaultValue", async () => {
    createMock.mockResolvedValueOnce(wrap(makeIssue({ id: "DX-9" })));
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("T");
    await w.find("[data-test='markdown-editor-stub']").setValue("Body");
    await w.get("[data-test='priority-high']").trigger("click");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();
    expect(createMock).toHaveBeenCalledWith("danxbot", {
      title: "T",
      description: "Body",
      status: "Review",
      type: "Feature",
      priority: 3.5,
    });
  });

  it("DX-544 — renders LLM helper note above the description editor", () => {
    const w = mountDialog(true);
    const note = w.find("[data-test='create-card-llm-note']");
    expect(note.exists()).toBe(true);
    expect(note.text().toLowerCase()).toContain("llm");
  });

  it("DX-544 — Description renders LAST in the form (after Title/Status/Type/Priority)", () => {
    const w = mountDialog(true);
    const fields = w.findAll(".field");
    // Order: Title, Status, Type, Priority, Description (with helper + editor).
    expect(fields[0].find("[data-test='create-card-title']").exists()).toBe(true);
    expect(fields[1].attributes("data-test")).toBe("create-card-status");
    expect(fields[2].attributes("data-test")).toBe("create-card-type");
    expect(fields[3].attributes("data-test")).toBe("create-card-priority");
    expect(fields[4].find("[data-test='create-card-description-wrap']").exists()).toBe(true);
  });

  it("does not render when closed", () => {
    const w = mountDialog(false);
    expect(w.find("[data-test='create-card-form']").exists()).toBe(false);
  });

  it("disables confirm when title is empty", async () => {
    const w = mountDialog(true);
    await w.find("[data-test='markdown-editor-stub']").setValue("Body");
    const confirm = w.get<HTMLButtonElement>("[data-test='dialog-confirm']");
    expect(confirm.element.disabled).toBe(true);
  });

  it("disables confirm when description is empty", async () => {
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("Test");
    const confirm = w.get<HTMLButtonElement>("[data-test='dialog-confirm']");
    expect(confirm.element.disabled).toBe(true);
  });

  it("enables confirm when both title and description are non-empty", async () => {
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("Test");
    await w.find("[data-test='markdown-editor-stub']").setValue("Body");
    const confirm = w.get<HTMLButtonElement>("[data-test='dialog-confirm']");
    expect(confirm.element.disabled).toBe(false);
  });

  it("submits with form values + fires flesh-out + closes on success", async () => {
    createMock.mockResolvedValueOnce(wrap(makeIssue({ id: "DX-5", title: "Foo" })));
    fleshMock.mockResolvedValueOnce({ jobId: "j-1" });
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("Foo");
    await w.find("[data-test='markdown-editor-stub']").setValue("Bar");
    await w.get("[data-test='tab-ToDo']").trigger("click");
    await w.get("[data-test='tab-Bug']").trigger("click");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith("danxbot", {
      title: "Foo",
      description: "Bar",
      status: "ToDo",
      type: "Bug",
      priority: 2.5,
    });
    expect(fleshMock).toHaveBeenCalledWith("danxbot", "DX-5");
    expect(w.emitted("created")).toEqual([["DX-5"]]);
    const modelEvents = w.emitted("update:modelValue") ?? [];
    expect(modelEvents.at(-1)).toEqual([false]);
  });

  it("trims whitespace from title and description before submitting", async () => {
    createMock.mockResolvedValueOnce(wrap(makeIssue()));
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("  Padded  ");
    await w
      .find("[data-test='markdown-editor-stub']")
      .setValue("  Body  ");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();
    expect(createMock).toHaveBeenCalledWith("danxbot", {
      title: "Padded",
      description: "Body",
      status: "Review",
      type: "Feature",
      priority: 2.5,
    });
  });

  it("surfaces a 400 error message inline and keeps the dialog open", async () => {
    createMock.mockRejectedValueOnce(new Error("title must be a non-empty string"));
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("x");
    await w.find("[data-test='markdown-editor-stub']").setValue("y");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();
    const err = w.find("[data-test='create-card-error']");
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain("title must be a non-empty string");
    const last = (w.emitted("update:modelValue") ?? []).at(-1);
    expect(last).toBeUndefined();
    expect(w.emitted("created")).toBeUndefined();
  });

  it("does not fail the create when flesh-out rejects (fire-and-forget)", async () => {
    createMock.mockResolvedValueOnce(wrap(makeIssue({ id: "DX-7" })));
    fleshMock.mockRejectedValueOnce(new Error("worker timeout"));
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("Foo");
    await w.find("[data-test='markdown-editor-stub']").setValue("Bar");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();
    expect(w.emitted("created")).toEqual([["DX-7"]]);
    expect(w.find("[data-test='create-card-error']").exists()).toBe(false);
  });

  it("resets form state when reopened after a previous error", async () => {
    createMock.mockRejectedValueOnce(new Error("boom"));
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("Old");
    await w.find("[data-test='markdown-editor-stub']").setValue("Stale");
    await w.get("[data-test='priority-high']").trigger("click");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();
    expect(w.find("[data-test='create-card-error']").exists()).toBe(true);

    // Close + reopen via prop flip.
    await w.setProps({ modelValue: false });
    await w.setProps({ modelValue: true });

    expect(w.find("[data-test='create-card-error']").exists()).toBe(false);
    const titleInput = w.get<HTMLInputElement>("[data-test='create-card-title']");
    expect(titleInput.element.value).toBe("");
    // Defaults restored: Review status, Feature type, medium priority.
    expect(w.get("[data-test='tab-Review']").classes()).toContain("active");
    expect(w.get("[data-test='tab-Feature']").classes()).toContain("active");
    expect(w.get("[data-test='priority-medium']").classes()).toContain("active");
  });
});
