import { describe, it, expect } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import UnblockConfirmDialog from "./UnblockConfirmDialog.vue";

const DanxDialogStub = defineComponent({
  name: "DanxDialog",
  props: {
    modelValue: Boolean,
    title: String,
    closeButton: [String, Boolean],
    confirmButton: [String, Boolean],
    isSaving: Boolean,
    persistent: Boolean,
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

function mountDialog(props: Partial<{
  busy: boolean;
  error: string | null;
  currentReason: string | null;
}> = {}) {
  return mount(UnblockConfirmDialog, {
    props: {
      modelValue: true,
      issueId: "DX-1",
      destListName: "To Do",
      // Distinguish undefined (default) from null (explicit no-reason).
      currentReason:
        "currentReason" in props ? props.currentReason ?? null : "Spec ambiguous",
      busy: props.busy ?? false,
      error: props.error ?? null,
    },
    global: { stubs: { DanxDialog: DanxDialogStub } },
  });
}

describe("UnblockConfirmDialog", () => {
  it("renders the current blocked reason for review", async () => {
    const w = mountDialog({ currentReason: "Waiting on design" });
    await flushPromises();
    expect(
      w.find('[data-test="unblock-dialog-reason"]').text(),
    ).toContain("Waiting on design");
  });

  it("omits the reason preview when currentReason is null", async () => {
    const w = mountDialog({ currentReason: null });
    await flushPromises();
    expect(w.find('[data-test="unblock-dialog-reason"]').exists()).toBe(false);
  });

  it("emits confirm on the dialog's confirm button", async () => {
    const w = mountDialog();
    await flushPromises();
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    expect(w.emitted("confirm")).toBeTruthy();
  });

  it("does NOT emit confirm when busy=true (parent guard)", async () => {
    const w = mountDialog({ busy: true });
    await flushPromises();
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    expect(w.emitted("confirm")).toBeUndefined();
  });

  it("emits cancel + update:modelValue(false) on the dialog cancel button", async () => {
    const w = mountDialog();
    await flushPromises();
    await w.find('[data-test="stub-dialog-cancel"]').trigger("click");
    expect(w.emitted("cancel")).toBeTruthy();
    expect(w.emitted("update:modelValue")?.[0]).toEqual([false]);
  });

  it("surfaces the parent's server error inline", async () => {
    const w = mountDialog({ error: "400 invalid" });
    await flushPromises();
    expect(w.find('[data-test="unblock-dialog-error"]').text()).toContain(
      "400 invalid",
    );
  });
});
