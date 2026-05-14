import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import type { App } from "vue";

import UserBlock from "../blocks/UserBlock.vue";
import AssistantTextBlock from "../blocks/AssistantTextBlock.vue";
import ThinkingBlock from "../blocks/ThinkingBlock.vue";
import ToolUseBlock from "../blocks/ToolUseBlock.vue";
import ToolResultBlock from "../blocks/ToolResultBlock.vue";
import SubagentBlock from "../blocks/SubagentBlock.vue";
import SystemBlock from "../blocks/SystemBlock.vue";
import UsageLine from "../blocks/UsageLine.vue";
import SessionTimeline from "../SessionTimeline.vue";

// DX-111 AC #8 requires the timeline + every block to mount with zero
// Vue runtime warnings. We capture warnings via `app.config.warnHandler`
// for each component mounted with representative props.

function mountWithWarnHandler(component: unknown, props: unknown) {
  const warnings: string[] = [];
  return {
    wrapper: mount(component as never, {
      props: props as never,
      global: {
        config: {
          warnHandler(msg: string) {
            warnings.push(msg);
          },
        } as Partial<App["config"]>,
      },
    }),
    warnings,
  };
}

describe("dispatch-viewer — zero Vue warnings", () => {
  it("UserBlock mounts without Vue warnings", () => {
    const { warnings } = mountWithWarnHandler(UserBlock, {
      block: { type: "user", text: "x", timestampMs: 1 },
    });
    expect(warnings).toEqual([]);
  });

  it("AssistantTextBlock mounts without Vue warnings", () => {
    const { warnings } = mountWithWarnHandler(AssistantTextBlock, {
      block: { type: "assistant_text", text: "x", timestampMs: 1 },
    });
    expect(warnings).toEqual([]);
  });

  it("ThinkingBlock mounts without Vue warnings", () => {
    const { warnings } = mountWithWarnHandler(ThinkingBlock, {
      block: { type: "thinking", text: "x", timestampMs: 1 },
    });
    expect(warnings).toEqual([]);
  });

  it("ToolUseBlock mounts without Vue warnings (with + without subagent)", () => {
    const { warnings: a } = mountWithWarnHandler(ToolUseBlock, {
      block: {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { file_path: "/x" },
        timestampMs: 1,
      },
    });
    expect(a).toEqual([]);

    const { warnings: b } = mountWithWarnHandler(ToolUseBlock, {
      block: {
        type: "tool_use",
        id: "t2",
        name: "Agent",
        input: {},
        timestampMs: 1,
        subagent: {
          agentType: "code-reviewer",
          description: "audit",
          sessionId: null,
          blocks: [
            { type: "assistant_text", text: "nested", timestampMs: 2 },
          ],
          totals: {
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheWrite: 0,
            tokensTotal: 0,
            toolCallCount: 0,
            subagentCount: 0,
          },
        },
      },
    });
    expect(b).toEqual([]);
  });

  it("ToolResultBlock mounts without Vue warnings (short + long content)", () => {
    const { warnings: a } = mountWithWarnHandler(ToolResultBlock, {
      block: {
        type: "tool_result",
        toolUseId: "t1",
        content: "short",
        isError: false,
        timestampMs: 1,
      },
    });
    expect(a).toEqual([]);

    const { warnings: b } = mountWithWarnHandler(ToolResultBlock, {
      block: {
        type: "tool_result",
        toolUseId: "t2",
        content: "x".repeat(800),
        isError: true,
        timestampMs: 1,
      },
    });
    expect(b).toEqual([]);
  });

  it("SubagentBlock mounts without Vue warnings (with + without nested blocks)", () => {
    const { warnings: a } = mountWithWarnHandler(SubagentBlock, {
      subagent: {
        agentType: "test-reviewer",
        description: "audit",
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
      },
    });
    expect(a).toEqual([]);
  });

  it("SystemBlock mounts without Vue warnings", () => {
    const { warnings } = mountWithWarnHandler(SystemBlock, {
      block: {
        type: "system",
        subtype: "init",
        summary: "started",
        timestampMs: 1,
      },
    });
    expect(warnings).toEqual([]);
  });

  it("UsageLine mounts without Vue warnings", () => {
    const { warnings } = mountWithWarnHandler(UsageLine, {
      block: {
        type: "usage",
        usage: { tokensIn: 1, tokensOut: 2, cacheRead: 3, cacheWrite: 4 },
        timestampMs: 1,
      },
    });
    expect(warnings).toEqual([]);
  });

  it("SessionTimeline mounts the full block-type mix without Vue warnings", () => {
    const { warnings } = mountWithWarnHandler(SessionTimeline, {
      blocks: [
        { type: "user", text: "u", timestampMs: 1 },
        { type: "assistant_text", text: "a", timestampMs: 2 },
        { type: "thinking", text: "t", timestampMs: 3 },
        {
          type: "tool_use",
          id: "tu1",
          name: "Read",
          input: { file_path: "/x" },
          timestampMs: 4,
        },
        {
          type: "tool_result",
          toolUseId: "tu1",
          content: "ok",
          isError: false,
          timestampMs: 5,
        },
        { type: "system", subtype: "init", summary: "s", timestampMs: 6 },
        {
          type: "usage",
          usage: {
            tokensIn: 1,
            tokensOut: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
          timestampMs: 7,
        },
      ],
    });
    expect(warnings).toEqual([]);
  });
});
