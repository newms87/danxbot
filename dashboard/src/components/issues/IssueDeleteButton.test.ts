import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import IssueDeleteButton from "./IssueDeleteButton.vue";

vi.mock("../../api", () => ({
  deleteIssue: vi.fn(),
}));

import { deleteIssue } from "../../api";
const deleteMock = vi.mocked(deleteIssue);

// DanxDialog renders body in a teleported overlay — stub it inline so
// the confirm/cancel buttons + body are reachable via wrapper.find().
const DanxDialogStub = defineComponent({
  name: "DanxDialog",
  props: ["modelValue", "title", "closeButton", "confirmButton", "isSaving", "disabled", "variant", "persistent"],
  emits: ["close", "confirm"],
  setup: (p, { slots, emit }) => () =>
    p.modelValue
      ? h("div", { class: "stub-dialog", "data-test": "stub-dialog" }, [
          h("div", { class: "stub-dialog-title" }, p.title),
          h("div", { class: "stub-dialog-body" }, slots.default?.()),
          h("button", {
            "data-test": "stub-dialog-cancel",
            onClick: () => emit("close"),
          }, p.closeButton),
          h("button", {
            "data-test": "stub-dialog-confirm",
            onClick: () => emit("confirm"),
          }, p.confirmButton),
        ])
      : null,
});

function mountBtn(props: { repo?: string; issueId?: string; childCount?: number } = {}) {
  return mount(IssueDeleteButton, {
    props: {
      repo: props.repo ?? "danxbot",
      issueId: props.issueId ?? "DX-1",
      childCount: props.childCount ?? 0,
    },
    global: { stubs: { DanxDialog: DanxDialogStub } },
  });
}

describe("IssueDeleteButton", () => {
  beforeEach(() => deleteMock.mockReset());

  it("renders the delete trigger button", () => {
    const w = mountBtn();
    expect(w.find('[data-test="drawer-delete"]').exists()).toBe(true);
  });

  it("opens the dialog on click and shows singular childless body text", async () => {
    const w = mountBtn();
    await w.find('[data-test="drawer-delete"]').trigger("click");
    expect(w.find('[data-test="drawer-delete-dialog-body"]').text()).toContain(
      "Move DX-1 to /tmp/danxbot/danxbot/issues/",
    );
  });

  it("body text adapts to child count (plural)", async () => {
    const w = mountBtn({ childCount: 3 });
    await w.find('[data-test="drawer-delete"]').trigger("click");
    expect(w.find('[data-test="drawer-delete-dialog-body"]').text()).toContain(
      "3 descendants",
    );
  });

  it("confirm invokes deleteIssue and emits deleted on success", async () => {
    deleteMock.mockResolvedValue(undefined as never);
    const w = mountBtn();
    await w.find('[data-test="drawer-delete"]').trigger("click");
    await w.find('[data-test="stub-dialog-confirm"]').trigger("click");
    await flushPromises();
    expect(deleteMock).toHaveBeenCalledWith("danxbot", "DX-1");
    expect(w.emitted("deleted")).toBeTruthy();
  });

});
