import { ref, type Ref } from "vue";
import type {
  CascadeAction,
  CascadeIssueListBody,
  CascadeIssueListResult,
} from "../api/issues";
import type { IssueListItem, List, ListType } from "../types";

interface PendingCascade {
  kind: "cascade";
  issue: IssueListItem;
  destList: List;
  descendants: IssueListItem[];
  defaults: Record<string, CascadeAction>;
}

export interface UseCascadeMoveOptions {
  issues: Ref<IssueListItem[]>;
  moveIssueList: (
    id: string,
    destList: { name: string; type: ListType },
  ) => Promise<void>;
  cascadeIssueList: (
    epicId: string,
    body: Omit<CascadeIssueListBody, "epic_id">,
  ) => Promise<CascadeIssueListResult>;
}

export interface UseCascadeMoveApi {
  pendingMove: Ref<PendingCascade | null>;
  moveDialogBusy: Ref<boolean>;
  moveDialogError: Ref<string | null>;
  onMove: (issue: IssueListItem, toList: List) => void;
  onCascadeConfirm: (payload: {
    overrides: Record<string, CascadeAction>;
  }) => Promise<void>;
  onCascadeCancel: () => void;
}

/**
 * BFS-flatten every descendant of `epic` from the in-memory snapshot.
 * The cascade dialog renders rows for every reachable descendant; cards
 * not present in `all` (closed beyond the recent slice, hidden by
 * filters) are absent — the server visits them via its own DB query
 * and applies the spec table.
 */
export function collectDescendants(
  epic: IssueListItem,
  all: IssueListItem[],
): IssueListItem[] {
  const byParent = new Map<string, IssueListItem[]>();
  for (const i of all) {
    if (i.parent_id === null) continue;
    if (!byParent.has(i.parent_id)) byParent.set(i.parent_id, []);
    byParent.get(i.parent_id)!.push(i);
  }
  const out: IssueListItem[] = [];
  const queue: string[] = [epic.id];
  const seen = new Set<string>([epic.id]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const kids = byParent.get(pid) ?? [];
    for (const kid of kids) {
      if (seen.has(kid.id)) continue;
      seen.add(kid.id);
      out.push(kid);
      queue.push(kid.id);
    }
  }
  return out;
}

/**
 * Mirrors the terminal-source row of the server helper's spec table:
 * done + cancelled descendants stay; others default to follow the
 * parent. Operator-facing pre-view only — submitting an empty
 * `overrides` lets the server re-derive.
 */
export function computeCascadeDefaults(
  descendants: IssueListItem[],
): Record<string, CascadeAction> {
  const out: Record<string, CascadeAction> = {};
  for (const d of descendants) {
    if (d.status === "Done" || d.status === "Cancelled") {
      out[d.id] = { kind: "stay" };
    } else {
      out[d.id] = { kind: "move_same_type" };
    }
  }
  return out;
}

/**
 * Owns the cascade-dialog state machine for IssuesPage. Drag of a
 * children-bearing card opens the dialog; the dialog's confirm dispatches
 * `cascadeIssueList`; the dialog's cancel clears state. Childless drags
 * fall straight through to `moveIssueList`.
 */
export function useCascadeMove(opts: UseCascadeMoveOptions): UseCascadeMoveApi {
  const pendingMove = ref<PendingCascade | null>(null);
  const moveDialogBusy = ref(false);
  const moveDialogError = ref<string | null>(null);

  function onMove(issue: IssueListItem, toList: List): void {
    if (issue.children.length > 0) {
      moveDialogError.value = null;
      const descendants = collectDescendants(issue, opts.issues.value);
      const defaults = computeCascadeDefaults(descendants);
      pendingMove.value = {
        kind: "cascade",
        issue,
        destList: toList,
        descendants,
        defaults,
      };
      return;
    }
    void opts
      .moveIssueList(issue.id, { name: toList.name, type: toList.type })
      .catch(() => {});
  }

  async function onCascadeConfirm(payload: {
    overrides: Record<string, CascadeAction>;
  }): Promise<void> {
    const p = pendingMove.value;
    if (!p || p.kind !== "cascade") return;
    moveDialogBusy.value = true;
    moveDialogError.value = null;
    try {
      await opts.cascadeIssueList(p.issue.id, {
        dest_list_name: p.destList.name,
        overrides: payload.overrides,
      });
      pendingMove.value = null;
    } catch (err) {
      moveDialogError.value = err instanceof Error ? err.message : String(err);
    } finally {
      moveDialogBusy.value = false;
    }
  }

  function onCascadeCancel(): void {
    pendingMove.value = null;
    moveDialogError.value = null;
    moveDialogBusy.value = false;
  }

  return {
    pendingMove,
    moveDialogBusy,
    moveDialogError,
    onMove,
    onCascadeConfirm,
    onCascadeCancel,
  };
}
