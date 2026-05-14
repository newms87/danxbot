import { describe, it, expect } from "vitest";
import {
  PRIORITY_TIERS,
  priorityTier,
  type PriorityTierKey,
} from "./priority-tier.js";
import { PRIORITY_MIN, PRIORITY_MAX } from "./yaml.js";

describe("priorityTier — boundary mapping (DX-521)", () => {
  const cases: Array<[number, PriorityTierKey]> = [
    [0.01, "lowest"],
    [0.5, "lowest"],
    [0.99, "lowest"],
    [1.0, "low"],
    [1.5, "low"],
    [1.99, "low"],
    [2.0, "medium"],
    [2.5, "medium"],
    [2.99, "medium"],
    [3.0, "high"],
    [3.5, "high"],
    [3.99, "high"],
    [4.0, "very_high"],
    [4.5, "very_high"],
    [4.99, "very_high"],
    [5.0, "critical"],
    [5.5, "critical"],
    [5.99, "critical"],
  ];
  for (const [value, expected] of cases) {
    it(`maps ${value} → ${expected}`, () => {
      expect(priorityTier(value)).toBe(expected);
    });
  }
});

describe("priorityTier — out-of-clamp inputs classify deterministically", () => {
  // The JSDoc on `priorityTier()` promises that callers who haven't
  // clamped still get a deterministic answer (never throws, never
  // returns undefined). These cases pin that contract for inputs
  // outside `[PRIORITY_MIN, PRIORITY_MAX]`.
  const cases: Array<[number, PriorityTierKey]> = [
    [0, "lowest"],
    [-1, "lowest"],
    [-100, "lowest"],
    [6, "critical"],
    [10, "critical"],
    [Number.POSITIVE_INFINITY, "critical"],
  ];
  for (const [value, expected] of cases) {
    it(`classifies out-of-clamp ${value} → ${expected}`, () => {
      expect(priorityTier(value)).toBe(expected);
    });
  }
});

describe("PRIORITY_TIERS — shape invariants", () => {
  it("declares exactly six tiers in low → high order", () => {
    expect(PRIORITY_TIERS).toHaveLength(6);
    expect(PRIORITY_TIERS.map((t) => t.key)).toEqual([
      "lowest",
      "low",
      "medium",
      "high",
      "very_high",
      "critical",
    ]);
  });

  it("every tier carries a non-empty label", () => {
    for (const t of PRIORITY_TIERS) {
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it("defaultValue lies inside each tier's [min, max] range", () => {
    for (const t of PRIORITY_TIERS) {
      expect(t.defaultValue).toBeGreaterThanOrEqual(t.min);
      expect(t.defaultValue).toBeLessThanOrEqual(t.max);
    }
  });

  it("priorityTier(defaultValue) returns the tier's own key", () => {
    for (const t of PRIORITY_TIERS) {
      expect(priorityTier(t.defaultValue)).toBe(t.key);
    }
  });

  it("tier ranges cover (0, 6) without gaps", () => {
    for (let i = 0; i < PRIORITY_TIERS.length - 1; i++) {
      expect(PRIORITY_TIERS[i].max).toBe(PRIORITY_TIERS[i + 1].min);
    }
    expect(PRIORITY_TIERS[0].min).toBeGreaterThan(0);
    expect(PRIORITY_TIERS[PRIORITY_TIERS.length - 1].max).toBeLessThan(6);
  });

  it("tier endpoints lockstep with clampPriority bounds in yaml.ts", () => {
    expect(PRIORITY_TIERS[0].min).toBe(PRIORITY_MIN);
    expect(PRIORITY_TIERS[PRIORITY_TIERS.length - 1].max).toBe(PRIORITY_MAX);
  });
});
