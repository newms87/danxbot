import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PriorityIcon from "./PriorityIcon.vue";
import { PRIORITY_TIERS } from "../lib/priorityTier";

// One numeric sample per tier. We use each tier's `defaultValue`
// midpoint so the classifier lands inside the bucket the row claims —
// a future tier table edit that changes a midpoint without updating
// the table fails this test before it reaches a stale icon render.
const TIER_FIXTURES = [
  { key: "lowest", value: 0.5, label: "Lowest", color: "#94a3b8", glyph: "⏬" },
  { key: "low", value: 1.5, label: "Low", color: "#60a5fa", glyph: "▼" },
  { key: "medium", value: 2.5, label: "Medium", color: "#34d399", glyph: "─" },
  { key: "high", value: 3.5, label: "High", color: "#fbbf24", glyph: "▲" },
  {
    key: "very_high",
    value: 4.5,
    label: "Very High",
    color: "#f97316",
    glyph: "⏫",
  },
  { key: "critical", value: 5.5, label: "Critical", color: "#ef4444", glyph: "🔥" },
] as const;

describe("PriorityIcon — six tier classification", () => {
  for (const fix of TIER_FIXTURES) {
    it(`renders ${fix.key} tier for priority ${fix.value}`, () => {
      const w = mount(PriorityIcon, { props: { priority: fix.value } });
      const icon = w.get("[data-test='priority-icon']");
      expect(icon.text()).toBe(fix.glyph);
      expect(icon.classes()).toContain(`priority-${fix.key}`);
      const style = icon.attributes("style") ?? "";
      expect(style.toLowerCase()).toContain(fix.color.toLowerCase());
      expect(icon.attributes("title")).toBe(fix.label);
      expect(icon.attributes("aria-label")).toBe(`Priority: ${fix.label}`);
    });
  }

  // Fixture-driven coverage above relies on the midpoint values. Pin
  // the boundary values too so an off-by-one in priorityTier() (`<`
  // vs `<=`) fails here, not only on the dispatcher's sort.
  it("classifies boundary values consistently with PRIORITY_TIERS", () => {
    // Lower boundaries (inclusive on the higher tier).
    const expectations: Array<[number, string]> = [
      [0.99, "lowest"],
      [1.0, "low"],
      [1.99, "low"],
      [2.0, "medium"],
      [2.99, "medium"],
      [3.0, "high"],
      [3.99, "high"],
      [4.0, "very_high"],
      [4.99, "very_high"],
      [5.0, "critical"],
      [5.99, "critical"],
    ];
    for (const [value, expectedKey] of expectations) {
      const w = mount(PriorityIcon, { props: { priority: value } });
      const icon = w.get("[data-test='priority-icon']");
      expect(
        icon.classes(),
        `priority=${value} → expected ${expectedKey}`,
      ).toContain(`priority-${expectedKey}`);
    }
  });

  it("PRIORITY_TIERS still ships exactly six tiers (regression guard)", () => {
    expect(PRIORITY_TIERS).toHaveLength(6);
  });

  // The classifier's "trusts its input" contract — values outside the
  // clamp range (`<= 0`, negatives) still classify deterministically
  // as "lowest" instead of throwing or returning undefined. Caller is
  // responsible for clamping for display; this test guards against a
  // future "defensive" throw silently breaking the SPA's render path.
  it("classifies p=0 as lowest (un-clamped input contract)", () => {
    const w = mount(PriorityIcon, { props: { priority: 0 } });
    expect(w.get("[data-test='priority-icon']").classes()).toContain(
      "priority-lowest",
    );
  });

  it("classifies negative p as lowest (un-clamped input contract)", () => {
    const w = mount(PriorityIcon, { props: { priority: -3.2 } });
    expect(w.get("[data-test='priority-icon']").classes()).toContain(
      "priority-lowest",
    );
  });
});

describe("PriorityIcon — size variant", () => {
  it("defaults to size 'md' when prop omitted", () => {
    const w = mount(PriorityIcon, { props: { priority: 3 } });
    const icon = w.get("[data-test='priority-icon']");
    expect(icon.classes()).toContain("priority-size-md");
  });

  it("applies size 'sm' when prop set to 'sm'", () => {
    const w = mount(PriorityIcon, { props: { priority: 3, size: "sm" } });
    const icon = w.get("[data-test='priority-icon']");
    expect(icon.classes()).toContain("priority-size-sm");
  });
});
