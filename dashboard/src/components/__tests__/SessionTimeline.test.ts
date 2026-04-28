import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import SessionTimeline from "../SessionTimeline.vue";
import type { JsonlBlock } from "../../types";

const blocks: JsonlBlock[] = [
  { type: "user", text: "hello", timestampMs: 1 },
  { type: "assistant_text", text: "hi back", timestampMs: 2 },
  { type: "thinking", text: "deep thoughts", timestampMs: 3 },
  {
    type: "tool_use",
    id: "toolu_1",
    name: "Read",
    input: { file_path: "/x" },
    timestampMs: 4,
  },
  {
    type: "tool_result",
    toolUseId: "toolu_1",
    content: "file contents",
    isError: false,
    timestampMs: 5,
  },
  { type: "system", subtype: "init", summary: "started", timestampMs: 6 },
  {
    type: "usage",
    usage: { tokensIn: 1, tokensOut: 2, cacheRead: 0, cacheWrite: 0 },
    timestampMs: 7,
  },
];

describe("SessionTimeline", () => {
  it("dispatches each of the 7 block types to the correct child component", () => {
    const w = mount(SessionTimeline, { props: { blocks } });
    const text = w.text();

    // user → UserBlock
    expect(text).toContain("User");
    expect(text).toContain("hello");

    // assistant_text → AssistantTextBlock
    expect(text).toContain("Assistant");
    expect(text).toContain("hi back");

    // thinking → ThinkingBlock
    expect(text).toContain("THINKING");
    expect(text).toContain("deep thoughts");

    // tool_use → ToolUseBlock
    expect(text).toContain("Read");
    expect(text).toContain("toolu_1");

    // tool_result → ToolResultBlock
    expect(text).toContain("TOOL RESULT");
    expect(text).toContain("file contents");

    // system → SystemBlock
    expect(text).toContain("[init]");
    expect(text).toContain("started");

    // usage → UsageLine ("usage:" prefix from the template)
    expect(text).toContain("usage:");
  });

  it("renders blocks in order", () => {
    const ordered: JsonlBlock[] = [
      { type: "user", text: "FIRST", timestampMs: 1 },
      { type: "assistant_text", text: "SECOND", timestampMs: 2 },
      { type: "user", text: "THIRD", timestampMs: 3 },
    ];
    const w = mount(SessionTimeline, { props: { blocks: ordered } });
    const text = w.text();
    const a = text.indexOf("FIRST");
    const b = text.indexOf("SECOND");
    const c = text.indexOf("THIRD");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("renders nothing for an empty blocks array", () => {
    const w = mount(SessionTimeline, { props: { blocks: [] } });
    expect(w.text()).toBe("");
  });
});
