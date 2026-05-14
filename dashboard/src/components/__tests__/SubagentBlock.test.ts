import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import SubagentBlock from "../blocks/SubagentBlock.vue";
import type { SubagentTimeline } from "../../types";

function makeSubagent(
  overrides: Partial<SubagentTimeline> = {},
): SubagentTimeline {
  return {
    agentType: "code-reviewer",
    description: "audit quality",
    sessionId: null,
    blocks: [],
    totals: {
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokensTotal: 0,
      toolCallCount: 0,
      subagentCount: 0,
    },
    ...overrides,
  };
}

describe("SubagentBlock", () => {
  it("renders the SUB-AGENT label, agent type, and description", () => {
    const w = mount(SubagentBlock, {
      props: { subagent: makeSubagent() },
    });
    expect(w.text()).toContain("SUB-AGENT");
    expect(w.text()).toContain("code-reviewer");
    expect(w.text()).toContain("audit quality");
  });

  it("carries the pink left-rail styling per mockup", () => {
    const w = mount(SubagentBlock, {
      props: { subagent: makeSubagent() },
    });
    expect(w.html()).toContain("border-pink-400");
    expect(w.html()).toContain("border-l-[3px]");
  });

  it("recursively renders the sub-agent's blocks via SessionTimeline", () => {
    const w = mount(SubagentBlock, {
      props: {
        subagent: makeSubagent({
          blocks: [
            { type: "user", text: "nested-prompt", timestampMs: 1 },
            { type: "assistant_text", text: "nested-reply", timestampMs: 2 },
          ],
        }),
      },
    });
    expect(w.text()).toContain("nested-prompt");
    expect(w.text()).toContain("nested-reply");
    // The nested timeline produces a turn wrapper for the assistant_text.
    expect(w.findAll('[data-test="assistant-turn"]').length).toBe(1);
  });

  it("renders header but no nested turn wrappers when blocks: [] (recursive base case)", () => {
    const w = mount(SubagentBlock, {
      props: { subagent: makeSubagent({ blocks: [] }) },
    });
    expect(w.text()).toContain("SUB-AGENT");
    expect(w.findAll('[data-test="assistant-turn"]')).toHaveLength(0);
  });

  it("omits the em-dash description segment when description is empty", () => {
    const w = mount(SubagentBlock, {
      props: { subagent: makeSubagent({ description: "" }) },
    });
    expect(w.text()).toContain("code-reviewer");
    expect(w.text()).not.toContain("—");
  });
});
