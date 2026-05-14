import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CreateCardDialog from "./CreateCardDialog.vue";
import type { Issue } from "../../types";

vi.mock("../../api", () => ({
  createIssue: vi.fn(),
  fleshOutIssue: vi.fn(),
}));

import { createIssue, fleshOutIssue } from "../../api";
const createMock = vi.mocked(createIssue);
const fleshMock = vi.mocked(fleshOutIssue);

/**
 * DanxDialog stub renders the dialog inline as a teleport-less wrapper
 * so `@vue/test-utils` can reach the inner form. We expose the v-model
 * via attrs and re-emit `confirm` / `close` directly so the dialog's
 * built-in buttons can drive the component without rendering the real
 * (CSS-token-dependent) DanxDialog markup.
 */
const DanxDialogStub = {
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
};

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 7,
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
    ...overrides,
  };
}

function mountDialog(open = true) {
  return mount(CreateCardDialog, {
    props: { modelValue: open, repo: "danxbot" },
    global: { stubs: { DanxDialog: DanxDialogStub } },
  });
}

describe("CreateCardDialog", () => {
  beforeEach(() => {
    createMock.mockReset();
    fleshMock.mockReset();
  });

  it("renders title, description, status, type fields when open", () => {
    const w = mountDialog(true);
    expect(w.find("[data-test='create-card-title']").exists()).toBe(true);
    expect(w.find("[data-test='create-card-description']").exists()).toBe(true);
    expect(w.find("[data-test='create-card-status']").exists()).toBe(true);
    expect(w.find("[data-test='create-card-type']").exists()).toBe(true);
  });

  it("does not render when closed", () => {
    const w = mountDialog(false);
    expect(w.find("[data-test='create-card-form']").exists()).toBe(false);
  });

  it("defaults status=Review and type=Feature", () => {
    const w = mountDialog(true);
    const reviewRadio = w.get<HTMLInputElement>("[data-test='status-Review']");
    const featureRadio = w.get<HTMLInputElement>("[data-test='type-Feature']");
    expect(reviewRadio.element.checked).toBe(true);
    expect(featureRadio.element.checked).toBe(true);
  });

  it("disables confirm when title is empty", async () => {
    const w = mountDialog(true);
    // description filled, title blank
    await w.find("[data-test='create-card-description']").setValue("Body");
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
    await w.find("[data-test='create-card-description']").setValue("Body");
    const confirm = w.get<HTMLButtonElement>("[data-test='dialog-confirm']");
    expect(confirm.element.disabled).toBe(false);
  });

  it("submits with form values + fires flesh-out + closes on success", async () => {
    createMock.mockResolvedValueOnce(makeIssue({ id: "DX-5", title: "Foo" }));
    fleshMock.mockResolvedValueOnce({ jobId: "j-1" });
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("Foo");
    await w.find("[data-test='create-card-description']").setValue("Bar");
    await w.find("[data-test='status-ToDo']").setValue();
    await w.find("[data-test='type-Bug']").setValue();
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith("danxbot", {
      title: "Foo",
      description: "Bar",
      status: "ToDo",
      type: "Bug",
    });
    expect(fleshMock).toHaveBeenCalledWith("danxbot", "DX-5");
    expect(w.emitted("created")).toEqual([["DX-5"]]);
    // Dialog closes via update:modelValue false on success
    const modelEvents = w.emitted("update:modelValue") ?? [];
    expect(modelEvents.at(-1)).toEqual([false]);
  });

  it("trims whitespace from title and description before submitting", async () => {
    createMock.mockResolvedValueOnce(makeIssue());
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("  Padded  ");
    await w
      .find("[data-test='create-card-description']")
      .setValue("  Body  ");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();
    expect(createMock).toHaveBeenCalledWith("danxbot", {
      title: "Padded",
      description: "Body",
      status: "Review",
      type: "Feature",
    });
  });

  it("surfaces a 400 error message inline and keeps the dialog open", async () => {
    createMock.mockRejectedValueOnce(new Error("title must be a non-empty string"));
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("x");
    await w.find("[data-test='create-card-description']").setValue("y");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();
    const err = w.find("[data-test='create-card-error']");
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain("title must be a non-empty string");
    // No `update:modelValue: false` after the failure — dialog stays open.
    const last = (w.emitted("update:modelValue") ?? []).at(-1);
    expect(last).toBeUndefined();
    // `created` never fired because the POST failed.
    expect(w.emitted("created")).toBeUndefined();
  });

  it("does not fail the create when flesh-out rejects (fire-and-forget)", async () => {
    createMock.mockResolvedValueOnce(makeIssue({ id: "DX-7" }));
    fleshMock.mockRejectedValueOnce(new Error("worker timeout"));
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("Foo");
    await w.find("[data-test='create-card-description']").setValue("Bar");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();
    // Even though flesh-out rejected, the create succeeded — `created` fires
    // and the dialog closes. The promise rejection is swallowed.
    expect(w.emitted("created")).toEqual([["DX-7"]]);
    expect(w.find("[data-test='create-card-error']").exists()).toBe(false);
  });

  it("resets form state when reopened after a previous error", async () => {
    createMock.mockRejectedValueOnce(new Error("boom"));
    const w = mountDialog(true);
    await w.find("[data-test='create-card-title']").setValue("Old");
    await w.find("[data-test='create-card-description']").setValue("Stale");
    await w.get("[data-test='dialog-confirm']").trigger("click");
    await flushPromises();
    expect(w.find("[data-test='create-card-error']").exists()).toBe(true);

    // Close + reopen via prop flip.
    await w.setProps({ modelValue: false });
    await w.setProps({ modelValue: true });

    expect(w.find("[data-test='create-card-error']").exists()).toBe(false);
    const titleInput = w.get<HTMLInputElement>("[data-test='create-card-title']");
    const descTextarea = w.get<HTMLTextAreaElement>(
      "[data-test='create-card-description']",
    );
    expect(titleInput.element.value).toBe("");
    expect(descTextarea.element.value).toBe("");
  });
});
