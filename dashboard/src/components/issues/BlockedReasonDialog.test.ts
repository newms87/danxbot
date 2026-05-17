import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import BlockedReasonDialog from "./BlockedReasonDialog.vue";

// DanxDialog stub — render slot inline so the test can locate the body
// textarea + click the dialog's confirm/close buttons via the existing
// emit hooks. Mirrors the pattern used in other drawer tests.
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
  setup(_p, { slots, emit }) {
    return () =>
      h("div", { class: "stub-danx-dialog" }, [
        h("div", { class: "stub-dialog-body" }, slots.default?.()),
        h(
          "button",
          {
            class: "stub-dialog-confirm",
            "data-test": "stub-dialog-confirm",
            onClick: () => emit("confirm"),
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

function mountDialog(props: Partial<{ busy: boolean; error: string | null }> = {}) {
  return mount(BlockedReasonDialog, {
    props: {
      modelValue: true,
      issueId: "DX-1",
      destListName: "Blocked",
      busy: props.busy ?? false,
      error: props.error ?? null,
    },
    global: { stubs: { DanxDialog: DanxDialogStub } },
  });
}

describe("BlockedReasonDialog", () => {
  it("renders the reason textarea + a confirm action", async () => {
    const w = mountDialog();
    await flushPromises();
    expect(w.find('[data-test="blocked-dialog-reason"]').exists()).toBe(true);
    expect(w.find('[data-test="stub-dialog-confirm"]').exists()).toBe(true);
  });

  it("emits submit(reason) when the operator types + confirms", async () => {
    const w = mountDialog();
    await flushPromises();
    const ta = w.find('[data-test="blocked-dialog-reason"]');
    await ta.setValue("Spec needs clarification");
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    expect(w.emitted("submit")?.[0]).toEqual(["Spec needs clarification"]);
  });

  it("trims whitespace from the reason before emitting", async () => {
    const w = mountDialog();
    await flushPromises();
    await w
      .find('[data-test="blocked-dialog-reason"]')
      .setValue("   hello   ");
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    expect(w.emitted("submit")?.[0]).toEqual(["hello"]);
  });

  it("does NOT emit submit when the reason is empty / whitespace only", async () => {
    const w = mountDialog();
    await flushPromises();
    await w.find('[data-test="blocked-dialog-reason"]').setValue("    ");
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    expect(w.emitted("submit")).toBeUndefined();
  });

  it("emits cancel + update:modelValue(false) on the dialog close button", async () => {
    const w = mountDialog();
    await flushPromises();
    await w.find('[data-test="stub-dialog-cancel"]').trigger("click");
    expect(w.emitted("cancel")).toBeTruthy();
    expect(w.emitted("update:modelValue")?.[0]).toEqual([false]);
  });

  it("surfaces the parent's server error inline", async () => {
    const w = mountDialog({ error: "400 list_name unknown" });
    await flushPromises();
    expect(w.find('[data-test="blocked-dialog-error"]').text()).toContain(
      "400 list_name unknown",
    );
  });

  it("does NOT emit submit when busy=true (parent's in-flight PATCH guard)", async () => {
    const w = mountDialog({ busy: true });
    await flushPromises();
    await w.find('[data-test="blocked-dialog-reason"]').setValue("hello");
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    expect(w.emitted("submit")).toBeUndefined();
  });
});
