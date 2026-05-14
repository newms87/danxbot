import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import TriageDialog from "./TriageDialog.vue";
import type { IssueListItem } from "../../types";
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

function makeListItem(overrides: Partial<IssueListItem> = {}): IssueListItem {
  return {
    id: "DX-1",
    type: "Feature",
    title: "Triage me",
    description: "",
    status: "Review",
    parent_id: null,
    children: [],
    ac_total: 0,
    ac_done: 0,
    children_detail: [],
    waiting_on: false,
    waiting_on_reason: null,
    waiting_on_by: [],
    comments_count: 0,
    has_retro: false,
    updated_at: 0,
    created_at: 0,
    priority: 3,
    position: null,
    assigned_agent: null,
    ...overrides,
  } as IssueListItem;
}

const REVIEW_CARD = makeListItem({ id: "DX-1", title: "Review-state card", status: "Review" });
const BLOCKED_CARD = makeListItem({
  id: "DX-2",
  title: "Blocked card",
  status: "Blocked",
});
const WAITING_CARD = makeListItem({
  id: "DX-3",
  title: "Waiting on sibling",
  status: "ToDo",
  waiting_on: true,
  waiting_on_reason: "Phase 1 must ship",
  waiting_on_by: ["DX-99"],
});
const TODO_CARD_INELIGIBLE = makeListItem({
  id: "DX-4",
  title: "Plain ToDo (not triage-eligible)",
  status: "ToDo",
});

function mountDialog(opts: {
  open?: boolean;
  candidates?: IssueListItem[];
  initialIssueId?: string | null;
} = {}) {
  return mount(TriageDialog, {
    props: {
      modelValue: opts.open ?? true,
      repo: "danxbot",
      candidates: opts.candidates ?? [REVIEW_CARD, BLOCKED_CARD, WAITING_CARD, TODO_CARD_INELIGIBLE],
      initialIssueId: opts.initialIssueId ?? null,
    },
    global: {
      stubs: { DanxDialog: DanxDialogStub },
    },
  });
}

describe("TriageDialog (DX-518)", () => {
  beforeEach(() => {
    triageMock.mockReset();
  });

  it("submits with instructions, fires `dispatched` with the issue id, and closes (happy path)", async () => {
    triageMock.mockResolvedValue({ jobId: "job-abc" });

    const w = mountDialog({ initialIssueId: "DX-2" });
    await flushPromises();

    // Default candidate selector picks the initial issue id
    const select = w.get('[data-test="triage-issue-select"]')
      .element as HTMLSelectElement;
    expect(select.value).toBe("DX-2");

    await w.get('[data-test="triage-instructions"]').setValue(
      "re-score considering DX-269 retirement",
    );
    await w.get('[data-test="stub-confirm"]').trigger("click");

    await vi.waitFor(() => {
      expect(triageMock).toHaveBeenCalledTimes(1);
    });
    expect(triageMock).toHaveBeenCalledWith(
      "danxbot",
      "DX-2",
      "re-score considering DX-269 retirement",
    );

    await vi.waitFor(() => {
      const ev = w.emitted("dispatched");
      expect(ev).toBeTruthy();
      expect(ev![0][0]).toBe("DX-2");
    });
    await vi.waitFor(() => {
      const close = w.emitted("update:modelValue");
      expect(close).toBeTruthy();
      expect(close!.at(-1)![0]).toBe(false);
    });
  });

  it("submits with empty instructions (default triage pass) and still calls triggerTriage", async () => {
    triageMock.mockResolvedValue({ jobId: "job-empty" });

    const w = mountDialog({ initialIssueId: "DX-1" });
    await flushPromises();

    // Submit without typing anything in the textarea — empty instructions are valid.
    await w.get('[data-test="stub-confirm"]').trigger("click");

    await vi.waitFor(() => {
      expect(triageMock).toHaveBeenCalledTimes(1);
    });
    // Empty instructions surface as `null` to the wrapper so the worker
    // body validation routes through the no-instructions branch (omit
    // the field entirely) rather than the "non-empty string" branch.
    expect(triageMock).toHaveBeenCalledWith("danxbot", "DX-1", null);
  });

  it("blocks submit and shows inline error when instructions exceed 2000 chars", async () => {
    const w = mountDialog({ initialIssueId: "DX-1" });
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

    const w = mountDialog({ initialIssueId: "DX-1" });
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

    const w = mountDialog({ initialIssueId: "DX-1" });
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

  it("falls back to the first eligible candidate when initialIssueId is not triage-eligible", async () => {
    triageMock.mockResolvedValue({ jobId: "job-fallback" });

    // initialIssueId points at the ToDo card (not in the triage scope).
    // The selector must fall back to the first eligible candidate
    // rather than land on an unsubmittable empty state.
    const w = mountDialog({ initialIssueId: "DX-4" });
    await flushPromises();

    const select = w.get('[data-test="triage-issue-select"]')
      .element as HTMLSelectElement;
    expect(select.value).toBe("DX-1"); // first eligible

    await w.get('[data-test="stub-confirm"]').trigger("click");
    await vi.waitFor(() => {
      expect(triageMock).toHaveBeenCalledWith("danxbot", "DX-1", null);
    });
  });

  it("only lists triage-eligible candidates (Review / Blocked / waiting_on != null) in the selector", async () => {
    const w = mountDialog();
    await flushPromises();

    const optionIds = w
      .findAll('[data-test="triage-issue-select"] option')
      .map((o) => (o.element as HTMLOptionElement).value);

    // Plain ToDo card (DX-4) is not triage-eligible — must be filtered out.
    expect(optionIds).toContain("DX-1");
    expect(optionIds).toContain("DX-2");
    expect(optionIds).toContain("DX-3");
    expect(optionIds).not.toContain("DX-4");
  });
});
