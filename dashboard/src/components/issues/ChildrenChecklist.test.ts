import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ChildrenChecklist from "./ChildrenChecklist.vue";
import type { IssueListChild } from "../../types";

function child(overrides: Partial<IssueListChild>): IssueListChild {
  return {
    id: "DX-1",
    name: "name",
    type: "Feature",
    status: "ToDo",
    waiting_on: false,
    waiting_on_by_card: false,
    requires_human: false,
    missing: false,
    ...overrides,
  };
}

describe("ChildrenChecklist — requires_human row indicator", () => {
  it("does NOT render the 👤 glyph for children without requires_human", () => {
    const w = mount(ChildrenChecklist, {
      props: {
        items: [
          child({ id: "DX-2", requires_human: false }),
          child({ id: "DX-3", requires_human: false }),
        ],
      },
    });
    expect(w.findAll("[data-test='children-checklist-rh']")).toHaveLength(0);
  });

  it("renders the 👤 glyph next to children with requires_human", () => {
    const w = mount(ChildrenChecklist, {
      props: {
        items: [
          child({ id: "DX-2", requires_human: true }),
          child({ id: "DX-3", requires_human: false }),
          child({ id: "DX-4", requires_human: true }),
        ],
      },
    });
    const rhs = w.findAll("[data-test='children-checklist-rh']");
    expect(rhs).toHaveLength(2);
    expect(rhs[0].text()).toBe("👤");
  });
});
