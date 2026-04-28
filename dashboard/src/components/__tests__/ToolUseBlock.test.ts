import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import ToolUseBlock from "../blocks/ToolUseBlock.vue";
import type { ToolUseBlock as ToolUseBlockType } from "../../types";

function makeBlock(
  overrides: Partial<ToolUseBlockType> = {},
): ToolUseBlockType {
  return {
    type: "tool_use",
    id: "toolu_01abc",
    name: "Read",
    input: { file_path: "/tmp/foo.txt" },
    timestampMs: 1700000000000,
    ...overrides,
  };
}

describe("ToolUseBlock", () => {
  it("renders the tool name and id", () => {
    const w = mount(ToolUseBlock, { props: { block: makeBlock() } });
    expect(w.text()).toContain("Read");
    expect(w.text()).toContain("toolu_01abc");
  });

  it("pretty-prints block.input as 2-space indented JSON", () => {
    const w = mount(ToolUseBlock, {
      props: {
        block: makeBlock({
          input: { file_path: "/tmp/foo.txt", limit: 50 },
        }),
      },
    });
    const text = w.text();
    expect(text).toContain('"file_path": "/tmp/foo.txt"');
    expect(text).toContain('"limit": 50');
  });

  it("does NOT render a nested SessionTimeline when block.subagent is absent", () => {
    const w = mount(ToolUseBlock, { props: { block: makeBlock() } });
    expect(w.text()).not.toContain("sub-agent");
    // The pink rail color is only applied for subagent blocks
    expect(w.html()).not.toContain("border-pink-400");
  });

  it("renders a nested SessionTimeline when block.subagent is present", () => {
    const block = makeBlock({
      name: "Agent",
      subagent: {
        agentType: "test-reviewer",
        description: "Audit coverage",
        sessionId: "sess-123",
        blocks: [
          {
            type: "assistant_text",
            text: "child assistant text",
            timestampMs: 1700000000001,
          },
          {
            type: "system",
            subtype: "init",
            summary: "child system",
            timestampMs: 1700000000002,
          },
        ],
        totals: {
          tokensIn: 10,
          tokensOut: 5,
          cacheRead: 0,
          cacheWrite: 0,
          tokensTotal: 15,
          toolCallCount: 0,
          subagentCount: 0,
        },
      },
    });

    const w = mount(ToolUseBlock, { props: { block } });
    const text = w.text();

    // Sub-agent header
    expect(text).toContain("test-reviewer");
    expect(text).toContain("sub-agent");
    expect(text).toContain("Audit coverage");

    // Nested timeline rendered the children
    expect(text).toContain("child assistant text");
    expect(text).toContain("child system");

    // Pink rail color is the subagent indicator
    expect(w.html()).toContain("border-pink-400");
  });
});
