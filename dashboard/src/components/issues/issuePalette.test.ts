import { describe, it, expect } from "vitest";
import { projectChildStatus, CHILD_STATUS_META } from "./issuePalette";

describe("projectChildStatus", () => {
  it("Done → 'done'", () => {
    expect(projectChildStatus("Done", false)).toBe("done");
  });

  it("Cancelled → 'done' (terminal-from-parent's-perspective)", () => {
    expect(projectChildStatus("Cancelled", false)).toBe("done");
  });

  it("Done overrides blocked record", () => {
    expect(projectChildStatus("Done", true)).toBe("done");
  });

  it("Cancelled overrides blocked record", () => {
    expect(projectChildStatus("Cancelled", true)).toBe("done");
  });

  it("Needs Help → 'blocked'", () => {
    expect(projectChildStatus("Blocked", false)).toBe("blocked");
  });

  it("Needs Approval → 'blocked'", () => {
    expect(projectChildStatus("Needs Approval", false)).toBe("blocked");
  });

  it("non-null blocked record on a non-terminal status → 'blocked'", () => {
    expect(projectChildStatus("ToDo", true)).toBe("blocked");
    expect(projectChildStatus("In Progress", true)).toBe("blocked");
    expect(projectChildStatus("Review", true)).toBe("blocked");
  });

  it("Review / ToDo / In Progress (no blocked record) → 'todo'", () => {
    expect(projectChildStatus("Review", false)).toBe("todo");
    expect(projectChildStatus("ToDo", false)).toBe("todo");
    expect(projectChildStatus("In Progress", false)).toBe("todo");
  });
});

describe("CHILD_STATUS_META", () => {
  it("has an entry for every ChildStatusId the projection emits", () => {
    expect(CHILD_STATUS_META.done).toBeDefined();
    expect(CHILD_STATUS_META.todo).toBeDefined();
    expect(CHILD_STATUS_META.blocked).toBeDefined();
  });
});
