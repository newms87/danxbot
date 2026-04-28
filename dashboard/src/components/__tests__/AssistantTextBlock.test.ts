import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import AssistantTextBlock from "../blocks/AssistantTextBlock.vue";
import type { AssistantTextBlock as AssistantTextBlockType } from "../../types";

const block: AssistantTextBlockType = {
  type: "assistant_text",
  text: "Sure, here is the answer.",
  timestampMs: 1700000000000,
};

describe("AssistantTextBlock", () => {
  it("renders the Assistant label", () => {
    const w = mount(AssistantTextBlock, { props: { block } });
    expect(w.text()).toContain("Assistant");
  });

  it("renders block.text", () => {
    const w = mount(AssistantTextBlock, { props: { block } });
    expect(w.text()).toContain("Sure, here is the answer.");
  });

  it("uses the violet type-specific rail color and label color", () => {
    const w = mount(AssistantTextBlock, { props: { block } });
    const html = w.html();
    expect(html).toContain("border-violet-400/70");
    expect(html).toContain("text-violet-300");
  });
});
