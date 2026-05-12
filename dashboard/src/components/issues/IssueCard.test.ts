import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import IssueCard from "./IssueCard.vue";
import type {
  IssueListChild,
  IssueListItem,
  RequiresHuman,
} from "../../types";

// AgentBadge does an authed avatar fetch on mount; stub it out so the
// IssueCard's contract is the only thing under test here.
const stubs = {
  AgentBadge: true,
  IssueAgeBadge: true,
  TypeBadge: true,
  ACBar: true,
  ChildrenChecklist: true,
};

const baseChild: IssueListChild = {
  id: "DX-2",
  name: "phase 2",
  type: "Feature",
  status: "ToDo",
  waiting_on: false,
  waiting_on_by_card: false,
  requires_human: false,
  missing: false,
};

function makeListItem(overrides: Partial<IssueListItem> = {}): IssueListItem {
  return {
    id: "DX-1",
    type: "Feature",
    title: "Title",
    description: "",
    status: "ToDo",
    parent_id: null,
    children: [],
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
    priority: 3,
    position: null,
    assigned_agent: null,
    requires_human: null,
    requires_human_child_count: 0,
    ...overrides,
  };
}

function mountCard(issue: IssueListItem) {
  return mount(IssueCard, {
    props: { issue, repo: "danxbot" },
    global: { stubs },
  });
}

describe("IssueCard — requires_human indicators", () => {
  it("does NOT render the 👤 badge when requires_human is null", () => {
    const w = mountCard(makeListItem({ requires_human: null }));
    expect(w.find("[data-test='requires-human-badge']").exists()).toBe(false);
  });

  it("renders the 👤 badge when requires_human is set", () => {
    const r: RequiresHuman = {
      reason: "short reason",
      steps: [],
      set_by: "agent",
      set_at: "2026-05-10T16:50:00Z",
    };
    const w = mountCard(makeListItem({ requires_human: r }));
    const badge = w.get("[data-test='requires-human-badge']");
    expect(badge.text()).toContain("👤");
    expect(badge.attributes("title")).toBe("short reason");
  });

  it("truncates the tooltip at 80 chars on long reasons", () => {
    const longReason = "a".repeat(120);
    const r: RequiresHuman = {
      reason: longReason,
      steps: [],
      set_by: "agent",
      set_at: "2026-05-10T16:50:00Z",
    };
    const w = mountCard(makeListItem({ requires_human: r }));
    const title = w
      .get("[data-test='requires-human-badge']")
      .attributes("title")!;
    // Truncation keeps the first 77 chars + an ellipsis = 78 visible chars,
    // strictly under the 80-char tooltip ceiling spelled out in the AC.
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("does NOT render the children rollup chip when count = 0", () => {
    const w = mountCard(
      makeListItem({
        type: "Epic",
        children: ["DX-2"],
        children_detail: [{ ...baseChild, requires_human: false }],
        requires_human_child_count: 0,
      }),
    );
    expect(
      w.find("[data-test='requires-human-children-chip']").exists(),
    ).toBe(false);
  });

  // DX-267 — chip reads the backend-computed count (issue:updated SSE
  // carries the same number, so the chip stays live without inline
  // recomputation).
  it("renders '👤 N' children rollup chip from the backend count when Epic", () => {
    const w = mountCard(
      makeListItem({
        type: "Epic",
        children: ["DX-2", "DX-3", "DX-4"],
        children_detail: [
          { ...baseChild, id: "DX-2", requires_human: true },
          { ...baseChild, id: "DX-3", requires_human: true },
          { ...baseChild, id: "DX-4", requires_human: false },
        ],
        requires_human_child_count: 2,
      }),
    );
    const chip = w.get("[data-test='requires-human-children-chip']");
    expect(chip.text()).toBe("👤 2");
    expect(chip.attributes("title")).toBe("2 phases need human action");
  });

  it("uses singular 'phase needs' in the tooltip when count = 1", () => {
    const w = mountCard(
      makeListItem({
        type: "Epic",
        children: ["DX-2"],
        children_detail: [{ ...baseChild, requires_human: true }],
        requires_human_child_count: 1,
      }),
    );
    const chip = w.get("[data-test='requires-human-children-chip']");
    expect(chip.text()).toBe("👤 1");
    expect(chip.attributes("title")).toBe("1 phase needs human action");
  });

  // AC #2 — chip is Epic-only. Non-Epic parents with flagged children
  // do not surface the rollup (the data flows through the payload, the
  // SPA just gates the render).
  it("does NOT render the children rollup chip on non-Epic parents (count > 0 ignored)", () => {
    const w = mountCard(
      makeListItem({
        type: "Feature", // explicitly non-Epic
        children: ["DX-2"],
        children_detail: [{ ...baseChild, requires_human: true }],
        requires_human_child_count: 1,
      }),
    );
    expect(
      w.find("[data-test='requires-human-children-chip']").exists(),
    ).toBe(false);
  });

  // DX-267 live-update — when the backend recomputes
  // `requires_human_child_count` and the SSE pipeline pushes a fresh
  // IssueListItem into the prop, the chip re-renders within one tick.
  it("re-renders the chip count when the prop's requires_human_child_count updates", async () => {
    const w = mountCard(
      makeListItem({
        type: "Epic",
        children: ["DX-2", "DX-3"],
        children_detail: [
          { ...baseChild, id: "DX-2", requires_human: false },
          { ...baseChild, id: "DX-3", requires_human: false },
        ],
        requires_human_child_count: 0,
      }),
    );
    expect(
      w.find("[data-test='requires-human-children-chip']").exists(),
    ).toBe(false);

    await w.setProps({
      issue: makeListItem({
        type: "Epic",
        children: ["DX-2", "DX-3"],
        children_detail: [
          { ...baseChild, id: "DX-2", requires_human: true },
          { ...baseChild, id: "DX-3", requires_human: false },
        ],
        requires_human_child_count: 1,
      }),
    });

    const chip = w.get("[data-test='requires-human-children-chip']");
    expect(chip.text()).toBe("👤 1");
  });
});
