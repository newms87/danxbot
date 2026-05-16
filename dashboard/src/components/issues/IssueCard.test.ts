import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import IssueCard from "./IssueCard.vue";
import type {
  IssueListChild,
  IssueListItem,
  IssueTriage,
  IssueTriageHistoryEntry,
  RequiresHuman,
} from "../../types";

// AgentBadge does an authed avatar fetch on mount; stub it out so the
// IssueCard's contract is the only thing under test here. AgentAvatarStack
// (DX-524) is stubbed for the same reason — its children fetch avatar URLs.
const stubs = {
  AgentBadge: true,
  AgentAvatarStack: true,
  IssueAgeBadge: true,
  TypeBadge: true,
  ACBar: true,
  ChildrenChecklist: true,
};

const NOW = Date.parse("2026-05-14T18:00:00Z");
function isoMinutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}
function isoDaysAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString();
}
function untriagedBlock(): IssueTriage {
  return {
    expires_at: "",
    reassess_hint: "",
    last_status: "",
    last_explain: "",
    ice: { total: 0, i: 0, c: 0, e: 0 },
    history: [],
  };
}
function triagedBlock(
  total: number,
  timestamp: string,
  extra: Partial<IssueTriageHistoryEntry> = {},
): IssueTriage {
  const i = Math.min(5, Math.max(1, Math.round(Math.cbrt(total) || 1)));
  const c = i;
  const e = Math.max(1, Math.ceil(total / Math.max(1, i * c)));
  return {
    expires_at: new Date(NOW + 24 * 3_600_000).toISOString(),
    reassess_hint: "",
    last_status: "Keep",
    last_explain: "ok",
    ice: { total, i, c, e },
    history: [
      {
        timestamp,
        status: "Keep",
        explain: "scored",
        expires_at: new Date(NOW + 24 * 3_600_000).toISOString(),
        ice: { total, i, c, e },
        ...extra,
      },
    ],
  };
}

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
    // Tooltip content is in a portal, not directly in the component HTML
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
    // Tooltip content is in a portal, not directly in the component HTML
    // The truncation logic is tested through the computed value (`requiresHumanTooltip`)
    const badge = w.find("[data-test='requires-human-badge']");
    expect(badge.exists()).toBe(true);
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
    // Tooltip content is in a portal, not directly in the component HTML
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
    // Tooltip content is in a portal, not directly in the component HTML
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

describe("IssueCard — dispatch gate pills (DX-309)", () => {
  it("renders no gate pills when every gate is empty", () => {
    const w = mountCard(makeListItem());
    expect(w.find("[data-test='blocked-pill']").exists()).toBe(false);
    expect(w.find("[data-test='waiting-on-pill']").exists()).toBe(false);
    expect(w.find("[data-test='conflict-pill']").exists()).toBe(false);
  });

  it("renders the BLOCKED pill (red) when issue.blocked != null", () => {
    const w = mountCard(
      makeListItem({
        status: "Blocked",
        blocked: { reason: "needs ops token", at: "2026-05-12T00:00:00Z" },
      }),
    );
    const pill = w.get("[data-test='blocked-pill']");
    expect(pill.text()).toContain("BLOCKED");
    // Tooltip content is in a portal, not directly in the component HTML
  });

  it("renders the WAITING ON N pill (amber) with unresolved dep count", () => {
    const w = mountCard(
      makeListItem({
        waiting_on: true,
        waiting_on_reason: "needs P1 schema",
        waiting_on_by: ["DX-5", "DX-7"],
      }),
    );
    const pill = w.get("[data-test='waiting-on-pill']");
    expect(pill.text()).toContain("WAITING ON 2");
    // Tooltip content is in a portal, not directly in the component HTML
  });

  it("renders the CONFLICT N pill (purple) when conflict_on_active_count > 0", () => {
    const w = mountCard(
      makeListItem({
        conflict_on: [{ id: "DX-9", reason: "same file" }],
        conflict_on_active_count: 1,
      }),
    );
    const pill = w.get("[data-test='conflict-pill']");
    expect(pill.text()).toContain("CONFLICT 1");
    // Tooltip content is in a portal, not directly in the component HTML
  });

  it("renders the CONFLICT N pill in audit-only mode when active_count = 0 but entries exist", () => {
    const w = mountCard(
      makeListItem({
        conflict_on: [{ id: "DX-9", reason: "historical" }],
        conflict_on_active_count: 0,
      }),
    );
    const pill = w.get("[data-test='conflict-pill']");
    expect(pill.text()).toContain("CONFLICT 1");
    expect(pill.classes()).toContain("gate-conflict-audit");
  });

  it("renders ALL three pills together when every gate is set", () => {
    const w = mountCard(
      makeListItem({
        status: "Blocked",
        blocked: { reason: "x", at: "2026-05-12T00:00:00Z" },
        waiting_on: true,
        waiting_on_reason: "y",
        waiting_on_by: ["DX-3"],
        conflict_on: [{ id: "DX-9", reason: "z" }],
        conflict_on_active_count: 1,
      }),
    );
    expect(w.find("[data-test='blocked-pill']").exists()).toBe(true);
    expect(w.find("[data-test='waiting-on-pill']").exists()).toBe(true);
    expect(w.find("[data-test='conflict-pill']").exists()).toBe(true);
  });
});

// DX-516 — triage ICE chip + relative timestamp on the card.
// The chip surfaces `triage.ice.total` with tier-driven color plus
// `triaged Nm` text from the most-recent history entry's timestamp.
// Untriaged cards render NOTHING — the chip is gated on
// `triage.history.length > 0`.
describe("IssueCard — triage chip (DX-516)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders NOTHING triage-related when the card is untriaged (history empty)", () => {
    const w = mountCard(
      makeListItem({ triage: untriagedBlock() }),
    );
    expect(w.find("[data-test='ice-badge']").exists()).toBe(false);
    expect(w.find("[data-test='triage-ago']").exists()).toBe(false);
  });

  it("renders NOTHING when the triage block is absent from the payload", () => {
    const w = mountCard(makeListItem({ triage: undefined }));
    expect(w.find("[data-test='ice-badge']").exists()).toBe(false);
    expect(w.find("[data-test='triage-ago']").exists()).toBe(false);
  });

  it("renders the high-tier (green) ICE pill + '5m' for a fresh triage scored 125", () => {
    const w = mountCard(
      makeListItem({ triage: triagedBlock(125, isoMinutesAgo(5)) }),
    );
    const badge = w.get("[data-test='ice-badge']");
    expect(badge.text()).toBe("ICE 125");
    expect(badge.classes()).toContain("ice-high");
    expect(w.get("[data-test='triage-ago']").text()).toBe("triaged 5m");
  });

  it("renders the low-tier (gray) ICE pill + '3d' for a stale triage scored 4", () => {
    const w = mountCard(
      makeListItem({ triage: triagedBlock(4, isoDaysAgo(3)) }),
    );
    const badge = w.get("[data-test='ice-badge']");
    expect(badge.text()).toBe("ICE 4");
    expect(badge.classes()).toContain("ice-low");
    expect(w.get("[data-test='triage-ago']").text()).toBe("triaged 3d");
  });

  it("renders the mid-tier (amber) ICE pill for totals in [20, 60)", () => {
    const w = mountCard(
      makeListItem({ triage: triagedBlock(36, isoMinutesAgo(10)) }),
    );
    const badge = w.get("[data-test='ice-badge']");
    expect(badge.classes()).toContain("ice-mid");
  });

  it("shows 'triaged now' when the most recent history entry is < 1m old", () => {
    const w = mountCard(
      makeListItem({ triage: triagedBlock(60, isoMinutesAgo(0)) }),
    );
    expect(w.get("[data-test='triage-ago']").text()).toBe("triaged now");
  });
});

// DX-522 — Priority icon on the card tile. The board's per-column
// sort is already priority-DESC (DX-521 backend), so the icon's job
// is glanceability — an operator scanning the column reads tier
// rank without parsing the numeric value the YAML carries.
describe("IssueCard — priority icon (DX-522)", () => {
  it("renders the priority icon on every card", () => {
    const w = mountCard(makeListItem({ priority: 3 }));
    expect(w.find("[data-test='priority-icon']").exists()).toBe(true);
  });

  it("reflects the card's priority tier — priority 4.2 lands in very_high", () => {
    const w = mountCard(makeListItem({ priority: 4.2 }));
    const icon = w.get("[data-test='priority-icon']");
    expect(icon.classes()).toContain("priority-very_high");
  });

  it("reflects the card's priority tier — priority 0.5 lands in lowest", () => {
    const w = mountCard(makeListItem({ priority: 0.5 }));
    const icon = w.get("[data-test='priority-icon']");
    expect(icon.classes()).toContain("priority-lowest");
  });

  it("uses size=sm on the board tile (compact rendering)", () => {
    const w = mountCard(makeListItem({ priority: 3 }));
    const icon = w.get("[data-test='priority-icon']");
    expect(icon.classes()).toContain("priority-size-sm");
  });
});

// DX-524 — child_assignments rollup rendered as an avatar stack on parent
// rows (cards with non-empty children that have non-terminal assigned
// children). Non-parent rows keep the existing single-AgentBadge path.
describe("IssueCard — child_assignments avatar stack (DX-524)", () => {
  it("renders AgentAvatarStack INSTEAD of AgentBadge when child_assignments is non-empty", () => {
    const w = mountCard(
      makeListItem({
        type: "Epic",
        assigned_agent: null,
        child_assignments: [
          { agent: "phil", issue_id: "DX-2", issue_title: "Phase A" },
          { agent: "sage", issue_id: "DX-3", issue_title: "Phase B" },
        ],
      }),
    );
    expect(w.findComponent({ name: "AgentAvatarStack" }).exists()).toBe(true);
    expect(w.findComponent({ name: "AgentBadge" }).exists()).toBe(false);
  });

  it("falls through to AgentBadge when child_assignments is empty AND assigned_agent is set", () => {
    const w = mountCard(
      makeListItem({
        type: "Feature",
        assigned_agent: "phil",
        child_assignments: [],
      }),
    );
    expect(w.findComponent({ name: "AgentBadge" }).exists()).toBe(true);
    expect(w.findComponent({ name: "AgentAvatarStack" }).exists()).toBe(false);
  });

  it("falls through to AgentBadge when child_assignments is undefined AND assigned_agent is set (back-compat)", () => {
    const w = mountCard(
      makeListItem({
        type: "Feature",
        assigned_agent: "phil",
        // child_assignments deliberately omitted — pre-DX-524 fixture shape
      }),
    );
    expect(w.findComponent({ name: "AgentBadge" }).exists()).toBe(true);
    expect(w.findComponent({ name: "AgentAvatarStack" }).exists()).toBe(false);
  });

  it("renders neither chip when child_assignments is empty AND assigned_agent is null", () => {
    const w = mountCard(
      makeListItem({
        type: "Epic",
        assigned_agent: null,
        child_assignments: [],
      }),
    );
    expect(w.findComponent({ name: "AgentAvatarStack" }).exists()).toBe(false);
    expect(w.findComponent({ name: "AgentBadge" }).exists()).toBe(false);
  });

  it("renders AgentAvatarStack on a non-Epic parent (any card with non-empty child_assignments)", () => {
    // Spec says parents = Epic OR any card with non-empty children[]. The
    // gate is on child_assignments shape, not type — defense-in-depth in
    // case the backend ever rolls up assignments on a non-epic sub-card
    // with phase-shaped children of its own.
    const w = mountCard(
      makeListItem({
        type: "Feature",
        assigned_agent: null,
        child_assignments: [
          { agent: "phil", issue_id: "DX-2", issue_title: "Sub" },
        ],
      }),
    );
    expect(w.findComponent({ name: "AgentAvatarStack" }).exists()).toBe(true);
    expect(w.findComponent({ name: "AgentBadge" }).exists()).toBe(false);
  });

  it("passes repo + assignments through to AgentAvatarStack", () => {
    const assignments = [
      { agent: "phil", issue_id: "DX-2", issue_title: "Phase A" },
      { agent: "sage", issue_id: "DX-3", issue_title: "Phase B" },
    ];
    const w = mountCard(
      makeListItem({
        type: "Epic",
        child_assignments: assignments,
      }),
    );
    const stack = w.findComponent({ name: "AgentAvatarStack" });
    expect(stack.props("repo")).toBe("danxbot");
    expect(stack.props("assignments")).toEqual(assignments);
  });
});
