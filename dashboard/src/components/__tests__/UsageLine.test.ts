import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import UsageLine from "../blocks/UsageLine.vue";
import type { UsageBlock } from "../../types";

const block: UsageBlock = {
  type: "usage",
  usage: {
    tokensIn: 1234,
    tokensOut: 567,
    cacheRead: 8901,
    cacheWrite: 23,
  },
  timestampMs: 1700000000000,
};

describe("UsageLine", () => {
  it("computes total = tokensIn + tokensOut + cacheRead + cacheWrite", () => {
    const w = mount(UsageLine, { props: { block } });
    // 1234 + 567 + 8901 + 23 = 10725
    expect(w.text()).toContain("10,725");
  });

  it("renders each component formatted with locale separators", () => {
    const w = mount(UsageLine, { props: { block } });
    const text = w.text();
    expect(text).toContain("1,234");
    expect(text).toContain("567");
    expect(text).toContain("8,901");
    // cache r/w pair "8,901/23"
    expect(text).toContain("8,901/23");
  });

  it("renders zero totals without throwing", () => {
    const zero: UsageBlock = {
      type: "usage",
      usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
      timestampMs: 1700000000000,
    };
    const w = mount(UsageLine, { props: { block: zero } });
    expect(w.text()).toContain("total 0");
  });
});
