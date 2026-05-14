import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import AssistantTextBlock from "../blocks/AssistantTextBlock.vue";
import type { AssistantTextBlock as AssistantTextBlockType } from "../../types";

const block: AssistantTextBlockType = {
  type: "assistant_text",
  text: "Sure, here is the answer.",
  timestampMs: 1700000000000,
};

// AssistantTextBlock is rendered INSIDE the SessionTimeline turn
// wrapper, which owns the "Assistant · turn N" label + the violet
// left-rail. The inner block is therefore a plain text body — no
// duplicate header, no second rail.

describe("AssistantTextBlock", () => {
  it("renders block.text", () => {
    const w = mount(AssistantTextBlock, { props: { block } });
    expect(w.text()).toContain("Sure, here is the answer.");
  });

  it("does NOT emit its own `Assistant` header (turn wrapper owns it)", () => {
    const w = mount(AssistantTextBlock, { props: { block } });
    // The text body should not contain the label "Assistant" — that
    // label lives on the turn wrapper, not the inner text block.
    expect(w.text()).not.toMatch(/Assistant/);
  });

  it("does NOT carry its own violet left-rail (turn wrapper owns it)", () => {
    const w = mount(AssistantTextBlock, { props: { block } });
    expect(w.html()).not.toContain("border-violet-400/70");
  });
});
