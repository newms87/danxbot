import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import PasteCardsDialog from "./PasteCardsDialog.vue";
import type { Issue, IssueCopyPayload } from "../../types";

vi.mock("../../api", () => ({
  importIssues: vi.fn(),
}));

import { importIssues } from "../../api";
const importMock = vi.mocked(importIssues);

// @thehammer/danx-ui's DanxDialog wraps the body inside a portal; the
// canonical test pattern (see CreateCardDialog.test.ts) stubs it as a
// transparent container so the form / textarea / error markers remain
// queryable from the wrapper without dragging in the portal machinery.
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
            "Import",
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

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 9,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Imported",
    description: "",
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
    effort_level: null,
    assigned_agent: null,
    ...overrides,
    db_updated_at: "",
  };
}

function mountDialog(open = true) {
  return mount(PasteCardsDialog, {
    props: {
      modelValue: open,
      repo: "danxbot",
    },
    global: {
      stubs: {
        DanxDialog: DanxDialogStub,
      },
    },
  });
}

// happy-dom doesn't ship a clipboard by default. Install a configurable
// stub the tests can override per-case. The auto-read-on-open path is
// best-effort and silently ignores failures, so the default (rejecting
// stub) exercises the manual-paste happy path without noise.
function installClipboardStub(readImpl?: () => Promise<string>): {
  readText: ReturnType<typeof vi.fn>;
} {
  const readText = vi.fn(readImpl ?? (() => Promise.reject(new Error("denied"))));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText },
  });
  return { readText };
}

describe("PasteCardsDialog (DX-519)", () => {
  beforeEach(() => {
    importMock.mockReset();
  });

  it("submits the parsed payload, fires `imported` with the new top id, and closes", async () => {
    installClipboardStub();
    importMock.mockResolvedValue({
      topId: "DX-7",
      issues: [makeIssue({ id: "DX-7" }), makeIssue({ id: "DX-8" })],
    });

    const w = mountDialog();
    await flushPromises();

    const payload: IssueCopyPayload = {
      schema_version: 9,
      issues: [makeIssue({ id: "DX-100" }), makeIssue({ id: "DX-101" })],
    };
    await w
      .get('[data-test="paste-cards-textarea"]')
      .setValue(JSON.stringify(payload));
    await w.get('[data-test="stub-confirm"]').trigger("click");

    await vi.waitFor(() => {
      expect(importMock).toHaveBeenCalledTimes(1);
    });
    expect(importMock).toHaveBeenCalledWith(
      "danxbot",
      expect.objectContaining({ schema_version: 9 }),
    );

    await vi.waitFor(() => {
      const ev = w.emitted("imported");
      expect(ev).toBeTruthy();
      expect(ev![0][0]).toBe("DX-7");
      expect(ev![0][1]).toBe(2);
    });
    await vi.waitFor(() => {
      const close = w.emitted("update:modelValue");
      expect(close).toBeTruthy();
      expect(close!.at(-1)![0]).toBe(false);
    });
  });

  it("surfaces a JSON parse error inline without calling importIssues", async () => {
    installClipboardStub();
    const w = mountDialog();
    await flushPromises();

    await w
      .get('[data-test="paste-cards-textarea"]')
      .setValue("not json {");
    await w.get('[data-test="stub-confirm"]').trigger("click");

    await vi.waitFor(() => {
      expect(w.get('[data-test="paste-cards-error"]').text()).toContain(
        "not valid JSON",
      );
    });
    await flushPromises();
    expect(importMock).not.toHaveBeenCalled();
  });

  it("surfaces the server error message inline when importIssues rejects", async () => {
    installClipboardStub();
    importMock.mockRejectedValue(
      new Error("issues must be a non-empty array"),
    );

    const w = mountDialog();
    await flushPromises();

    await w
      .get('[data-test="paste-cards-textarea"]')
      .setValue('{"schema_version":8,"issues":[]}');
    await w.get('[data-test="stub-confirm"]').trigger("click");

    await vi.waitFor(() => {
      expect(w.get('[data-test="paste-cards-error"]').text()).toContain(
        "issues must be a non-empty array",
      );
    });
    expect(w.emitted("imported")).toBeFalsy();
  });

  it("auto-fills the textarea from the clipboard when the read returns a shaped payload", async () => {
    const text = JSON.stringify({
      schema_version: 9,
      issues: [makeIssue()],
    });
    installClipboardStub(() => Promise.resolve(text));

    const w = mountDialog();
    await flushPromises();

    const ta = w.get(
      '[data-test="paste-cards-textarea"]',
    ).element as HTMLTextAreaElement;
    await vi.waitFor(() => {
      expect(ta.value).toBe(text);
    });
  });

  it("ignores clipboard content that does not look like an IssueCopyPayload", async () => {
    installClipboardStub(() => Promise.resolve("https://example.com/some-url"));

    const w = mountDialog();
    await flushPromises();

    const ta = w.get(
      '[data-test="paste-cards-textarea"]',
    ).element as HTMLTextAreaElement;
    expect(ta.value).toBe("");
  });
});
