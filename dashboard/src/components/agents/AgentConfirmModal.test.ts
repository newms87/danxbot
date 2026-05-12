import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { h } from "vue";
import AgentConfirmModal from "./AgentConfirmModal.vue";

function mountWith(over: {
  variant: "danger" | "success";
  testPrefix: string;
  busy?: boolean;
  error?: string | null;
  bodyHtml?: string;
}) {
  return mount(AgentConfirmModal, {
    props: {
      busy: over.busy ?? false,
      error: over.error ?? null,
      title: "Test title",
      ariaLabel: "Test aria",
      confirmLabel: "Confirm",
      busyLabel: "Working…",
      testPrefix: over.testPrefix,
      variant: over.variant,
    },
    slots: over.bodyHtml ? { body: () => h("p", { class: "warn" }, over.bodyHtml) } : {},
  });
}

describe("AgentConfirmModal", () => {
  it("renders title, body slot, and derives data-test selectors from testPrefix", () => {
    const wrapper = mountWith({
      variant: "danger",
      testPrefix: "agent-delete",
      bodyHtml: "Body content here",
    });

    expect(wrapper.text()).toContain("Test title");
    expect(wrapper.text()).toContain("Body content here");
    expect(wrapper.find('[data-test="agent-delete-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="agent-delete-cancel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="agent-delete-confirm"]').exists()).toBe(true);
    expect(wrapper.attributes("aria-label")).toBe("Test aria");
  });

  it("applies btn-danger class when variant is danger", () => {
    const wrapper = mountWith({ variant: "danger", testPrefix: "agent-delete" });
    const btn = wrapper.find('[data-test="agent-delete-confirm"]');
    expect(btn.classes()).toContain("btn-danger");
    expect(btn.classes()).not.toContain("btn-success");
  });

  it("applies btn-success class when variant is success", () => {
    const wrapper = mountWith({ variant: "success", testPrefix: "agent-resolve" });
    const btn = wrapper.find('[data-test="agent-resolve-confirm"]');
    expect(btn.classes()).toContain("btn-success");
    expect(btn.classes()).not.toContain("btn-danger");
  });

  it("shows confirmLabel normally and busyLabel when busy=true; disables both buttons while busy", () => {
    const idle = mountWith({ variant: "danger", testPrefix: "agent-delete" });
    expect(idle.find('[data-test="agent-delete-confirm"]').text()).toBe("Confirm");
    expect(idle.find('[data-test="agent-delete-confirm"]').attributes("disabled")).toBeUndefined();

    const busy = mountWith({ variant: "danger", testPrefix: "agent-delete", busy: true });
    expect(busy.find('[data-test="agent-delete-confirm"]').text()).toBe("Working…");
    expect(busy.find('[data-test="agent-delete-confirm"]').attributes("disabled")).toBeDefined();
    expect(busy.find('[data-test="agent-delete-cancel"]').attributes("disabled")).toBeDefined();
  });

  it("renders the error block only when error is non-null", () => {
    const ok = mountWith({ variant: "danger", testPrefix: "agent-delete" });
    expect(ok.find('[data-test="agent-delete-error"]').exists()).toBe(false);

    const bad = mountWith({ variant: "danger", testPrefix: "agent-delete", error: "boom" });
    const errBlock = bad.find('[data-test="agent-delete-error"]');
    expect(errBlock.exists()).toBe(true);
    expect(errBlock.text()).toBe("boom");
  });

  it("emits confirm and cancel on the respective button clicks", async () => {
    const wrapper = mountWith({ variant: "success", testPrefix: "agent-resolve" });
    await wrapper.find('[data-test="agent-resolve-confirm"]').trigger("click");
    await wrapper.find('[data-test="agent-resolve-cancel"]').trigger("click");
    expect(wrapper.emitted("confirm")).toHaveLength(1);
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });
});
