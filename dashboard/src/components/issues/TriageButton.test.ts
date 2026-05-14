import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import TriageButton from "./TriageButton.vue";

function mountButton(opts: { repo?: string } = {}) {
  return mount(TriageButton, {
    props: {
      repo: opts.repo ?? "danxbot",
    },
    global: {
      // Stub the dialog out — TriageDialog is covered by its own test.
      stubs: { TriageDialog: true },
    },
  });
}

describe("TriageButton", () => {
  it("is enabled when a repo is selected", () => {
    const w = mountButton();
    const btn = w.get("[data-test='issues-triage-button']");
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it("is disabled when the repo prop is empty", () => {
    const w = mountButton({ repo: "" });
    const btn = w.get("[data-test='issues-triage-button']");
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
  });
});
