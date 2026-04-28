import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import ThinkingBlock from "../blocks/ThinkingBlock.vue";
import type { ThinkingBlock as ThinkingBlockType } from "../../types";

const block: ThinkingBlockType = {
  type: "thinking",
  text: "I should check the file first.",
  timestampMs: 1700000000000,
};

describe("ThinkingBlock", () => {
  it("renders the THINKING label", () => {
    const w = mount(ThinkingBlock, { props: { block } });
    expect(w.text()).toContain("THINKING");
  });

  it("renders block.text", () => {
    const w = mount(ThinkingBlock, { props: { block } });
    expect(w.text()).toContain("I should check the file first.");
  });

  it("uses the amber thinking-specific label color and dashed border", () => {
    const w = mount(ThinkingBlock, { props: { block } });
    const html = w.html();
    expect(html).toContain("text-amber-300");
    expect(html).toContain("border-dashed");
  });
});
