import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import type { List, ListsFile } from "../../types";

// ── Mocks ────────────────────────────────────────────────────────────

const mockPatchList = vi.fn();
const mockCreateList = vi.fn();
const mockDeleteList = vi.fn();

vi.mock("../../api", () => ({
  patchList: (...args: unknown[]) => mockPatchList(...args),
  createList: (...args: unknown[]) => mockCreateList(...args),
  deleteList: (...args: unknown[]) => mockDeleteList(...args),
}));

const FIXTURE: List[] = [
  { id: "u-arch", name: "Backlog", type: "archived", order: 0, is_default_for_type: true, color: "#64748b" },
  { id: "u-review", name: "Review", type: "review", order: 0, is_default_for_type: true, color: "#3b82f6" },
  { id: "u-ready", name: "To Do", type: "ready", order: 0, is_default_for_type: true, color: "#22d3ee" },
  { id: "u-ip", name: "In Progress", type: "in_progress", order: 0, is_default_for_type: true, color: "#f59e0b" },
  { id: "u-done", name: "Done", type: "completed", order: 0, is_default_for_type: true, color: "#22c55e" },
  { id: "u-cancel", name: "Cancelled", type: "cancelled", order: 0, is_default_for_type: true, color: "#71717a" },
];

const listsRef = ref<List[]>([...FIXTURE]);
const loadingRef = ref<boolean>(false);
const errorRef = ref<string | null>(null);

vi.mock("../../composables/useListColors", () => ({
  NEUTRAL_LIST_COLOR: "#94a3b8",
  useListColors: () => ({
    lists: listsRef,
    loading: loadingRef,
    error: errorRef,
    colorFor: (n: string) => listsRef.value.find((l) => l.name === n)?.color ?? "#94a3b8",
    refresh: vi.fn(),
    init: vi.fn(),
    destroy: vi.fn(),
  }),
}));

import ListsManager from "./ListsManager.vue";

function mountManager(): ReturnType<typeof mount> {
  return mount(ListsManager, {
    attachTo: document.body,
    props: { repo: "danxbot" },
  });
}

beforeEach(() => {
  listsRef.value = [...FIXTURE];
  loadingRef.value = false;
  errorRef.value = null;
  mockPatchList.mockReset();
  mockCreateList.mockReset();
  mockDeleteList.mockReset();
});

describe("ListsManager", () => {
  it("renders all 6 semantic-type sections with the seeded lists grouped", () => {
    const w = mountManager();
    for (const t of [
      "archived",
      "review",
      "ready",
      "in_progress",
      "completed",
      "cancelled",
    ] as const) {
      expect(w.find(`[data-test="lists-section-${t}"]`).exists()).toBe(true);
    }
    expect(w.find(`[data-test="lists-row-u-review"]`).exists()).toBe(true);
    expect(w.find(`[data-test="lists-row-u-done"]`).exists()).toBe(true);
    w.unmount();
  });

  it("rename input change triggers patchList with the new name", async () => {
    mockPatchList.mockResolvedValueOnce({});
    const w = mountManager();
    const input = w.get(`[data-test="lists-name-u-review"]`);
    await input.setValue("Triage");
    await input.trigger("change");
    await vi.waitFor(() => {
      expect(mockPatchList).toHaveBeenCalledWith("danxbot", "u-review", { name: "Triage" });
    });
    w.unmount();
  });

  it("delete button is DISABLED for the last list of a type (only seeded list)", () => {
    const w = mountManager();
    const btn = w.get(`[data-test="lists-delete-u-review"]`).element as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    w.unmount();
  });

  it("delete button is ENABLED when ≥2 lists share the type, and calls deleteList", async () => {
    listsRef.value = [
      ...FIXTURE,
      { id: "u-review-2", name: "Triage", type: "review", order: 1, is_default_for_type: false, color: "#3b82f6" },
    ];
    mockDeleteList.mockResolvedValueOnce({});
    const w = mountManager();
    const reviewBtn = w.get(`[data-test="lists-delete-u-review-2"]`).element as HTMLButtonElement;
    expect(reviewBtn.disabled).toBe(false);
    await w.get(`[data-test="lists-delete-u-review-2"]`).trigger("click");
    // Mock-call propagation race under full-suite CPU contention — mirrors
    // the DX-299 pattern used elsewhere (RequiresHumanPanel, SettingsPage).
    await vi.waitFor(() => {
      expect(mockDeleteList).toHaveBeenCalledWith("danxbot", "u-review-2");
    });
    w.unmount();
  });

  it("color input change triggers patchList with the new color", async () => {
    // DanxColorPicker commits on blur when the hex draft is valid + changed.
    mockPatchList.mockResolvedValueOnce({});
    const w = mountManager();
    const colorInput = w.get(`[data-test="lists-color-u-review-input"]`);
    await colorInput.setValue("#abcdef");
    await colorInput.trigger("blur");
    await vi.waitFor(() => {
      expect(mockPatchList).toHaveBeenCalledWith("danxbot", "u-review", { color: "#abcdef" });
    });
    w.unmount();
  });

  it("promote-default button is DISABLED on the existing default, ENABLED otherwise", () => {
    listsRef.value = [
      ...FIXTURE,
      { id: "u-review-2", name: "Triage", type: "review", order: 1, is_default_for_type: false, color: "#3b82f6" },
    ];
    const w = mountManager();
    const defaultBtn = w.get(`[data-test="lists-default-u-review"]`).element as HTMLButtonElement;
    const promoteBtn = w.get(`[data-test="lists-default-u-review-2"]`).element as HTMLButtonElement;
    expect(defaultBtn.disabled).toBe(true);
    expect(promoteBtn.disabled).toBe(false);
    w.unmount();
  });

  it("clicking promote-default calls patchList with is_default_for_type:true", async () => {
    listsRef.value = [
      ...FIXTURE,
      { id: "u-review-2", name: "Triage", type: "review", order: 1, is_default_for_type: false, color: "#3b82f6" },
    ];
    mockPatchList.mockResolvedValueOnce({});
    const w = mountManager();
    await w.get(`[data-test="lists-default-u-review-2"]`).trigger("click");
    await vi.waitFor(() => {
      expect(mockPatchList).toHaveBeenCalledWith("danxbot", "u-review-2", { is_default_for_type: true });
    });
    w.unmount();
  });

  it("+ Add list opens the dialog; submit calls createList with type + name + color", async () => {
    mockCreateList.mockResolvedValueOnce({ list: {}, file: {} as ListsFile });
    const w = mountManager();
    await w.get(`[data-test="lists-add-review"]`).trigger("click");

    // Dialog renders in a portal — query document, mirroring SettingsPage.test pattern
    const nameInput = await vi.waitFor(() => {
      const el = document.querySelector('[data-test="lists-add-name"]') as HTMLInputElement | null;
      if (!el) throw new Error("Dialog not yet mounted");
      return el;
    });
    nameInput.value = "Triage";
    nameInput.dispatchEvent(new Event("input"));

    const confirmBtn = await vi.waitFor(() => {
      const btn = Array.from(
        document.querySelectorAll<HTMLButtonElement>("dialog button"),
      ).find((b) => b.textContent?.includes("Add list"));
      if (!btn) throw new Error("Confirm button not yet rendered");
      return btn;
    });
    confirmBtn.click();
    await flushPromises();

    expect(mockCreateList).toHaveBeenCalled();
    const [repo, input] = mockCreateList.mock.calls[0];
    expect(repo).toBe("danxbot");
    expect(input).toMatchObject({ type: "review", name: "Triage" });
    expect(typeof input.color).toBe("string");
    w.unmount();
  });

  it("up/down arrows are disabled at the boundaries of a type", () => {
    listsRef.value = [
      ...FIXTURE,
      { id: "u-review-2", name: "Triage", type: "review", order: 1, is_default_for_type: false, color: "#3b82f6" },
    ];
    const w = mountManager();
    // First-of-type cannot go up
    expect((w.get(`[data-test="lists-up-u-review"]`).element as HTMLButtonElement).disabled).toBe(true);
    // Second-of-type CAN go up
    expect((w.get(`[data-test="lists-up-u-review-2"]`).element as HTMLButtonElement).disabled).toBe(false);
    // Last-of-type cannot go down
    expect((w.get(`[data-test="lists-down-u-review-2"]`).element as HTMLButtonElement).disabled).toBe(true);
    w.unmount();
  });
});
