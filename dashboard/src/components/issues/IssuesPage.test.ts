import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import type { IssueListItem, List } from "../../types";

// Capture the latest stub instances so each test can reach in and
// fire a move from the board stub via `boardEmit("move", issue, list)`.
let boardEmit: ((event: string, ...args: unknown[]) => void) | null = null;
// Per-test override for the cascade dialog stub's confirm payload —
// the dest=blocked branch of `onCascadeDialogConfirm` only fires when
// `blockedReason` is non-empty in the payload, so the test needs to
// shape the emit accordingly.
let cascadeConfirmPayload: {
  overrides: Record<string, unknown>;
  unblockConfirmed: boolean;
  blockedReason?: string;
} = { overrides: {}, unblockConfirmed: true };

const moveIssueListMock =
  vi.fn<(id: string, dest: { name: string; type: string }, options?: unknown) => Promise<void>>(
    async () => {},
  );
const cascadeIssueListMock =
  vi.fn<(epicId: string, body: Record<string, unknown>) => Promise<{ updated: string[]; skipped: string[] }>>(
    async () => ({ updated: [], skipped: [] }),
  );
// Hoisted issues ref so individual tests can populate the in-memory
// list before the page conditionally mounts the IssueBoard
// (`issues.length === 0` short-circuits to a placeholder).
const issuesRef = ref<IssueListItem[]>([]);

// Mocked composables. `useIssues` is the load-bearing surface for the
// routing test — the page calls `moveIssueList` directly for the no-
// children path and `cascadeIssueList` for the with-children path; the
// rest of the API is no-op-ed.
vi.mock("../../composables/useIssues", () => {
  return {
    useIssues: () => ({
      issues: issuesRef,
      loading: ref(false),
      error: ref<string | null>(null),
      refresh: vi.fn(),
      fetchDetail: vi.fn(),
      moveIssueList: moveIssueListMock,
      moveIssuePriority: vi.fn(),
      applyIssueUpdate: vi.fn(),
      cascadeIssueList: cascadeIssueListMock,
    }),
  };
});

vi.mock("../../composables/useListColors", () => {
  return {
    useListColors: () => ({
      lists: ref<List[]>([
        { id: "L-review", name: "Review", type: "review", order: 0, is_default_for_type: true, color: "#ccc" },
        { id: "L-todo", name: "ToDo", type: "ready", order: 1, is_default_for_type: true, color: "#ccc" },
        { id: "L-prog", name: "In Progress", type: "in_progress", order: 2, is_default_for_type: true, color: "#ccc" },
        { id: "L-blocked", name: "Blocked", type: "blocked", order: 3, is_default_for_type: true, color: "#ccc" },
        { id: "L-done", name: "Done", type: "completed", order: 4, is_default_for_type: true, color: "#ccc" },
        { id: "L-cancelled", name: "Cancelled", type: "cancelled", order: 5, is_default_for_type: true, color: "#ccc" },
      ]),
      loading: ref(false),
      error: ref<string | null>(null),
      colorFor: () => "#ccc",
      refresh: vi.fn(),
      init: vi.fn(),
      destroy: vi.fn(),
    }),
  };
});

vi.mock("../../composables/useIssueFilters", () => {
  return {
    useIssueFilters: () => ({
      q: ref(""),
      types: ref([]),
      blockedOnly: ref(false),
      showClosed: ref(false),
      scopedEpicId: ref<string | null>(null),
      scopeMode: ref<"filter" | "highlight">("filter"),
      showEpicChildren: ref(false),
      toggleType: vi.fn(),
    }),
    isInScope: () => true,
  };
});

// Stub heavy SFC dependencies so the page mounts cleanly without
// pulling their PATCH wiring + SSE behaviour into the routing test.
const StubComp = (name: string, emits: string[] = []) =>
  defineComponent({
    name,
    inheritAttrs: false,
    emits,
    setup(_p, { emit }) {
      if (name === "IssueBoard") boardEmit = emit as never;
      return () => h("div", { class: `stub-${name.toLowerCase()}` });
    },
  });

const DanxSplitPanelStub = defineComponent({
  name: "DanxSplitPanel",
  props: ["panels", "modelValue", "storageKey", "requireActive"],
  emits: ["update:modelValue"],
  setup(_p, { slots }) {
    // Render every named slot inline so child stubs (IssueBoard, drawer)
    // are mounted and reachable.
    return () =>
      h("div", { class: "stub-danxsplitpanel" }, [
        ...(slots.board ? [h("div", { class: "panel-board" }, slots.board())] : []),
        ...(slots.drawer ? [h("div", { class: "panel-drawer" }, slots.drawer())] : []),
      ]);
  },
});

const DanxTooltipStub = defineComponent({
  name: "DanxTooltip",
  props: ["tooltip"],
  setup(_p, { slots }) {
    return () => h("span", slots.trigger?.() ?? slots.default?.() ?? []);
  },
});

const DanxDialogStub = defineComponent({
  name: "DanxDialog",
  props: ["modelValue", "title"],
  emits: ["update:modelValue", "close", "confirm"],
  setup(_p, { slots }) {
    return () => h("div", { class: "stub-danxdialog" }, slots.default?.());
  },
});

const globalStubs = {
  IssueBoard: StubComp("IssueBoard", ["select", "parent-click", "move", "reorder"]),
  IssueDetailView: StubComp("IssueDetailView"),
  BoardChatOverlay: StubComp("BoardChatOverlay"),
  PasteCardsDialog: StubComp("PasteCardsDialog"),
  FilterToolbar: StubComp("FilterToolbar"),
  TriageButton: StubComp("TriageButton"),
  CreateCardButton: StubComp("CreateCardButton"),
  BlockedReasonDialog: StubComp("BlockedReasonDialog", ["submit", "cancel"]),
  UnblockConfirmDialog: StubComp("UnblockConfirmDialog", ["confirm", "cancel"]),
  EpicMoveCascadeDialog: defineComponent({
    name: "EpicMoveCascadeDialog",
    props: ["modelValue", "parent", "destList", "descendants", "defaults", "allLists", "busy", "error"],
    emits: ["update:modelValue", "confirm", "cancel"],
    setup(props, { emit }) {
      return () =>
        h(
          "div",
          {
            class: "stub-epicmovecascadedialog",
            "data-test": "stub-cascade-dialog",
            "data-parent-id": props.parent?.id,
            "data-dest-list": props.destList?.name,
            "data-descendant-count": String((props.descendants ?? []).length),
          },
          [
            h(
              "button",
              {
                "data-test": "stub-cascade-confirm",
                onClick: () => emit("confirm", cascadeConfirmPayload),
              },
              "Confirm",
            ),
            h(
              "button",
              {
                "data-test": "stub-cascade-cancel",
                onClick: () => emit("cancel"),
              },
              "Cancel",
            ),
          ],
        );
    },
  }),
  DanxSplitPanel: DanxSplitPanelStub,
  DanxTooltip: DanxTooltipStub,
  DanxDialog: DanxDialogStub,
};

async function mountPage() {
  const { default: IssuesPage } = await import("./IssuesPage.vue");
  const w = mount(IssuesPage, {
    props: { selectedRepo: "danxbot" },
    global: { stubs: globalStubs },
  });
  await flushPromises();
  return w;
}

function makeIssue(over: Partial<IssueListItem> & Pick<IssueListItem, "id">): IssueListItem {
  return {
    id: over.id,
    type: over.type ?? "Feature",
    title: over.title ?? `Title ${over.id}`,
    description: over.description ?? "",
    status: over.status ?? "Review",
    parent_id: over.parent_id ?? null,
    children: over.children ?? [],
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
    requires_human: null,
    requires_human_child_count: 0,
    blocked: over.blocked ?? null,
    list_name: over.list_name ?? "Review",
    priority: over.priority ?? 1,
    assigned_agent: null,
  } as unknown as IssueListItem;
}

const listToDo: List = { id: "L-todo", name: "ToDo", type: "ready", order: 1, is_default_for_type: true, color: "#ccc" };
const listInProgress: List = { id: "L-prog", name: "In Progress", type: "in_progress", order: 2, is_default_for_type: true, color: "#ccc" };
const listCancelled: List = { id: "L-cancelled", name: "Cancelled", type: "cancelled", order: 5, is_default_for_type: true, color: "#ccc" };
const listBlocked: List = { id: "L-blocked", name: "Blocked", type: "blocked", order: 3, is_default_for_type: true, color: "#ccc" };

describe("IssuesPage onMove routing", () => {
  beforeEach(() => {
    moveIssueListMock.mockClear();
    cascadeIssueListMock.mockClear();
    boardEmit = null;
    cascadeConfirmPayload = { overrides: {}, unblockConfirmed: true };
  });

  it("no-children card → direct PATCH via moveIssueList; cascade dialog does NOT open", async () => {
    const issue = makeIssue({ id: "DX-1", children: [] });
    issuesRef.value = [issue];
    const w = await mountPage();
    expect(boardEmit).toBeTruthy();
    boardEmit!("move", issue, listToDo);
    await flushPromises();
    expect(w.find('[data-test="stub-cascade-dialog"]').exists()).toBe(false);
    expect(moveIssueListMock).toHaveBeenCalledTimes(1);
    expect(moveIssueListMock).toHaveBeenCalledWith("DX-1", { name: "ToDo", type: "ready" });
    expect(cascadeIssueListMock).not.toHaveBeenCalled();
  });

  it("with-children card → cascade dialog opens; moveIssueList NOT called", async () => {
    const epic = makeIssue({ id: "DX-10", type: "Epic", children: ["DX-11", "DX-12"] });
    const child1 = makeIssue({ id: "DX-11", parent_id: "DX-10" });
    const child2 = makeIssue({ id: "DX-12", parent_id: "DX-10" });
    issuesRef.value = [epic, child1, child2];
    const w = await mountPage();
    boardEmit!("move", epic, listInProgress);
    await flushPromises();
    const dialog = w.find('[data-test="stub-cascade-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.attributes("data-parent-id")).toBe("DX-10");
    expect(dialog.attributes("data-dest-list")).toBe("In Progress");
    expect(moveIssueListMock).not.toHaveBeenCalled();
    expect(cascadeIssueListMock).not.toHaveBeenCalled();
  });

  it("cascade dialog @confirm → cascadeIssueList called with correct payload", async () => {
    const epic = makeIssue({ id: "DX-20", type: "Epic", children: ["DX-21"] });
    const child = makeIssue({ id: "DX-21", parent_id: "DX-20" });
    issuesRef.value = [epic, child];
    const w = await mountPage();
    boardEmit!("move", epic, listCancelled);
    await flushPromises();
    await w.find('[data-test="stub-cascade-confirm"]').trigger("click");
    await flushPromises();
    expect(cascadeIssueListMock).toHaveBeenCalledTimes(1);
    const [epicId, body] = cascadeIssueListMock.mock.calls[0];
    expect(epicId).toBe("DX-20");
    expect(body).toMatchObject({
      dest_list_name: "Cancelled",
      unblock_confirmed: true,
      overrides: {},
    });
    // No blocked_reason for non-blocked dest.
    expect(body).not.toHaveProperty("blocked_reason");
  });

  it("cascade dialog @confirm to a blocked-type dest → cascadeIssueList payload carries blocked_reason", async () => {
    const epic = makeIssue({ id: "DX-25", type: "Epic", children: ["DX-26"] });
    const child = makeIssue({ id: "DX-26", parent_id: "DX-25" });
    issuesRef.value = [epic, child];
    cascadeConfirmPayload = {
      overrides: {},
      unblockConfirmed: false,
      blockedReason: "Spec under review",
    };
    const w = await mountPage();
    boardEmit!("move", epic, listBlocked);
    await flushPromises();
    await w.find('[data-test="stub-cascade-confirm"]').trigger("click");
    await flushPromises();
    expect(cascadeIssueListMock).toHaveBeenCalledTimes(1);
    const [, body] = cascadeIssueListMock.mock.calls[0];
    expect(body).toMatchObject({
      dest_list_name: "Blocked",
      unblock_confirmed: false,
      blocked_reason: "Spec under review",
      overrides: {},
    });
  });

  it("cascade dialog @cancel → no PATCH fires; dialog closes", async () => {
    const epic = makeIssue({ id: "DX-30", type: "Epic", children: ["DX-31"] });
    const child = makeIssue({ id: "DX-31", parent_id: "DX-30" });
    issuesRef.value = [epic, child];
    const w = await mountPage();
    boardEmit!("move", epic, listCancelled);
    await flushPromises();
    expect(w.find('[data-test="stub-cascade-dialog"]').exists()).toBe(true);
    await w.find('[data-test="stub-cascade-cancel"]').trigger("click");
    await flushPromises();
    expect(cascadeIssueListMock).not.toHaveBeenCalled();
    expect(moveIssueListMock).not.toHaveBeenCalled();
    expect(w.find('[data-test="stub-cascade-dialog"]').exists()).toBe(false);
  });
});
