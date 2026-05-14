import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import SessionTimeline from "../SessionTimeline.vue";
import type { JsonlBlock } from "../../types";

describe("SessionTimeline", () => {
  it("dispatches each block type to the correct child component", () => {
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
    const w = mount(SessionTimeline, { props: { blocks } });
    const text = w.text();
    expect(text).toContain("User");
    expect(text).toContain("hello");
    expect(text).toContain("Assistant · turn");
    expect(text).toContain("hi back");
    expect(text).toContain("THINKING");
    expect(text).toContain("deep thoughts");
    expect(text).toContain("Read");
    expect(text).toContain("toolu_1");
    expect(text).toContain("TOOL RESULT");
    expect(text).toContain("file contents");
    expect(text).toContain("[init]");
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

  it("groups consecutive assistant-related entries into one turn wrapper", () => {
    const blocks: JsonlBlock[] = [
      { type: "user", text: "ask", timestampMs: 1 },
      { type: "assistant_text", text: "think...", timestampMs: 2 },
      { type: "thinking", text: "internal", timestampMs: 3 },
      {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: {},
        timestampMs: 4,
      },
      {
        type: "tool_result",
        toolUseId: "t1",
        content: "ok",
        isError: false,
        timestampMs: 5,
      },
      {
        type: "usage",
        usage: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 },
        timestampMs: 6,
      },
      { type: "user", text: "ask2", timestampMs: 7 },
      { type: "assistant_text", text: "second turn", timestampMs: 8 },
    ];
    const w = mount(SessionTimeline, { props: { blocks } });
    const turnWrappers = w.findAll('[data-test="assistant-turn"]');
    expect(turnWrappers).toHaveLength(2);

    const labels = w
      .findAll('[data-test="assistant-turn-label"]')
      .map((n) => n.text());
    expect(labels[0]).toMatch(/Assistant · turn 1/);
    expect(labels[1]).toMatch(/Assistant · turn 2/);

    // First turn carries all the assistant-related entries.
    const firstTurnText = turnWrappers[0].text();
    expect(firstTurnText).toContain("think...");
    expect(firstTurnText).toContain("internal");
    expect(firstTurnText).toContain("Read");
    expect(firstTurnText).toContain("TOOL RESULT");
    expect(firstTurnText).toContain("usage:");

    // Second user message breaks the turn — its body is NOT inside the
    // first turn wrapper.
    expect(firstTurnText).not.toContain("ask2");
    expect(firstTurnText).not.toContain("second turn");
  });

  it("opens a turn on a leading `thinking` block even without a prior assistant_text", () => {
    const blocks: JsonlBlock[] = [
      { type: "thinking", text: "starting", timestampMs: 1 },
      { type: "assistant_text", text: "begin", timestampMs: 2 },
    ];
    const w = mount(SessionTimeline, { props: { blocks } });
    const turns = w.findAll('[data-test="assistant-turn"]');
    expect(turns).toHaveLength(1);
    expect(turns[0].text()).toContain("starting");
    expect(turns[0].text()).toContain("begin");
    expect(
      w.findAll('[data-test="assistant-turn-label"]')[0].text(),
    ).toMatch(/turn 1/);
  });

  it("opens a turn on a leading `tool_use` block (no assistant_text in turn)", () => {
    const blocks: JsonlBlock[] = [
      {
        type: "tool_use",
        id: "lonely_tool",
        name: "Bash",
        input: {},
        timestampMs: 1,
      },
    ];
    const w = mount(SessionTimeline, { props: { blocks } });
    const turns = w.findAll('[data-test="assistant-turn"]');
    expect(turns).toHaveLength(1);
    expect(turns[0].text()).toContain("Bash");
  });

  it("breaks turns on system entries", () => {
    const blocks: JsonlBlock[] = [
      { type: "assistant_text", text: "turn-a", timestampMs: 1 },
      { type: "system", subtype: "compact", summary: "x", timestampMs: 2 },
      { type: "assistant_text", text: "turn-b", timestampMs: 3 },
    ];
    const w = mount(SessionTimeline, { props: { blocks } });
    expect(w.findAll('[data-test="assistant-turn"]')).toHaveLength(2);
  });
});
