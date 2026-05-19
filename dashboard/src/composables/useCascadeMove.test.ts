import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";
import {
  collectDescendants,
  computeCascadeDefaults,
  useCascadeMove,
} from "./useCascadeMove";
import type { IssueListItem, List } from "../types";

function makeIssue(
  over: Partial<IssueListItem> & Pick<IssueListItem, "id">,
): IssueListItem {
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

describe("collectDescendants", () => {
  it("BFS-walks every descendant including transitive children", () => {
    const epic = makeIssue({ id: "E1", type: "Epic", children: ["C1", "C2"] });
    const c1 = makeIssue({ id: "C1", parent_id: "E1", children: ["G1"] });
    const c2 = makeIssue({ id: "C2", parent_id: "E1" });
    const g1 = makeIssue({ id: "G1", parent_id: "C1" });
    const out = collectDescendants(epic, [epic, c1, c2, g1]);
    expect(out.map((i) => i.id).sort()).toEqual(["C1", "C2", "G1"]);
  });

  it("returns empty when the epic has no descendants in the snapshot", () => {
    const epic = makeIssue({ id: "E1" });
    expect(collectDescendants(epic, [epic])).toEqual([]);
  });

  it("does not revisit cycles", () => {
    const a = makeIssue({ id: "A", parent_id: "B" });
    const b = makeIssue({ id: "B", parent_id: "A" });
    const out = collectDescendants(a, [a, b]);
    expect(out.map((i) => i.id)).toEqual(["B"]);
  });
});

describe("computeCascadeDefaults", () => {
  it("done + cancelled descendants stay, others follow parent", () => {
    const descendants = [
      makeIssue({ id: "D1", status: "Done" }),
      makeIssue({ id: "D2", status: "Cancelled" }),
      makeIssue({ id: "D3", status: "Review" }),
      makeIssue({ id: "D4", status: "In Progress" }),
    ];
    expect(computeCascadeDefaults(descendants)).toEqual({
      D1: { kind: "stay" },
      D2: { kind: "stay" },
      D3: { kind: "move_same_type" },
      D4: { kind: "move_same_type" },
    });
  });
});

describe("useCascadeMove", () => {
  function setup() {
    const issuesRef = ref<IssueListItem[]>([]);
    const moveIssueList = vi.fn(async () => {});
    const cascadeIssueList = vi.fn(
      async () => ({ updated: [], skipped: [] }),
    );
    const api = useCascadeMove({
      issues: issuesRef,
      moveIssueList,
      cascadeIssueList,
    });
    return { issuesRef, moveIssueList, cascadeIssueList, api };
  }

  it("no-children → moveIssueList called, no dialog opens", () => {
    const { issuesRef, moveIssueList, cascadeIssueList, api } = setup();
    const issue = makeIssue({ id: "DX-1", children: [] });
    issuesRef.value = [issue];
    api.onMove(issue, listToDo);
    expect(api.pendingMove.value).toBeNull();
    expect(moveIssueList).toHaveBeenCalledWith("DX-1", { name: "ToDo", type: "ready" });
    expect(cascadeIssueList).not.toHaveBeenCalled();
  });

  it("with-children → dialog opens with descendants + defaults; no PATCH yet", () => {
    const { issuesRef, moveIssueList, cascadeIssueList, api } = setup();
    const epic = makeIssue({ id: "E", type: "Epic", children: ["C"] });
    const child = makeIssue({ id: "C", parent_id: "E", status: "Done" });
    issuesRef.value = [epic, child];
    api.onMove(epic, listInProgress);
    expect(api.pendingMove.value).not.toBeNull();
    expect(api.pendingMove.value?.issue.id).toBe("E");
    expect(api.pendingMove.value?.destList.name).toBe("In Progress");
    expect(api.pendingMove.value?.descendants.map((d) => d.id)).toEqual(["C"]);
    expect(api.pendingMove.value?.defaults).toEqual({ C: { kind: "stay" } });
    expect(moveIssueList).not.toHaveBeenCalled();
    expect(cascadeIssueList).not.toHaveBeenCalled();
  });

  it("onCascadeConfirm → cascadeIssueList called with dest list + overrides; pendingMove cleared", async () => {
    const { issuesRef, cascadeIssueList, api } = setup();
    const epic = makeIssue({ id: "E", type: "Epic", children: ["C"] });
    issuesRef.value = [epic, makeIssue({ id: "C", parent_id: "E" })];
    api.onMove(epic, listCancelled);
    await api.onCascadeConfirm({ overrides: { C: { kind: "stay" } } });
    expect(cascadeIssueList).toHaveBeenCalledWith("E", {
      dest_list_name: "Cancelled",
      overrides: { C: { kind: "stay" } },
    });
    expect(api.pendingMove.value).toBeNull();
    expect(api.moveDialogBusy.value).toBe(false);
    expect(api.moveDialogError.value).toBeNull();
  });

  it("moveDialogBusy flips true while cascadeIssueList is in-flight", async () => {
    const { issuesRef, cascadeIssueList, api } = setup();
    let release: () => void = () => {};
    cascadeIssueList.mockImplementationOnce(
      () => new Promise<{ updated: string[]; skipped: string[] }>((r) => {
        release = () => r({ updated: [], skipped: [] });
      }),
    );
    const epic = makeIssue({ id: "E", type: "Epic", children: ["C"] });
    issuesRef.value = [epic, makeIssue({ id: "C", parent_id: "E" })];
    api.onMove(epic, listInProgress);
    const p = api.onCascadeConfirm({ overrides: {} });
    expect(api.moveDialogBusy.value).toBe(true);
    release();
    await p;
    expect(api.moveDialogBusy.value).toBe(false);
  });

  it("onCascadeConfirm error surfaces in moveDialogError; pendingMove retained", async () => {
    const { issuesRef, cascadeIssueList, api } = setup();
    cascadeIssueList.mockRejectedValueOnce(new Error("boom"));
    const epic = makeIssue({ id: "E", type: "Epic", children: ["C"] });
    issuesRef.value = [epic, makeIssue({ id: "C", parent_id: "E" })];
    api.onMove(epic, listCancelled);
    await api.onCascadeConfirm({ overrides: {} });
    expect(api.moveDialogError.value).toBe("boom");
    expect(api.pendingMove.value).not.toBeNull();
    expect(api.moveDialogBusy.value).toBe(false);
  });

  it("onCascadeCancel clears pendingMove + busy + error", () => {
    const { issuesRef, api } = setup();
    const epic = makeIssue({ id: "E", type: "Epic", children: ["C"] });
    issuesRef.value = [epic, makeIssue({ id: "C", parent_id: "E" })];
    api.onMove(epic, listCancelled);
    api.moveDialogError.value = "stale";
    api.moveDialogBusy.value = true;
    api.onCascadeCancel();
    expect(api.pendingMove.value).toBeNull();
    expect(api.moveDialogError.value).toBeNull();
    expect(api.moveDialogBusy.value).toBe(false);
  });

  it("onCascadeConfirm without an open dialog is a no-op", async () => {
    const { cascadeIssueList, api } = setup();
    await api.onCascadeConfirm({ overrides: {} });
    expect(cascadeIssueList).not.toHaveBeenCalled();
  });

  it("moveIssueList rejection is swallowed (caller already surfaced via error ref)", () => {
    const { issuesRef, moveIssueList, api } = setup();
    moveIssueList.mockRejectedValueOnce(new Error("net"));
    const issue = makeIssue({ id: "DX-2", children: [] });
    issuesRef.value = [issue];
    expect(() => api.onMove(issue, listToDo)).not.toThrow();
  });
});
