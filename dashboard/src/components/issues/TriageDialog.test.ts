import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import TriageDialog from "./TriageDialog.vue";
import type { ToggleError } from "../../api";

vi.mock("../../api", () => ({
  triggerTriage: vi.fn(),
}));

import { triggerTriage } from "../../api";
const triageMock = vi.mocked(triggerTriage);

// `@thehammer/danx-ui`'s DanxDialog uses a portal; PasteCardsDialog's
// test stubs it as a transparent container so the form remains queryable.
// Mirroring that pattern keeps the auth/portal machinery out of the
// component-test loop.
const DanxDialogStub = defineComponent({
  name: "DanxDialog",
  inheritAttrs: false,
  props: {
    modelValue: Boolean,
    title: String,
    subtitle: String,
    persistent: Boolean,
    isSaving: Boolean,
    disabled: Boolean,
    closeButton: String,
    confirmButton: String,
    width: String,
  },
  emits: ["update:modelValue", "close", "confirm"],
  setup(_, { slots, emit }) {
    return () =>
      h(
        "div",
        {
          class: "stub-danx-dialog",
          "data-test": "stub-danx-dialog",
        },
        [
          h("div", { class: "stub-body" }, slots.default?.()),
          h(
            "button",
            {
              type: "button",
              "data-test": "stub-confirm",
              onClick: () => emit("confirm"),
            },
            "Triage",
          ),
          h(
            "button",
            {
              type: "button",
              "data-test": "stub-close",
              onClick: () => emit("close"),
            },
            "Cancel",
          ),
        ],
      );
  },
});

function mountDialog(opts: { open?: boolean } = {}) {
  return mount(TriageDialog, {
    props: {
      modelValue: opts.open ?? true,
      repo: "danxbot",
    },
    global: {
      stubs: { DanxDialog: DanxDialogStub },
    },
  });
}

describe("TriageDialog", () => {
  beforeEach(() => {
    triageMock.mockReset();
  });

  it("submits with instructions, fires `dispatched`, and closes (happy path)", async () => {
    triageMock.mockResolvedValue({ jobId: "job-abc" });

    const w = mountDialog();
    await flushPromises();

    await w.get('[data-test="triage-instructions"]').setValue(
      "re-score considering DX-269 retirement",
    );
    await w.get('[data-test="stub-confirm"]').trigger("click");

    await vi.waitFor(() => {
      expect(triageMock).toHaveBeenCalledTimes(1);
    });
    expect(triageMock).toHaveBeenCalledWith(
      "danxbot",
      "re-score considering DX-269 retirement",
    );

    await vi.waitFor(() => {
      const ev = w.emitted("dispatched");
      expect(ev).toBeTruthy();
    });
    await vi.waitFor(() => {
      const close = w.emitted("update:modelValue");
      expect(close).toBeTruthy();
      expect(close!.at(-1)![0]).toBe(false);
    });
  });

  it("submits with empty instructions (default orchestrator pass) and still calls triggerTriage", async () => {
    triageMock.mockResolvedValue({ jobId: "job-empty" });

    const w = mountDialog();
    await flushPromises();

    await w.get('[data-test="stub-confirm"]').trigger("click");

    await vi.waitFor(() => {
      expect(triageMock).toHaveBeenCalledTimes(1);
    });
    // Empty instructions surface as `null` to the wrapper so the worker
    // body validation routes through the no-instructions branch (omit
    // the field entirely) rather than the "non-empty string" branch.
    expect(triageMock).toHaveBeenCalledWith("danxbot", null);
  });

  it("blocks submit and shows inline error when instructions exceed 2000 chars", async () => {
    const w = mountDialog();
    await flushPromises();

    const oversized = "x".repeat(2001);
    await w.get('[data-test="triage-instructions"]').setValue(oversized);

    await w.get('[data-test="stub-confirm"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="triage-error"]').text()).toContain("2000");
    expect(triageMock).not.toHaveBeenCalled();
  });

  it("surfaces the server's 4xx error body inline on rejection", async () => {
    const err = new Error("instructions exceeds 2000-character limit (got 2050)") as ToggleError;
    err.status = 400;
    err.serverMessage = "instructions exceeds 2000-character limit (got 2050)";
    triageMock.mockRejectedValue(err);

    const w = mountDialog();
    await flushPromises();

    await w.get('[data-test="triage-instructions"]').setValue("anything");
    await w.get('[data-test="stub-confirm"]').trigger("click");

    await vi.waitFor(() => {
      expect(w.get('[data-test="triage-error"]').text()).toContain(
        "instructions exceeds 2000-character limit",
      );
    });
    expect(w.emitted("dispatched")).toBeFalsy();
  });

  it("shows a generic retry message when the server returns 5xx", async () => {
    const err = new Error("Triage failed: upstream 503") as ToggleError;
    err.status = 503;
    err.serverMessage = "Dispatch API is disabled for repo danxbot";
    triageMock.mockRejectedValue(err);

    const w = mountDialog();
    await flushPromises();

    await w.get('[data-test="triage-instructions"]').setValue("re-triage");
    await w.get('[data-test="stub-confirm"]').trigger("click");

    await vi.waitFor(() => {
      expect(w.get('[data-test="triage-error"]').text().toLowerCase()).toContain(
        "retry",
      );
    });
    expect(w.emitted("dispatched")).toBeFalsy();
  });
});
