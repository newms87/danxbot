import { describe, it, expect } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import EpicMoveCascadeDialog from "./EpicMoveCascadeDialog.vue";
import type { CascadeAction } from "../../api";
import type { IssueListItem, List } from "../../types";

// DanxUI stubs — keep them dumb pass-throughs so the dialog body
// renders inline and the test can locate banners / rows / inputs via
// the dialog's own data-test attributes. The stubs forward
// `update:modelValue` so v-model wiring still round-trips.

const DanxDialogStub = defineComponent({
  name: "DanxDialog",
  props: {
    modelValue: Boolean,
    title: String,
    closeButton: [String, Boolean],
    confirmButton: [String, Boolean],
    isSaving: Boolean,
    disabled: Boolean,
    persistent: Boolean,
    variant: String,
    width: String,
    height: String,
    closeX: Boolean,
  },
  emits: ["update:modelValue", "close", "confirm"],
  setup(props, { slots, emit }) {
    return () =>
      h("div", { class: "stub-danx-dialog" }, [
        h("div", { class: "stub-dialog-body" }, slots.default?.()),
        h(
          "button",
          {
            class: "stub-dialog-confirm",
            "data-test": "stub-dialog-confirm",
            disabled: props.disabled ? "disabled" : undefined,
            onClick: () => {
              if (!props.disabled) emit("confirm");
            },
          },
          "Confirm",
        ),
        h(
          "button",
          {
            class: "stub-dialog-cancel",
            "data-test": "stub-dialog-cancel",
            onClick: () => emit("close"),
          },
          "Cancel",
        ),
      ]);
  },
});

const DanxSelectStub = defineComponent({
  name: "DanxSelect",
  props: {
    modelValue: { type: [String, Number, Array, null], default: null },
    options: { type: Array, default: () => [] },
  },
  emits: ["update:modelValue"],
  setup(props, { emit, attrs }) {
    return () =>
      h(
        "select",
        {
          ...attrs,
          value: props.modelValue ?? "",
          onChange: (e: Event) =>
            emit("update:modelValue", (e.target as HTMLSelectElement).value),
        },
        (props.options as Array<{ value: string; label: string }>).map((o) =>
          h("option", { value: o.value }, o.label),
        ),
      );
  },
});

const DanxTextareaStub = defineComponent({
  name: "DanxTextarea",
  props: {
    modelValue: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit, attrs }) {
    return () =>
      h("textarea", {
        ...attrs,
        value: props.modelValue,
        onInput: (e: Event) =>
          emit("update:modelValue", (e.target as HTMLTextAreaElement).value),
      });
  },
});

const DanxToggleStub = defineComponent({
  name: "DanxToggle",
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: ["update:modelValue"],
  setup(props, { emit, attrs }) {
    return () =>
      h("input", {
        ...attrs,
        type: "checkbox",
        checked: props.modelValue,
        onChange: (e: Event) =>
          emit("update:modelValue", (e.target as HTMLInputElement).checked),
      });
  },
});

const globalStubs = {
  DanxDialog: DanxDialogStub,
  DanxSelect: DanxSelectStub,
  DanxTextarea: DanxTextareaStub,
  DanxToggle: DanxToggleStub,
};

function makeIssue(over: Partial<IssueListItem> & Pick<IssueListItem, "id">): IssueListItem {
  return {
    id: over.id,
    type: over.type ?? "Feature",
    title: over.title ?? `Title ${over.id}`,
    description: over.description ?? "",
    status: over.status ?? "Review",
    parent_id: over.parent_id ?? null,
    children: over.children ?? [],
    ac_total: 0,
    ac_done: 0,
    children_detail: [],
    waiting_on: false,
    waiting_on_reason: null,
    waiting_on_by: [],
    comments_count: 0,
    has_retro: false,
    updated_at: Date.now(),
    created_at: Date.now(),
    requires_human: null,
    requires_human_child_count: 0,
    blocked: over.blocked ?? null,
    list_name: over.list_name ?? "Review",
    priority: over.priority ?? 1,
    assigned_agent: null,
  } as unknown as IssueListItem;
}

function makeList(over: Partial<List> & Pick<List, "id" | "name" | "type">): List {
  return {
    id: over.id,
    name: over.name,
    type: over.type,
    order: over.order ?? 0,
    is_default_for_type: over.is_default_for_type ?? false,
    color: over.color ?? "#ccc",
  };
}

const allLists: List[] = [
  makeList({ id: "L-review", name: "Review", type: "review" }),
  makeList({ id: "L-todo", name: "ToDo", type: "ready" }),
  makeList({ id: "L-prog", name: "In Progress", type: "in_progress" }),
  makeList({ id: "L-blocked", name: "Blocked", type: "blocked" }),
  makeList({ id: "L-done", name: "Done", type: "completed" }),
  makeList({ id: "L-cancelled", name: "Cancelled", type: "cancelled" }),
];

function mountDialog(props: Partial<{
  parent: IssueListItem;
  destList: List;
  descendants: IssueListItem[];
  defaults: Record<string, CascadeAction>;
  busy: boolean;
  error: string | null;
}> = {}) {
  const parent =
    props.parent ??
    makeIssue({ id: "DX-100", type: "Epic", children: ["DX-101", "DX-102"], list_name: "Review" });
  const destList = props.destList ?? makeList({ id: "L-cancelled", name: "Cancelled", type: "cancelled" });
  const descendants =
    props.descendants ??
    [
      makeIssue({ id: "DX-101", parent_id: "DX-100", status: "Review" }),
      makeIssue({ id: "DX-102", parent_id: "DX-100", status: "Review" }),
    ];
  const defaults: Record<string, CascadeAction> =
    props.defaults ??
    Object.fromEntries(descendants.map((d) => [d.id, { kind: "move_same_type" } satisfies CascadeAction]));
  return mount(EpicMoveCascadeDialog, {
    props: {
      modelValue: true,
      parent,
      destList,
      descendants,
      defaults,
      allLists,
      busy: props.busy ?? false,
      error: props.error ?? null,
    },
    global: { stubs: globalStubs },
  });
}

describe("EpicMoveCascadeDialog", () => {
  it("renders one row per descendant with id + title visible", async () => {
    const w = mountDialog();
    await flushPromises();
    const rows = w.findAll('[data-test="cascade-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].text()).toContain("DX-101");
    expect(rows[1].text()).toContain("DX-102");
  });

  it("sorts rows within a group by priority DESC", async () => {
    const parent = makeIssue({
      id: "DX-220",
      type: "Epic",
      children: ["DX-221", "DX-222", "DX-223"],
    });
    // Pass BFS-flattened order intentionally NOT priority-sorted —
    // dialog is responsible for re-sorting within group by priority DESC.
    const descendants = [
      makeIssue({ id: "DX-221", parent_id: "DX-220", priority: 1 }),
      makeIssue({ id: "DX-222", parent_id: "DX-220", priority: 5 }),
      makeIssue({ id: "DX-223", parent_id: "DX-220", priority: 3 }),
    ];
    const defaults: Record<string, CascadeAction> = {
      "DX-221": { kind: "move_same_type" },
      "DX-222": { kind: "move_same_type" },
      "DX-223": { kind: "move_same_type" },
    };
    const w = mountDialog({ parent, descendants, defaults });
    await flushPromises();
    const rows = w.findAll('[data-test="cascade-row"]');
    expect(rows.length).toBe(3);
    expect(rows[0].attributes("data-row-id")).toBe("DX-222"); // priority 5
    expect(rows[1].attributes("data-row-id")).toBe("DX-223"); // priority 3
    expect(rows[2].attributes("data-row-id")).toBe("DX-221"); // priority 1
  });

  it("groups rows by direct parent_id with header per group", async () => {
    const parent = makeIssue({
      id: "DX-200",
      type: "Epic",
      children: ["DX-201", "DX-210"],
      list_name: "Review",
    });
    const descendants = [
      makeIssue({ id: "DX-201", parent_id: "DX-200", status: "Review" }),
      makeIssue({ id: "DX-210", parent_id: "DX-200", status: "Review" }),
      // Sub-child of DX-210 — separate group
      makeIssue({ id: "DX-211", parent_id: "DX-210", status: "Review" }),
    ];
    const defaults: Record<string, CascadeAction> = {
      "DX-201": { kind: "move_same_type" },
      "DX-210": { kind: "move_same_type" },
      "DX-211": { kind: "move_same_type" },
    };
    const w = mountDialog({ parent, descendants, defaults });
    await flushPromises();
    const groups = w.findAll('[data-test="cascade-group"]');
    // Two distinct parent_ids → two groups
    expect(groups.length).toBe(2);
    expect(groups[0].find('[data-test="cascade-group-header"]').text()).toContain("DX-200");
    expect(groups[1].find('[data-test="cascade-group-header"]').text()).toContain("DX-210");
  });

  it("pre-selects each row's dropdown to 'Apply default' + surfaces the spec-default in the label", async () => {
    const descendants = [
      makeIssue({ id: "DX-301", parent_id: "DX-300" }),
      makeIssue({ id: "DX-302", parent_id: "DX-300" }),
    ];
    const defaults: Record<string, CascadeAction> = {
      "DX-301": { kind: "stay" },
      "DX-302": { kind: "move_same_type" },
    };
    const parent = makeIssue({ id: "DX-300", type: "Epic", children: ["DX-301", "DX-302"] });
    const w = mountDialog({ parent, destList: makeList({ id: "L-cancelled", name: "Cancelled", type: "cancelled" }), descendants, defaults });
    await flushPromises();
    const selects = w.findAll('[data-test="cascade-action-select"]');
    expect(selects.length).toBe(2);
    // Both rows pre-select "default" → the operator sees a consistent
    // "Apply default (…)" label whose body surfaces the spec-computed
    // action. Submitting without override elides the row from `overrides`
    // so the server's helper re-derives via the canonical spec table.
    expect((selects[0].element as HTMLSelectElement).value).toBe("default");
    expect((selects[1].element as HTMLSelectElement).value).toBe("default");
    // The "Apply default" option's label carries the resolved action so
    // the operator can read what the default IS without dropping the menu.
    const opt0Default = selects[0].findAll("option").find((o) => o.element.value === "default");
    expect(opt0Default?.text()).toMatch(/Stay/);
    const opt1Default = selects[1].findAll("option").find((o) => o.element.value === "default");
    expect(opt1Default?.text()).toMatch(/Move to Cancelled/);
  });

  it("operator override → submit payload carries overrides[id] = chosen action", async () => {
    const descendants = [
      makeIssue({ id: "DX-401", parent_id: "DX-400" }),
      makeIssue({ id: "DX-402", parent_id: "DX-400" }),
    ];
    const defaults: Record<string, CascadeAction> = {
      "DX-401": { kind: "move_same_type" },
      "DX-402": { kind: "move_same_type" },
    };
    const parent = makeIssue({ id: "DX-400", type: "Epic", children: ["DX-401", "DX-402"] });
    const w = mountDialog({ parent, descendants, defaults });
    await flushPromises();
    const selects = w.findAll('[data-test="cascade-action-select"]');
    // Operator switches the first row to Stay.
    await selects[0].setValue("stay");
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    const emitted = w.emitted("confirm");
    expect(emitted).toBeTruthy();
    const payload = emitted![0][0] as {
      overrides: Record<string, CascadeAction>;
      unblockConfirmed: boolean;
      blockedReason?: string;
    };
    expect(payload.overrides["DX-401"]).toEqual({ kind: "stay" });
    // DX-402 left at default — server re-computes spec default.
    expect(payload.overrides["DX-402"]).toBeUndefined();
  });

  it("operator picks 'move to <list>' → overrides carries move_to with listType+listName", async () => {
    const descendants = [makeIssue({ id: "DX-501", parent_id: "DX-500" })];
    const defaults: Record<string, CascadeAction> = {
      "DX-501": { kind: "move_same_type" },
    };
    const parent = makeIssue({ id: "DX-500", type: "Epic", children: ["DX-501"] });
    const w = mountDialog({ parent, descendants, defaults });
    await flushPromises();
    const sel = w.find('[data-test="cascade-action-select"]');
    await sel.setValue("move:L-done");
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    const payload = (w.emitted("confirm")![0][0] as {
      overrides: Record<string, CascadeAction>;
    });
    expect(payload.overrides["DX-501"]).toEqual({
      kind: "move_to",
      listType: "completed",
      listName: "Done",
    });
  });

  it("renders unblock-confirm banner + gates submit when any descendant blocked + dest non-blocked", async () => {
    const descendants = [
      makeIssue({
        id: "DX-601",
        parent_id: "DX-600",
        status: "Blocked",
        blocked: { at: "2026-05-18T00:00:00Z", reason: "spec" },
      }),
      makeIssue({ id: "DX-602", parent_id: "DX-600" }),
    ];
    const defaults: Record<string, CascadeAction> = {
      "DX-601": { kind: "move_same_type" },
      "DX-602": { kind: "move_same_type" },
    };
    const parent = makeIssue({ id: "DX-600", type: "Epic", children: ["DX-601", "DX-602"] });
    const destList = makeList({ id: "L-cancelled", name: "Cancelled", type: "cancelled" });
    const w = mountDialog({ parent, destList, descendants, defaults });
    await flushPromises();
    expect(w.find('[data-test="cascade-unblock-banner"]').exists()).toBe(true);
    // Confirm button initially disabled (toggle not flipped).
    const confirmBtn = w.find('[data-test="stub-dialog-confirm"]')
      .element as HTMLButtonElement;
    expect(confirmBtn.hasAttribute("disabled")).toBe(true);
    // Flip toggle on → confirm enabled.
    await w.find('[data-test="cascade-unblock-toggle"]').setValue(true);
    await flushPromises();
    expect(
      (w.find('[data-test="stub-dialog-confirm"]').element as HTMLButtonElement)
        .hasAttribute("disabled"),
    ).toBe(false);
    // Submit → payload's unblockConfirmed === true.
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    const payload = w.emitted("confirm")![0][0] as { unblockConfirmed: boolean };
    expect(payload.unblockConfirmed).toBe(true);
  });

  it("renders blocked-reason textarea when destList.type === blocked; gates submit on non-empty reason", async () => {
    const descendants = [makeIssue({ id: "DX-701", parent_id: "DX-700" })];
    const parent = makeIssue({ id: "DX-700", type: "Epic", children: ["DX-701"] });
    const destList = makeList({ id: "L-blocked", name: "Blocked", type: "blocked" });
    const defaults: Record<string, CascadeAction> = {
      "DX-701": { kind: "stay" },
    };
    const w = mountDialog({ parent, destList, descendants, defaults });
    await flushPromises();
    expect(w.find('[data-test="cascade-blocked-reason-banner"]').exists()).toBe(true);
    // Confirm gated on empty reason.
    expect(
      (w.find('[data-test="stub-dialog-confirm"]').element as HTMLButtonElement)
        .hasAttribute("disabled"),
    ).toBe(true);
    // Fill reason → enabled.
    await w.find('[data-test="cascade-blocked-reason"]').setValue("Operator request");
    await flushPromises();
    expect(
      (w.find('[data-test="stub-dialog-confirm"]').element as HTMLButtonElement)
        .hasAttribute("disabled"),
    ).toBe(false);
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    const payload = w.emitted("confirm")![0][0] as { blockedReason?: string };
    expect(payload.blockedReason).toBe("Operator request");
  });

  it("Cancel button emits @cancel and does NOT emit @confirm", async () => {
    const w = mountDialog();
    await flushPromises();
    await w.find('[data-test="stub-dialog-cancel"]').trigger("click");
    expect(w.emitted("cancel")).toBeTruthy();
    expect(w.emitted("confirm")).toBeFalsy();
  });

  it("Confirm with default selections emits payload with empty overrides + unblockConfirmed false", async () => {
    const w = mountDialog();
    await flushPromises();
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    const payload = w.emitted("confirm")![0][0] as {
      overrides: Record<string, CascadeAction>;
      unblockConfirmed: boolean;
      blockedReason?: string;
    };
    expect(payload.overrides).toEqual({});
    expect(payload.unblockConfirmed).toBe(false);
    expect(payload.blockedReason).toBeUndefined();
  });
});
