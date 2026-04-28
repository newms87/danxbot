import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import UserBlock from "../blocks/UserBlock.vue";
import type { UserBlock as UserBlockType } from "../../types";

const block: UserBlockType = {
  type: "user",
  text: "hello world\nsecond line",
  timestampMs: 1700000000000,
};

describe("UserBlock", () => {
  it("renders the User label", () => {
    const w = mount(UserBlock, { props: { block } });
    expect(w.text()).toContain("User");
  });

  it("renders block.text verbatim, preserving newlines via whitespace-pre-wrap", () => {
    const w = mount(UserBlock, { props: { block } });
    expect(w.text()).toContain("hello world");
    expect(w.text()).toContain("second line");
    expect(w.html()).toContain("whitespace-pre-wrap");
  });

  it("uses the blue type-specific rail color and label color", () => {
    const w = mount(UserBlock, { props: { block } });
    const html = w.html();
    expect(html).toContain("border-blue-400/70");
    expect(html).toContain("text-blue-300");
  });
});
