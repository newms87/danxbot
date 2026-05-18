import { describe, it, expect } from "vitest";
import { nextPriority } from "./cardPriority";

describe("cardPriority.nextPriority — branch coverage (DX-629)", () => {
  it("both null → empty-column default (3.5, mid-tier 'high')", () => {
    expect(nextPriority(null, null)).toBe(3.5);
  });

  describe("top of column (before=null, after=N)", () => {
    it("after=3.5 → floor(3.5) + 0.5/2 = 3.25", () => {
      expect(nextPriority(null, 3.5)).toBe(3.25);
    });

    it("after=4.8 → floor(4.8) + 0.8/2 = 4.4", () => {
      expect(nextPriority(null, 4.8)).toBeCloseTo(4.4, 10);
    });

    it("after at integer boundary (5.0) → 5.0 + 0/2 = 5.0", () => {
      expect(nextPriority(null, 5.0)).toBe(5.0);
    });
  });

  describe("bottom of column (before=N, after=null)", () => {
    it("before=3.5 → floor(3.5) + (0.5+1)/2 = 3.75", () => {
      expect(nextPriority(3.5, null)).toBe(3.75);
    });

    it("before=4.2 → floor(4.2) + (0.2+1)/2 = 4.6", () => {
      expect(nextPriority(4.2, null)).toBeCloseTo(4.6, 10);
    });

    it("before at integer boundary (3.0) → 3 + (0+1)/2 = 3.5", () => {
      expect(nextPriority(3.0, null)).toBe(3.5);
    });
  });

  describe("mid-tier (both non-null, same integer floor)", () => {
    it("before=3.8 after=3.2 → 3.5", () => {
      expect(nextPriority(3.8, 3.2)).toBeCloseTo(3.5, 10);
    });

    it("before=4.9 after=4.1 → 4.5", () => {
      expect(nextPriority(4.9, 4.1)).toBeCloseTo(4.5, 10);
    });

    it("same-tier with equal values returns that value (degenerate ties)", () => {
      expect(nextPriority(3.5, 3.5)).toBe(3.5);
    });
  });

  describe("cross-tier (both non-null, different integer floor)", () => {
    it("spec example: before=4.5 after=3.5 → (4.5 + 4) / 2 = 4.25 (stays in before's tier)", () => {
      expect(nextPriority(4.5, 3.5)).toBe(4.25);
    });

    it("before=5.5 after=2.5 → (5.5 + 5) / 2 = 5.25", () => {
      expect(nextPriority(5.5, 2.5)).toBe(5.25);
    });

    it("before=2.7 after=1.3 → (2.7 + 2) / 2 = 2.35", () => {
      expect(nextPriority(2.7, 1.3)).toBeCloseTo(2.35, 10);
    });

    it("result of cross-tier always sits in before's integer tier", () => {
      const r = nextPriority(4.5, 3.5);
      expect(Math.floor(r)).toBe(4);
    });
  });

  describe("ordering invariants (non-boundary inputs)", () => {
    it("top-of-column with non-zero decimal: result < after", () => {
      const r = nextPriority(null, 3.5);
      expect(r).toBeLessThan(3.5);
    });

    it("bottom-of-column with non-zero decimal: result > before", () => {
      const r = nextPriority(3.5, null);
      expect(r).toBeGreaterThan(3.5);
    });

    it("mid-tier slot: result lies strictly between before and after", () => {
      const r = nextPriority(3.8, 3.2);
      expect(r).toBeLessThan(3.8);
      expect(r).toBeGreaterThan(3.2);
    });
  });

  describe("integer-boundary collision (accepted trade-off)", () => {
    // The DX-629 spec formula `floor(after) + afterDecimal/2` degenerates
    // to `after` when after is an integer (afterDecimal = 0). This
    // produces a collision the picker resolves via tie-breaker
    // (`priority DESC, id ASC`) and the next reorder re-derives. Tests
    // pin the documented behavior so a future refactor that "tightens"
    // the formula has to update this assertion + the source comment.
    it("top-of-column with integer after collides (5.0 → 5.0)", () => {
      expect(nextPriority(null, 5.0)).toBe(5.0);
    });

    it("same-tier with equal values collides (3.5,3.5 → 3.5)", () => {
      expect(nextPriority(3.5, 3.5)).toBe(3.5);
    });
  });
});
