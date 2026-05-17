import { ref, type Ref } from "vue";
import type { IssueListItem, IssueStatus } from "../types";

/**
 * DX-586 — `useCardDrag` is generic on the column identity type so the
 * IssueBoard can pass the per-repo `List` shape (name + type + color)
 * as the drop target. Pre-DX-586 callers passed `IssueStatus`; the
 * generic default keeps that path working until every consumer
 * migrates.
 *
 * Column identity equality MUST be value-equality, not reference. The
 * board re-derives `columns[]` per render (sorted from the parent's
 * `lists` prop), so two renders produce different List objects with
 * the same `id`. `bindColumn` memoizes handlers per identity value
 * (default `===` for primitives like IssueStatus; caller can override
 * with `keyOf` for object-shaped columns).
 */

export interface DragState<TCol = IssueStatus> {
  issue: IssueListItem;
  fromCol: TCol;
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

/**
 * Drop-slot handlers for the gaps between cards in the same column.
 * `key` is the slot's logical identity (caller supplies
 * `${status}:${beforeId ?? "head"}:${afterId ?? "tail"}`) so
 * `isHoveringSlot` can target a specific gap without coordinate math.
 */
export interface SlotDragHandlers {
  onDragover: (e: DragEvent) => void;
  onDragleave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

export interface UseCardDragOptions<TCol = IssueStatus> {
  /**
   * Invoked when a card is released over a *different* column.
   * The composable does not own state mutation — caller patches the
   * issue (optimistic + reconcile) and surfaces failures via a thrown
   * rejection. Same-column drops short-circuit before this fires.
   */
  onDrop: (
    issue: IssueListItem,
    fromCol: TCol,
    toCol: TCol,
  ) => Promise<void> | void;
  /**
   * DX-264 — invoked when a card is released over a drop slot (the
   * transparent gap between two cards in the same column). The
   * composable computes nothing; it surfaces the slot's neighbors so
   * the caller can compute the new `position` via `nextPosition` from
   * `./cardPosition.ts` and PATCH the card. Either neighbor may be
   * `null` (top / bottom of column). Same-column drops on the column
   * background (NOT a slot) are inert (`onDrop` short-circuits on equal
   * column); intra-column reordering goes exclusively through slots.
   */
  onReorder?: (
    issue: IssueListItem,
    before: IssueListItem | null,
    after: IssueListItem | null,
  ) => Promise<void> | void;
  /**
   * Column identity key. The default `(col) => col` works for primitive
   * column types (e.g. `IssueStatus` strings). Object-shaped columns
   * (e.g. DX-586's `List`) MUST supply a key function so handler
   * memoization + hover state survive re-renders that produce new
   * column references but with the same logical identity.
   */
  keyOf?: (col: TCol) => string | number;
}

export interface UseCardDragReturn<TCol = IssueStatus> {
  /**
   * Bind drag-source handlers to a card. `sourceCol` (optional) lets
   * the caller pass the column the card currently belongs to so the
   * onDrop same-column check works for object-shaped column types
   * (e.g. DX-586's `List` — `issue.status` is not a `List` value, so
   * defaulting `fromCol` to `issue.status` breaks the equality check
   * `keyOf(fromCol) === keyOf(toCol)`). When omitted, falls back to
   * `issue.status as TCol` for legacy `IssueStatus`-typed callers.
   */
  bindCard: (issue: IssueListItem, sourceCol?: TCol) => CardDragHandlers;
  bindColumn: (col: TCol) => ColumnDragHandlers;
  bindSlot: (
    key: string,
    before: IssueListItem | null,
    after: IssueListItem | null,
  ) => SlotDragHandlers;
  dragging: Ref<DragState<TCol> | null>;
  hoverColumn: Ref<string | number | null>;
  hoverSlot: Ref<string | null>;
  isDragging: (issue: IssueListItem) => boolean;
  isHoveringColumn: (col: TCol) => boolean;
  isHoveringSlot: (key: string) => boolean;
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
export function useCardDrag<TCol = IssueStatus>(
  opts: UseCardDragOptions<TCol>,
): UseCardDragReturn<TCol> {
  const dragging = ref<DragState<TCol> | null>(null) as Ref<DragState<TCol> | null>;
  const hoverColumn = ref<string | number | null>(null);
  const hoverSlot = ref<string | null>(null);
  const keyOf = opts.keyOf ?? ((c: TCol) => c as unknown as string | number);
  // `bindColumn` is invoked once per column per render. Memoize the
  // handler trio per column-key so Vue's runtime can short-circuit
  // the listener-patch on re-renders (object identity matches → no
  // detach/reattach). The map is composable-scoped so per-board state
  // does not leak across instances. Keyed by `keyOf(col)` (default
  // identity) so object-shaped columns survive re-render churn.
  const columnHandlers = new Map<string | number, ColumnDragHandlers>();
  // `bindSlot` returns handlers keyed by the slot's logical id. The
  // neighbors (`before` / `after`) MAY change identity across renders
  // (the board re-derives them from the post-mutation list each tick),
  // so we DON'T memoize — each render rebuilds slots from scratch with
  // the closure capturing the current neighbor refs.

  function bindCard(issue: IssueListItem, sourceCol?: TCol): CardDragHandlers {
    return {
      onDragstart(e: DragEvent): void {
        // `fromCol` snapshot: caller-supplied `sourceCol` wins (DX-586
        // list-driven board passes the actual List object); legacy
        // callers fall back to `issue.status` so the IssueStatus-typed
        // same-col check `keyOf(fromCol) === keyOf(toCol)` continues
        // to work.
        const from = sourceCol ?? (issue.status as unknown as TCol);
        dragging.value = { issue, fromCol: from };
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

  function bindColumn(col: TCol): ColumnDragHandlers {
    const key = keyOf(col);
    const cached = columnHandlers.get(key);
    if (cached) return cached;
    const handlers: ColumnDragHandlers = {
      onDragover(e: DragEvent): void {
        if (!dragging.value) return;
        e.preventDefault();
        const dt = e.dataTransfer;
        if (dt) dt.dropEffect = "move";
        hoverColumn.value = key;
      },
      onDragleave(e: DragEvent): void {
        if (hoverColumn.value !== key) return;
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
        const { issue, fromCol } = drag;
        dragging.value = null;
        if (keyOf(fromCol) === key) return;
        const result = opts.onDrop(issue, fromCol, col);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            console.error(
              `[useCardDrag] onDrop rejected for ${issue.id} ${String(keyOf(fromCol))}→${String(key)}:`,
              err,
            );
          });
        }
      },
    };
    columnHandlers.set(key, handlers);
    return handlers;
  }

  function bindSlot(
    key: string,
    before: IssueListItem | null,
    after: IssueListItem | null,
  ): SlotDragHandlers {
    return {
      onDragover(e: DragEvent): void {
        if (!dragging.value) return;
        // Slot must intercept the column's own dragover so the slot
        // highlight wins over the column-wide outline.
        e.preventDefault();
        e.stopPropagation();
        const dt = e.dataTransfer;
        if (dt) dt.dropEffect = "move";
        hoverSlot.value = key;
        // Suppress the column-level outline while a specific slot is the
        // active target — column.drop-hover and slot.drop-hover are
        // mutually exclusive in the UX.
        hoverColumn.value = null;
      },
      onDragleave(e: DragEvent): void {
        if (hoverSlot.value !== key) return;
        const root = e.currentTarget as Node | null;
        const next = e.relatedTarget as Node | null;
        if (root && next && root.contains(next)) return;
        hoverSlot.value = null;
      },
      onDrop(e: DragEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const drag = dragging.value;
        hoverSlot.value = null;
        hoverColumn.value = null;
        if (!drag) return;
        const { issue } = drag;
        dragging.value = null;
        if (!opts.onReorder) return;
        // No-op when dropping into a slot adjacent to ourselves — the
        // card is already there, so a PATCH would just churn the
        // position field with no visible effect.
        if (before?.id === issue.id || after?.id === issue.id) return;
        const result = opts.onReorder(issue, before, after);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            console.error(
              `[useCardDrag] onReorder rejected for ${issue.id} between ${before?.id ?? "head"}/${after?.id ?? "tail"}:`,
              err,
            );
          });
        }
      },
    };
  }

  function isDragging(issue: IssueListItem): boolean {
    return dragging.value?.issue.id === issue.id;
  }

  function isHoveringColumn(col: TCol): boolean {
    return hoverColumn.value === keyOf(col);
  }

  function isHoveringSlot(key: string): boolean {
    return hoverSlot.value === key;
  }

  return {
    bindCard,
    bindColumn,
    bindSlot,
    dragging,
    hoverColumn,
    hoverSlot,
    isDragging,
    isHoveringColumn,
    isHoveringSlot,
  };
}
