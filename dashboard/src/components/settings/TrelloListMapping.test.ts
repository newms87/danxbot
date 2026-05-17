import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ref } from "vue";
import type { Ref } from "vue";
import type {
  TrelloListMap,
  TrelloListSummary,
} from "../../types";
import type { TrelloListMappingResponse } from "../../api";

const COMPONENT_SOURCE_PATH = resolve(__dirname, "TrelloListMapping.vue");

// ── Mocks ────────────────────────────────────────────────────────────

const mockInit = vi.fn();
const mockDestroy = vi.fn();
const mockRefresh = vi.fn();
const mockRefetchBoardLists = vi.fn();
const mockSave = vi.fn();

// useListColors is consumed for color swatches (per AC). Minimal stub —
// any name resolves to a deterministic color.
vi.mock("../../composables/useListColors", () => ({
  NEUTRAL_LIST_COLOR: "#94a3b8",
  useListColors: () => ({
    lists: ref([
      { id: "l-review", name: "Review", color: "#3b82f6" },
      { id: "l-todo", name: "ToDo", color: "#22d3ee" },
      { id: "l-blocked", name: "Blocked", color: "#ef4444" },
    ]),
    loading: ref(false),
    error: ref(null),
    colorFor: (id: string) =>
      ({
        "l-review": "#3b82f6",
        "l-todo": "#22d3ee",
        "l-blocked": "#ef4444",
      })[id] ?? "#94a3b8",
    refresh: vi.fn(),
    init: vi.fn(),
    destroy: vi.fn(),
  }),
}));

interface ComposableState {
  mapping: Ref<TrelloListMappingResponse | null>;
  boardLists: Ref<TrelloListSummary[]>;
  loading: Ref<boolean>;
  saving: Ref<boolean>;
  error: Ref<string | null>;
}

let state: ComposableState;

vi.mock("../../composables/useTrelloListMapping", () => ({
  useTrelloListMapping: () => ({
    mapping: state.mapping,
    boardLists: state.boardLists,
    loading: state.loading,
    saving: state.saving,
    error: state.error,
    init: mockInit,
    destroy: mockDestroy,
    refresh: mockRefresh,
    refetchBoardLists: mockRefetchBoardLists,
    save: mockSave,
  }),
}));

import TrelloListMapping from "./TrelloListMapping.vue";

const SEED_TRELLO_LISTS: TrelloListSummary[] = [
  { id: "tl1", name: "Review on board" },
  { id: "tl2", name: "Doing on board" },
];

const SEED_MAPPING: TrelloListMappingResponse = {
  map: { list_id_to_trello_list_id: { "l-review": "tl1" } },
  classification: {
    "l-review": {
      status: "mapped",
      trello_list_id: "tl1",
      trello_list_name: "Review on board",
    },
    "l-todo": { status: "unmapped" },
    "l-blocked": { status: "orphaned", trello_list_id: "tl-dead" },
  },
  trello_available: true,
  board_configured: true,
};

function freshState(
  overrides: Partial<TrelloListMappingResponse> = {},
): ComposableState {
  const merged: TrelloListMappingResponse | null = {
    ...SEED_MAPPING,
    ...overrides,
  };
  return {
    mapping: ref<TrelloListMappingResponse | null>(merged),
    boardLists: ref<TrelloListSummary[]>(SEED_TRELLO_LISTS),
    loading: ref<boolean>(false),
    saving: ref<boolean>(false),
    error: ref<string | null>(null),
  };
}

function mountPanel(): VueWrapper {
  return mount(TrelloListMapping, {
    attachTo: document.body,
    props: { repo: "danxbot" },
  }) as VueWrapper;
}

/**
 * Drive the DanxSelect on the named row by emitting its
 * `update:modelValue` directly — popover machinery would otherwise
 * require a real user click + popover navigation we don't need to
 * exercise here. This matches the established pattern for DanxUI
 * select-style components in jsdom.
 */
async function selectRowValue(
  w: VueWrapper,
  rowId: string,
  value: string,
): Promise<void> {
  const rowWrapper = w.get(`[data-test="trello-select-${rowId}"]`);
  const select = rowWrapper.findComponent({ name: "DanxSelect" });
  await select.vm.$emit("update:modelValue", value);
  await w.vm.$nextTick();
}

beforeEach(() => {
  state = freshState();
  mockInit.mockReset();
  mockDestroy.mockReset();
  mockRefresh.mockReset();
  mockRefetchBoardLists.mockReset();
  mockSave.mockReset();
});

describe("TrelloListMapping", () => {
  it("source MUST NOT use setInterval (SSE-only per dashboard.md mandate)", () => {
    const source = readFileSync(COMPONENT_SOURCE_PATH, "utf-8");
    expect(source).not.toMatch(/setInterval\s*\(/);
  });

  it("source MUST NOT use native `title=` HTML attributes (DanxTooltip mandate)", () => {
    const source = readFileSync(COMPONENT_SOURCE_PATH, "utf-8");
    // Strip the <script> block — TypeScript symbol names ("title") are fine
    // there. The rule applies only to attributes inside <template>.
    const tpl = source.slice(source.indexOf("<template>"));
    // PascalCase component-prop `title="…"` (e.g. <DanxDialog title="…">) is
    // allowed (it's a prop, not a hover tooltip). The ban is on lowercase
    // HTML elements only.
    expect(tpl).not.toMatch(/<[a-z][a-z0-9-]*\s[^>]*\btitle=/i);
    expect(tpl).not.toMatch(/<[a-z][a-z0-9-]*\s[^>]*:title=/i);
  });

  it("renders one row per danxbot list with name + dropdown + status badge", () => {
    const w = mountPanel();
    expect(w.find('[data-test="trello-list-mapping"]').exists()).toBe(true);
    expect(w.find('[data-test="trello-row-l-review"]').exists()).toBe(true);
    expect(w.find('[data-test="trello-row-l-todo"]').exists()).toBe(true);
    expect(w.find('[data-test="trello-row-l-blocked"]').exists()).toBe(true);
    w.unmount();
  });

  it("renders all three badge states (mapped/unmapped/orphaned)", () => {
    const w = mountPanel();
    const mapped = w.get('[data-test="trello-badge-l-review"]');
    expect(mapped.text()).toMatch(/Mapped/);
    expect(mapped.attributes("data-status")).toBe("mapped");

    const unmapped = w.get('[data-test="trello-badge-l-todo"]');
    expect(unmapped.text()).toMatch(/Unmapped/);
    expect(unmapped.attributes("data-status")).toBe("unmapped");

    const orphaned = w.get('[data-test="trello-badge-l-blocked"]');
    expect(orphaned.text()).toMatch(/Orphaned/);
    expect(orphaned.attributes("data-status")).toBe("orphaned");
    w.unmount();
  });

  it("dropdown change marks the row dirty and enables Save", async () => {
    const w = mountPanel();
    expect(
      (w.get('[data-test="trello-save"]').element as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await selectRowValue(w, "l-todo", "tl2");

    expect(
      (w.get('[data-test="trello-save"]').element as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(w.find('[data-test="trello-row-dirty-l-todo"]').exists()).toBe(true);
    w.unmount();
  });

  it("Save click calls save() with the modified map", async () => {
    mockSave.mockResolvedValueOnce(undefined);
    const w = mountPanel();
    await selectRowValue(w, "l-todo", "tl2");
    await w.get('[data-test="trello-save"]').trigger("click");
    await w.vm.$nextTick();

    const expectedMap: TrelloListMap = {
      list_id_to_trello_list_id: {
        "l-review": "tl1",
        "l-todo": "tl2",
      },
    };
    expect(mockSave).toHaveBeenCalledWith(expectedMap);
    w.unmount();
  });

  it("Re-fetch button calls refetchBoardLists()", async () => {
    mockRefetchBoardLists.mockResolvedValueOnce(undefined);
    const w = mountPanel();
    await w.get('[data-test="trello-refetch"]').trigger("click");
    expect(mockRefetchBoardLists).toHaveBeenCalled();
    w.unmount();
  });

  it("hidden entirely when board_configured is false", () => {
    state = freshState({ board_configured: false, trello_available: false });
    const w = mountPanel();
    expect(w.find('[data-test="trello-list-mapping"]').exists()).toBe(false);
    w.unmount();
  });

  it("hidden entirely while mapping is still loading (no flash)", () => {
    state.mapping.value = null;
    state.loading.value = true;
    const w = mountPanel();
    expect(w.find('[data-test="trello-list-mapping"]').exists()).toBe(false);
    w.unmount();
  });

  it("renders trello-unreachable banner when trello_available is false but board_configured", () => {
    state = freshState({ trello_available: false });
    const w = mountPanel();
    expect(w.find('[data-test="trello-list-mapping"]').exists()).toBe(true);
    expect(w.find('[data-test="trello-unreachable"]').exists()).toBe(true);
    w.unmount();
  });

  it("calls init on mount and destroy on unmount", () => {
    const w = mountPanel();
    expect(mockInit).toHaveBeenCalled();
    w.unmount();
    expect(mockDestroy).toHaveBeenCalled();
  });

  it("after Save succeeds + server snapshot updates, dirty clears and Save re-disables", async () => {
    // Simulate the composable's post-save behavior: save() resolves AND
    // the composable replaces `mapping.value.map` with the round-tripped
    // shape. The component's watcher then re-seeds `draft` (isDirty=false
    // path) so the dirty marker clears and Save disables.
    mockSave.mockImplementationOnce(async (next: TrelloListMap) => {
      state.mapping.value = { ...state.mapping.value!, map: next };
    });
    const w = mountPanel();
    await selectRowValue(w, "l-todo", "tl2");
    expect(w.find('[data-test="trello-row-dirty-l-todo"]').exists()).toBe(true);

    await w.get('[data-test="trello-save"]').trigger("click");
    await w.vm.$nextTick();
    await w.vm.$nextTick();

    expect(
      (w.get('[data-test="trello-save"]').element as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(w.find('[data-test="trello-row-dirty-l-todo"]').exists()).toBe(false);
    w.unmount();
  });

  it("SSE-driven mapping refresh does NOT clobber the operator's unsaved selection (S2 fix)", async () => {
    const w = mountPanel();
    await selectRowValue(w, "l-todo", "tl2");

    // Simulate another tab editing — server snapshot bumps under us.
    state.mapping.value = {
      ...state.mapping.value!,
      map: { list_id_to_trello_list_id: { "l-blocked": "tl-other-tab" } },
    };
    await w.vm.$nextTick();

    // Operator's unsaved selection on l-todo MUST survive.
    const danxSelect = w
      .get('[data-test="trello-select-l-todo"]')
      .findComponent({ name: "DanxSelect" });
    expect(danxSelect.props("modelValue")).toBe("tl2");
    expect(w.find('[data-test="trello-row-dirty-l-todo"]').exists()).toBe(true);
    w.unmount();
  });
});
