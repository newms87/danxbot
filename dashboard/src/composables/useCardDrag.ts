import { ref, type Ref } from "vue";
import type { IssueListItem, IssueStatus } from "../types";

export interface DragState {
  issue: IssueListItem;
  fromStatus: IssueStatus;
}

export interface CardDragHandlers {
  onDragstart: (e: DragEvent) => void;
  onDragend: (e: DragEvent) => void;
}

export interface ColumnDragHandlers {
  onDragover: (e: DragEvent) => void;
  onDragleave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

export interface UseCardDragOptions {
  /**
   * Invoked when a card is released over a *different* column.
   * The composable does not own state mutation — caller patches the
   * issue (optimistic + reconcile) and surfaces failures via a thrown
   * rejection. Same-column drops short-circuit before this fires.
   */
  onDrop: (
    issue: IssueListItem,
    fromStatus: IssueStatus,
    toStatus: IssueStatus,
  ) => Promise<void> | void;
}

export interface UseCardDragReturn {
  bindCard: (issue: IssueListItem) => CardDragHandlers;
  bindColumn: (status: IssueStatus) => ColumnDragHandlers;
  dragging: Ref<DragState | null>;
  hoverColumn: Ref<IssueStatus | null>;
  isDragging: (issue: IssueListItem) => boolean;
  isHoveringColumn: (status: IssueStatus) => boolean;
}

const DRAG_IMAGE_OFFSET_X = 20;
const DRAG_IMAGE_OFFSET_Y = 12;

/**
 * Build a transient detached clone for `DataTransfer.setDragImage` so
 * the cursor follows a tilted-card ghost rather than the browser
 * default. The browser snapshots the element synchronously inside
 * `setDragImage`, so we only need to keep the clone alive for one
 * microtask after `dragstart`.
 */
function buildDragImage(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  clone.style.position = "fixed";
  clone.style.top = "-1000px";
  clone.style.left = "-1000px";
  clone.style.width = `${source.offsetWidth || 240}px`;
  clone.style.transform = "rotate(2deg) scale(1.02)";
  clone.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.45)";
  clone.style.opacity = "0.95";
  clone.style.pointerEvents = "none";
  clone.style.zIndex = "9999";
  document.body.appendChild(clone);
  return clone;
}

/**
 * Drag-and-drop composable for the issue board. Pure HTML5 DnD — no
 * library dependency. Caller wires `bindCard` to each draggable card
 * and `bindColumn` to each drop target; `onDrop` fires once per
 * cross-column release.
 *
 * Esc cancellation: the browser fires `dragend` without a matching
 * `drop`, so the patch path (gated on `drop`) is never reached. We
 * still clear local state in `dragend` so the next drag starts clean.
 */
export function useCardDrag(opts: UseCardDragOptions): UseCardDragReturn {
  const dragging = ref<DragState | null>(null);
  const hoverColumn = ref<IssueStatus | null>(null);
  // `bindColumn` is invoked once per column per render. Memoize the
  // handler trio per status so Vue's runtime can short-circuit the
  // listener-patch on re-renders (object identity matches → no
  // detach/reattach). The map is composable-scoped so per-board state
  // does not leak across instances.
  const columnHandlers = new Map<IssueStatus, ColumnDragHandlers>();

  function bindCard(issue: IssueListItem): CardDragHandlers {
    return {
      onDragstart(e: DragEvent): void {
        dragging.value = { issue, fromStatus: issue.status };
        const dt = e.dataTransfer;
        if (dt) {
          dt.effectAllowed = "move";
          // Firefox refuses to start a drag without `setData`.
          dt.setData("text/plain", issue.id);
          const target = e.currentTarget as HTMLElement | null;
          if (target && typeof dt.setDragImage === "function") {
            const ghost = buildDragImage(target);
            dt.setDragImage(ghost, DRAG_IMAGE_OFFSET_X, DRAG_IMAGE_OFFSET_Y);
            // The browser already snapshotted the clone; clean up next tick.
            queueMicrotask(() => ghost.remove());
          }
        }
      },
      onDragend(_e: DragEvent): void {
        dragging.value = null;
        hoverColumn.value = null;
      },
    };
  }

  function bindColumn(status: IssueStatus): ColumnDragHandlers {
    const cached = columnHandlers.get(status);
    if (cached) return cached;
    const handlers: ColumnDragHandlers = {
      onDragover(e: DragEvent): void {
        if (!dragging.value) return;
        e.preventDefault();
        const dt = e.dataTransfer;
        if (dt) dt.dropEffect = "move";
        hoverColumn.value = status;
      },
      onDragleave(e: DragEvent): void {
        if (hoverColumn.value !== status) return;
        const root = e.currentTarget as Node | null;
        const next = e.relatedTarget as Node | null;
        // Crossing into a child of the column root fires dragleave on
        // the parent — ignore those so the highlight does not flicker.
        if (root && next && root.contains(next)) return;
        hoverColumn.value = null;
      },
      onDrop(e: DragEvent): void {
        e.preventDefault();
        const drag = dragging.value;
        hoverColumn.value = null;
        if (!drag) return;
        const { issue, fromStatus } = drag;
        dragging.value = null;
        if (fromStatus === status) return;
        const result = opts.onDrop(issue, fromStatus, status);
        if (result && typeof (result as Promise<void>).catch === "function") {
          // Defensive: callers SHOULD catch their own rejections (the
          // board emits `move` and `IssuesPage.onMove` owns the error
          // surface). This catch only fires when a future caller forgets
          // — failing loud beats `Unhandled promise rejection` in the
          // console with no stack context.
          (result as Promise<void>).catch((err) => {
            console.error(
              `[useCardDrag] onDrop rejected for ${issue.id} ${fromStatus}→${status}:`,
              err,
            );
          });
        }
      },
    };
    columnHandlers.set(status, handlers);
    return handlers;
  }

  function isDragging(issue: IssueListItem): boolean {
    return dragging.value?.issue.id === issue.id;
  }

  function isHoveringColumn(status: IssueStatus): boolean {
    return hoverColumn.value === status;
  }

  return {
    bindCard,
    bindColumn,
    dragging,
    hoverColumn,
    isDragging,
    isHoveringColumn,
  };
}
