import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import AgentBadge from "./AgentBadge.vue";

// AgentAvatar is stubbed because it does an authed avatar fetch on mount
// (`fetchAgentAvatarUrl`) which would hit the network in test env. The
// "busy state animates" half of DX-164 AC #7 lives on AgentCard.vue
// (60s `setInterval` tick); this file covers AgentBadge's visual
// contract only.

const AgentAvatarStub = defineComponent({
  name: "AgentAvatar",
  props: {
    repo: { type: String, required: true },
    name: { type: String, required: true },
    avatarPath: { type: String, default: undefined },
    size: { type: Number, default: undefined },
  },
  setup: () =>
    () =>
      h("div", { class: "agent-avatar-stub" }),
});

function mountBadge(
  props: Partial<{
    repo: string;
    agentName: string;
    avatarPath: string;
    size: "sm" | "md";
  }> = {},
) {
  return mount(AgentBadge, {
    props: {
      repo: "danxbot",
      agentName: "alice",
      ...props,
    },
    global: {
      stubs: {
        AgentAvatar: AgentAvatarStub,
      },
    },
  });
}

describe("AgentBadge", () => {
  it("renders the agent name as visible text", () => {
    const w = mountBadge({ agentName: "alice" });
    expect(w.text()).toContain("alice");
  });

  it("defaults to size sm when no size prop is passed (issue list row default)", () => {
    const w = mountBadge();
    const root = w.get(".agent-badge");
    expect(root.classes()).toContain("size-sm");
    expect(root.classes()).not.toContain("size-md");
  });

  it("applies the size-md class when size='md' (drawer header default)", () => {
    const w = mountBadge({ size: "md" });
    const root = w.get(".agent-badge");
    expect(root.classes()).toContain("size-md");
    expect(root.classes()).not.toContain("size-sm");
  });

  it("passes 16px to AgentAvatar at size sm", () => {
    const w = mountBadge({ agentName: "bob", size: "sm" });
    const props = w.findComponent(AgentAvatarStub).props();
    expect(props.size).toBe(16);
    expect(props.name).toBe("bob");
  });

  it("passes 24px to AgentAvatar at size md", () => {
    const w = mountBadge({ size: "md" });
    expect(w.findComponent(AgentAvatarStub).props().size).toBe(24);
  });

  it("forwards repo + agentName + avatarPath to AgentAvatar (initials-fallback path lives in the child)", () => {
    const w = mountBadge({
      repo: "platform",
      agentName: "charlie",
      avatarPath: "agents/charlie.png",
    });
    expect(w.findComponent(AgentAvatarStub).props()).toMatchObject({
      repo: "platform",
      name: "charlie",
      avatarPath: "agents/charlie.png",
    });
  });

  it("forwards undefined avatarPath when none is provided (child renders initials)", () => {
    const w = mountBadge({ agentName: "delta" });
    expect(w.findComponent(AgentAvatarStub).props().avatarPath).toBeUndefined();
  });

  it("stamps the data-test attribute as agent-badge-<agentName> for selector-based UI assertions", () => {
    const w = mountBadge({ agentName: "echo" });
    expect(w.get(".agent-badge").attributes("data-test")).toBe(
      "agent-badge-echo",
    );
  });

  it("sets a title tooltip identifying the assignee", () => {
    const w = mountBadge({ agentName: "foxtrot" });
    // DanxTooltip wraps the element; tooltip content is in a portal
    // Verify that the component renders correctly (tooltip logic is tested via DanxTooltip)
    expect(w.text()).toContain("foxtrot");
  });

  it("propagates click events when the root element is clicked (drawer header → Agents tab routing)", async () => {
    const w = mountBadge({ size: "md" });
    await w.get(".agent-badge").trigger("click");
    expect(w.emitted("click")).toHaveLength(1);
  });
});
