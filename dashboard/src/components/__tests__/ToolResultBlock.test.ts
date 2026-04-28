import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import ToolResultBlock from "../blocks/ToolResultBlock.vue";
import type { ToolResultBlock as ToolResultBlockType } from "../../types";

function makeBlock(
  overrides: Partial<ToolResultBlockType> = {},
): ToolResultBlockType {
  return {
    type: "tool_result",
    toolUseId: "toolu_01abc",
    content: "ok",
    isError: false,
    timestampMs: 1700000000000,
    ...overrides,
  };
}

describe("ToolResultBlock", () => {
  it("renders TOOL RESULT label and content when not an error", () => {
    const w = mount(ToolResultBlock, {
      props: { block: makeBlock({ content: "stdout output" }) },
    });
    expect(w.text()).toContain("TOOL RESULT");
    expect(w.text()).toContain("stdout output");
    expect(w.html()).toContain("toolu_01abc");
  });

  it("renders TOOL ERROR label and red styling when isError=true", () => {
    const w = mount(ToolResultBlock, {
      props: { block: makeBlock({ isError: true, content: "boom" }) },
    });
    expect(w.text()).toContain("TOOL ERROR");
    const html = w.html();
    expect(html).toContain("border-red-500/30");
    expect(html).toContain("text-red-200");
  });

  it("uses emerald styling when isError=false", () => {
    const w = mount(ToolResultBlock, { props: { block: makeBlock() } });
    const html = w.html();
    expect(html).toContain("border-emerald-500/25");
    expect(html).toContain("text-emerald-200");
  });

  it("does not show the expand button when content is at or below 500 chars", () => {
    const w = mount(ToolResultBlock, {
      props: { block: makeBlock({ content: "x".repeat(500) }) },
    });
    expect(w.find("button").exists()).toBe(false);
    // No clamp class applied either
    expect(w.html()).not.toContain("max-h-48");
  });

  it("collapses content above 500 chars behind an expand button", () => {
    const long = "x".repeat(501);
    const w = mount(ToolResultBlock, {
      props: { block: makeBlock({ content: long }) },
    });
    // Initially clamped
    expect(w.html()).toContain("max-h-48");
    const button = w.find("button");
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain("Expand full output");
  });

  it("toggles the expand button label and clamp class when clicked", async () => {
    const long = "y".repeat(1000);
    const w = mount(ToolResultBlock, {
      props: { block: makeBlock({ content: long }) },
    });

    expect(w.html()).toContain("max-h-48");
    expect(w.find("button").text()).toContain("Expand full output");

    await w.find("button").trigger("click");
    expect(w.find("button").text()).toContain("Collapse");
    expect(w.html()).not.toContain("max-h-48");

    await w.find("button").trigger("click");
    expect(w.find("button").text()).toContain("Expand full output");
    expect(w.html()).toContain("max-h-48");
  });
});
