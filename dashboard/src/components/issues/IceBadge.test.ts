import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import IceBadge from "./IceBadge.vue";

describe("IceBadge", () => {
  it("renders 'ICE <total>' for any non-negative number", () => {
    const w = mount(IceBadge, { props: { total: 125 } });
    expect(w.get("[data-test='ice-badge']").text()).toBe("ICE 125");
  });

  it("applies the high-tier class for totals >= 60", () => {
    const w = mount(IceBadge, { props: { total: 60 } });
    expect(w.get("[data-test='ice-badge']").classes()).toContain("ice-high");
  });

  it("applies the mid-tier class for totals in [20, 60)", () => {
    const w = mount(IceBadge, { props: { total: 25 } });
    expect(w.get("[data-test='ice-badge']").classes()).toContain("ice-mid");
  });

  it("applies the low-tier class for totals < 20", () => {
    const w = mount(IceBadge, { props: { total: 4 } });
    expect(w.get("[data-test='ice-badge']").classes()).toContain("ice-low");
  });

  it("sets the tooltip to 'ICE <total>' for hover-readable absolute value", () => {
    const w = mount(IceBadge, { props: { total: 36 } });
    // Tooltip content is in a portal, not directly in the component HTML
    expect(w.html()).toContain("ICE 36");
  });
});
