import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import AgentAvatarStack from "./AgentAvatarStack.vue";
import type { IssueListChildAssignment } from "../../types";

/**
 * DX-524 — AgentAvatarStack SFC test.
 *
 * Stubs:
 *  - AgentAvatar — its real implementation does an authed avatar fetch
 *    (`fetchAgentAvatarUrl`) on mount which would hit the network in
 *    happy-dom. Replace with a tag carrying the props so we can assert
 *    forwarding without the network round-trip.
 *  - DanxTooltip — render both slots inline (`#trigger` + `#default`)
 *    so the tooltip body is in the DOM for assertions instead of behind
 *    a hover.
 */

const AgentAvatarStub = defineComponent({
  name: "AgentAvatar",
  props: {
    repo: { type: String, required: true },
    name: { type: String, required: true },
    avatarPath: { type: String, default: undefined },
    size: { type: Number, default: undefined },
  },
  setup: (props) =>
    () =>
      h("div", {
        class: "agent-avatar-stub",
        "data-stub-name": props.name,
        "data-stub-size": String(props.size ?? ""),
        "data-stub-repo": props.repo,
      }),
});

const DanxTooltipStub = defineComponent({
  name: "DanxTooltip",
  setup: (_, { slots }) =>
    () =>
      h("div", { class: "danx-tooltip-stub" }, [
        h("div", { class: "trigger-slot" }, slots.trigger?.() ?? []),
        h("div", { class: "default-slot" }, slots.default?.() ?? []),
      ]),
});

function mountStack(
  props: Partial<{
    repo: string;
    assignments: IssueListChildAssignment[];
    max: number;
  }> = {},
) {
  return mount(AgentAvatarStack, {
    props: {
      repo: "danxbot",
      assignments: [],
      ...props,
    },
    global: {
      stubs: {
        AgentAvatar: AgentAvatarStub,
        DanxTooltip: DanxTooltipStub,
      },
    },
  });
}

const FIVE_AGENTS: IssueListChildAssignment[] = [
  { agent: "buildy", issue_id: "DX-101", issue_title: "Phase 1" },
  { agent: "sage", issue_id: "DX-102", issue_title: "Phase 2" },
  { agent: "phil", issue_id: "DX-103", issue_title: "Phase 3" },
  { agent: "murphy", issue_id: "DX-104", issue_title: "Phase 4" },
  { agent: "dani", issue_id: "DX-105", issue_title: "Phase 5" },
];

describe("AgentAvatarStack", () => {
  it("renders 3 avatars + +2 chip when 5 distinct agents are passed", () => {
    const w = mountStack({ assignments: FIVE_AGENTS });
    const visibleAvatars = w
      .findAll(".trigger-slot .agent-avatar-stub")
      .map((n) => n.attributes("data-stub-name"));
    expect(visibleAvatars).toEqual(["buildy", "sage", "phil"]);
    const overflow = w.get("[data-test='stack-overflow-chip']");
    expect(overflow.text()).toBe("+2");
  });

  it("tooltip body contains every assignment with a per-card issue line", () => {
    const w = mountStack({ assignments: FIVE_AGENTS });
    const tooltip = w.get("[data-test='agent-avatar-stack-tooltip']");
    for (const entry of FIVE_AGENTS) {
      const row = tooltip.get(
        `[data-test='stack-tooltip-row-${entry.agent}-${entry.issue_id}']`,
      );
      expect(row.text()).toContain(entry.agent);
      expect(row.text()).toContain(`${entry.issue_id}: ${entry.issue_title}`);
    }
    // The tooltip is NEVER truncated by the avatar cap — all 5 rows present.
    expect(
      tooltip.findAll(".tooltip-row"),
    ).toHaveLength(FIVE_AGENTS.length);
  });

  it("does NOT render the overflow chip when distinct-agent count is exactly the cap", () => {
    const three = FIVE_AGENTS.slice(0, 3);
    const w = mountStack({ assignments: three });
    expect(w.find("[data-test='stack-overflow-chip']").exists()).toBe(false);
    const visible = w
      .findAll(".trigger-slot .agent-avatar-stub")
      .map((n) => n.attributes("data-stub-name"));
    expect(visible).toEqual(["buildy", "sage", "phil"]);
  });

  it("dedupes by agent for the avatar count but keeps every (agent, child) pair in the tooltip", () => {
    // Three entries but only two distinct agents — avatar row shows two,
    // tooltip shows three (one per assignment). Also locks the
    // distinct-vs-raw count contract for the overflow chip: if the cap
    // is ever flipped to read `assignments.length` instead of the
    // distinct count, the overflow chip would render incorrectly.
    const assignments: IssueListChildAssignment[] = [
      { agent: "phil", issue_id: "DX-1", issue_title: "Phase A" },
      { agent: "sage", issue_id: "DX-2", issue_title: "Phase B" },
      { agent: "phil", issue_id: "DX-3", issue_title: "Phase C" },
    ];
    const w = mountStack({ assignments });
    const visibleAvatars = w
      .findAll(".trigger-slot .agent-avatar-stub")
      .map((n) => n.attributes("data-stub-name"));
    expect(visibleAvatars).toEqual(["phil", "sage"]);
    expect(
      w.findAll("[data-test='agent-avatar-stack-tooltip'] .tooltip-row"),
    ).toHaveLength(3);
    // Two distinct agents ≤ default cap of 3 → no overflow chip. A
    // regression switching `overflowCount` from distinct → raw would
    // render `+1` here and fail this assertion.
    expect(w.find("[data-test='stack-overflow-chip']").exists()).toBe(false);
  });

  it("renders nothing visible but does not crash when assignments is empty", () => {
    const w = mountStack({ assignments: [] });
    expect(w.findAll(".trigger-slot .agent-avatar-stub")).toHaveLength(0);
    expect(w.find("[data-test='stack-overflow-chip']").exists()).toBe(false);
  });

  it("agent missing from settings.agents renders the raw name without throwing", () => {
    // The component does not consume a `settings.agents` map — it relies
    // on `AgentAvatar`'s initials fallback when no avatar_path is passed.
    // Asserting the raw name reaches the tooltip body is the contract.
    const assignments: IssueListChildAssignment[] = [
      { agent: "ghost-agent", issue_id: "DX-99", issue_title: "Lone phase" },
    ];
    const w = mountStack({ assignments });
    const row = w.get(
      "[data-test='stack-tooltip-row-ghost-agent-DX-99']",
    );
    expect(row.text()).toContain("ghost-agent");
    expect(row.text()).toContain("DX-99: Lone phase");
  });

  it("respects a custom `max` prop", () => {
    const w = mountStack({ assignments: FIVE_AGENTS, max: 2 });
    const visible = w
      .findAll(".trigger-slot .agent-avatar-stub")
      .map((n) => n.attributes("data-stub-name"));
    expect(visible).toEqual(["buildy", "sage"]);
    expect(w.get("[data-test='stack-overflow-chip']").text()).toBe("+3");
  });

  it("forwards repo + size to AgentAvatar for every visible slot", () => {
    const w = mountStack({
      repo: "platform",
      assignments: FIVE_AGENTS.slice(0, 2),
    });
    const stubs = w.findAll(".trigger-slot .agent-avatar-stub");
    expect(stubs).toHaveLength(2);
    for (const stub of stubs) {
      expect(stub.attributes("data-stub-size")).toBe("20");
      expect(stub.attributes("data-stub-repo")).toBe("platform");
    }
  });
});
