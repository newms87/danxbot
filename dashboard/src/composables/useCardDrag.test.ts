import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCardDrag } from "./useCardDrag";
import type { IssueListItem, IssueStatus } from "../types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function fakeIssue(
  id: string,
  status: IssueStatus = "ToDo",
): IssueListItem {
  return {
    id,
    title: `Card ${id}`,
    description: "",
    status,
    type: "Feature",
    priority: 3,
    assigned_agent: null,
    parent_id: null,
    children_detail: [],
    waiting_on: null,
    waiting_on_reason: null,
    waiting_on_by: [],
    blocked: null,
    requires_human: null,
    ac_done: 0,
    ac_total: 0,
    has_retro: false,
    comments_count: 0,
    created_at: 0,
    updated_at: 0,
  } as unknown as IssueListItem;
}

/**
 * Build a synthetic DragEvent. happy-dom's DragEvent constructor is
 * present but `dataTransfer` is not auto-populated from `init`, so we
 * stub it with the minimal subset the composable touches.
 */
interface FakeDataTransfer {
  effectAllowed: string;
  dropEffect: string;
  setData: ReturnType<typeof vi.fn>;
  setDragImage: ReturnType<typeof vi.fn>;
}

function makeDataTransfer(): FakeDataTransfer {
  return {
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn(),
    setDragImage: vi.fn(),
  };
}

function makeDragEvent(
  type: string,
  opts: {
    dataTransfer?: FakeDataTransfer;
    currentTarget?: HTMLElement;
    relatedTarget?: HTMLElement | null;
  } = {},
): DragEvent {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(ev, "dataTransfer", {
    value: opts.dataTransfer ?? makeDataTransfer(),
    configurable: true,
  });
  if (opts.currentTarget) {
    Object.defineProperty(ev, "currentTarget", {
      value: opts.currentTarget,
      configurable: true,
    });
  }
  if (opts.relatedTarget !== undefined) {
    Object.defineProperty(ev, "relatedTarget", {
      value: opts.relatedTarget,
      configurable: true,
    });
  }
  return ev;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useCardDrag — bindCard", () => {
  it("dragstart populates `dragging` ref with issue + fromCol (legacy IssueStatus default)", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const issue = fakeIssue("DX-1", "ToDo");
    const handlers = drag.bindCard(issue);
    const dt = makeDataTransfer();
    const root = document.createElement("div");
    document.body.appendChild(root);

    handlers.onDragstart(makeDragEvent("dragstart", { dataTransfer: dt, currentTarget: root }));

    expect(drag.dragging.value).not.toBeNull();
    expect(drag.dragging.value!.issue.id).toBe("DX-1");
    expect(drag.dragging.value!.fromCol).toBe("ToDo");
    expect(dt.effectAllowed).toBe("move");
    // setData required for Firefox compatibility.
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "DX-1");

    root.remove();
  });

  it("dragstart sets a custom drag image (clone of the card with rotation)", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const issue = fakeIssue("DX-2");
    const handlers = drag.bindCard(issue);
    const dt = makeDataTransfer();
    const root = document.createElement("div");
    root.style.width = "200px";
    document.body.appendChild(root);

    handlers.onDragstart(makeDragEvent("dragstart", { dataTransfer: dt, currentTarget: root }));

    expect(dt.setDragImage).toHaveBeenCalledOnce();
    const [clone] = dt.setDragImage.mock.calls[0] as [HTMLElement, number, number];
    expect(clone).toBeInstanceOf(HTMLElement);
    expect(clone.style.transform).toMatch(/rotate\(2deg\)/);
    expect(clone.style.transform).toMatch(/scale\(1\.02\)/);

    root.remove();
  });

  it("dragend clears `dragging` and `hoverColumn`", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const issue = fakeIssue("DX-3", "ToDo");
    const handlers = drag.bindCard(issue);
    handlers.onDragstart(makeDragEvent("dragstart"));
    drag.hoverColumn.value = "In Progress";

    handlers.onDragend(makeDragEvent("dragend"));

    expect(drag.dragging.value).toBeNull();
    expect(drag.hoverColumn.value).toBeNull();
  });

  it("isDragging(issue) reports true only for the active drag source", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const a = fakeIssue("DX-A");
    const b = fakeIssue("DX-B");
    const handlers = drag.bindCard(a);
    handlers.onDragstart(makeDragEvent("dragstart"));

    expect(drag.isDragging(a)).toBe(true);
    expect(drag.isDragging(b)).toBe(false);

    handlers.onDragend(makeDragEvent("dragend"));
    expect(drag.isDragging(a)).toBe(false);
  });
});

describe("useCardDrag — bindColumn", () => {
  it("dragover sets hoverColumn + preventsDefault when a drag is active", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const cardHandlers = drag.bindCard(fakeIssue("DX-1"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));

    const colHandlers = drag.bindColumn("In Progress");
    const dt = makeDataTransfer();
    const ev = makeDragEvent("dragover", { dataTransfer: dt });

    colHandlers.onDragover(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe("move");
    expect(drag.hoverColumn.value).toBe("In Progress");
  });

  it("dragover is a no-op when no drag is active (does not preventDefault)", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const colHandlers = drag.bindColumn("ToDo");
    const ev = makeDragEvent("dragover");

    colHandlers.onDragover(ev);

    expect(ev.defaultPrevented).toBe(false);
    expect(drag.hoverColumn.value).toBeNull();
  });

  it("dragleave clears hoverColumn only when leaving the column root entirely", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const cardHandlers = drag.bindCard(fakeIssue("DX-1"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));
    drag.hoverColumn.value = "Done";
    const colHandlers = drag.bindColumn("Done");

    const root = document.createElement("div");
    const child = document.createElement("div");
    root.appendChild(child);
    document.body.appendChild(root);

    // Crossing into a child element → currentTarget contains relatedTarget; do NOT clear.
    colHandlers.onDragleave(
      makeDragEvent("dragleave", { currentTarget: root, relatedTarget: child }),
    );
    expect(drag.hoverColumn.value).toBe("Done");

    // Leaving the column entirely → relatedTarget is outside the root; clear.
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    colHandlers.onDragleave(
      makeDragEvent("dragleave", { currentTarget: root, relatedTarget: outside }),
    );
    expect(drag.hoverColumn.value).toBeNull();

    root.remove();
    outside.remove();
  });

  it("drop calls onDrop with (issue, fromStatus, toStatus) and clears state", async () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const issue = fakeIssue("DX-7", "ToDo");
    const cardHandlers = drag.bindCard(issue);
    cardHandlers.onDragstart(makeDragEvent("dragstart"));

    const colHandlers = drag.bindColumn("In Progress");
    const dropEv = makeDragEvent("drop");

    colHandlers.onDrop(dropEv);

    expect(dropEv.defaultPrevented).toBe(true);
    expect(onDrop).toHaveBeenCalledWith(issue, "ToDo", "In Progress");
    expect(drag.dragging.value).toBeNull();
    expect(drag.hoverColumn.value).toBeNull();
  });

  it("drop on the same column is a no-op (onDrop NOT called)", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const cardHandlers = drag.bindCard(fakeIssue("DX-9", "ToDo"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));

    const colHandlers = drag.bindColumn("ToDo");
    colHandlers.onDrop(makeDragEvent("drop"));

    expect(onDrop).not.toHaveBeenCalled();
    expect(drag.dragging.value).toBeNull();
  });

  it("drop without a prior dragstart is a no-op (no onDrop, no throw)", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const colHandlers = drag.bindColumn("Done");
    expect(() => colHandlers.onDrop(makeDragEvent("drop"))).not.toThrow();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("isHoveringColumn reports the active hover target", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const cardHandlers = drag.bindCard(fakeIssue("DX-1"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));
    const colHandlers = drag.bindColumn("Blocked");
    colHandlers.onDragover(makeDragEvent("dragover"));

    expect(drag.isHoveringColumn("Blocked")).toBe(true);
    expect(drag.isHoveringColumn("Done")).toBe(false);
  });
});

describe("useCardDrag — Esc / abort semantics", () => {
  it("Esc cancellation: dragend fires without drop → no onDrop call", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const drag = useCardDrag({ onDrop });

    const cardHandlers = drag.bindCard(fakeIssue("DX-9"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));
    // Browser fires dragend with dropEffect="none" on Esc — drop never runs.
    cardHandlers.onDragend(makeDragEvent("dragend"));

    expect(onDrop).not.toHaveBeenCalled();
    expect(drag.dragging.value).toBeNull();
  });
});

describe("useCardDrag — synchronous onDrop (returns undefined) does not crash", () => {
  it("drop handler is safe when onDrop is sync", () => {
    const onDrop = vi.fn(() => undefined);
    const drag = useCardDrag({ onDrop });
    const cardHandlers = drag.bindCard(fakeIssue("DX-S"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));
    const colHandlers = drag.bindColumn("In Progress");
    expect(() => colHandlers.onDrop(makeDragEvent("drop"))).not.toThrow();
    expect(onDrop).toHaveBeenCalledOnce();
  });
});

describe("useCardDrag — bindColumn handler memoization", () => {
  it("repeated bindColumn(status) returns the SAME handler object (Vue patch optimization)", () => {
    const drag = useCardDrag({ onDrop: vi.fn() });
    const a = drag.bindColumn("ToDo");
    const b = drag.bindColumn("ToDo");
    expect(a).toBe(b);
    expect(a.onDragover).toBe(b.onDragover);
  });

  it("different statuses get distinct handler objects", () => {
    const drag = useCardDrag({ onDrop: vi.fn() });
    const todo = drag.bindColumn("ToDo");
    const inProgress = drag.bindColumn("In Progress");
    expect(todo).not.toBe(inProgress);
  });
});

describe("useCardDrag — onBeforeDragStart (DX-629)", () => {
  it("invokes the caller-supplied hook BEFORE dragging.value is set", () => {
    const onDrop = vi.fn().mockResolvedValue(undefined);
    const order: string[] = [];
    const drag = useCardDrag({
      onDrop,
      onBeforeDragStart: () => {
        // At the moment the hook fires, `dragging.value` must still be null —
        // the hook owns the "before the drag begins" window.
        order.push(drag.dragging.value === null ? "hook-pre" : "hook-post");
      },
    });

    const cardHandlers = drag.bindCard(fakeIssue("DX-H"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));

    expect(order).toEqual(["hook-pre"]);
    expect(drag.dragging.value).not.toBeNull();
  });

  it("hook is optional — omitting it does not throw on dragstart", () => {
    const drag = useCardDrag({ onDrop: vi.fn() });
    const cardHandlers = drag.bindCard(fakeIssue("DX-O"));
    expect(() => cardHandlers.onDragstart(makeDragEvent("dragstart"))).not.toThrow();
    expect(drag.dragging.value).not.toBeNull();
  });

  it("repeated dragstarts re-fire the hook (idempotent — caller must be safe)", () => {
    const hook = vi.fn();
    const drag = useCardDrag({ onDrop: vi.fn(), onBeforeDragStart: hook });

    const cardHandlers = drag.bindCard(fakeIssue("DX-R"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));
    cardHandlers.onDragend(makeDragEvent("dragend"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));

    expect(hook).toHaveBeenCalledTimes(2);
  });
});

describe("useCardDrag — failed onDrop is awaited", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("rejected onDrop logs an error (caller signals via the rejection)", async () => {
    const onDrop = vi.fn().mockRejectedValue(new Error("boom"));
    const drag = useCardDrag({ onDrop });

    const cardHandlers = drag.bindCard(fakeIssue("DX-X"));
    cardHandlers.onDragstart(makeDragEvent("dragstart"));
    const colHandlers = drag.bindColumn("Done");

    colHandlers.onDrop(makeDragEvent("drop"));

    // Wait one microtask cycle for the rejection to propagate.
    await Promise.resolve();
    await Promise.resolve();

    expect(onDrop).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalled();
  });
});
