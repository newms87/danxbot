import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import SystemBlock from "../blocks/SystemBlock.vue";
import type { SystemBlock as SystemBlockType } from "../../types";

const block: SystemBlockType = {
  type: "system",
  subtype: "init",
  summary: "session started",
  timestampMs: 1700000000000,
};

describe("SystemBlock", () => {
  it("renders [subtype] and the summary text", () => {
    const w = mount(SystemBlock, { props: { block } });
    const text = w.text();
    expect(text).toContain("[init]");
    expect(text).toContain("session started");
  });

  it("uses the muted system-specific styling", () => {
    const w = mount(SystemBlock, { props: { block } });
    const html = w.html();
    expect(html).toContain("text-slate-500");
    expect(html).toContain("font-mono");
  });
});
