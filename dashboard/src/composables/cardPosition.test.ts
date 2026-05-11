import { describe, expect, it } from "vitest";
import { nextPosition } from "./cardPosition";

describe("nextPosition — fractional-indexing helper (DX-264)", () => {
  it("returns 0 when both neighbors are null (empty column drop)", () => {
    expect(nextPosition(null, null)).toBe(0);
  });

  it("returns after - 1 when inserting at the head of a list", () => {
    expect(nextPosition(null, 5)).toBe(4);
  });

  it("returns before + 1 when inserting at the tail of a list", () => {
    expect(nextPosition(10, null)).toBe(11);
  });

  it("returns the midpoint when inserting between two neighbors", () => {
    expect(nextPosition(10, 20)).toBe(15);
  });

  it("handles fractional neighbors (repeated midpoint splits)", () => {
    expect(nextPosition(0, 1)).toBe(0.5);
    expect(nextPosition(0, 0.5)).toBe(0.25);
    expect(nextPosition(0.25, 0.5)).toBe(0.375);
  });

  it("handles negative positions (insert before the current head)", () => {
    expect(nextPosition(null, -5)).toBe(-6);
    expect(nextPosition(-10, -5)).toBe(-7.5);
  });

  it("midpoint between two equal positions returns that value (degenerate but defined)", () => {
    // Caller is responsible for ordering, but degenerate input must not
    // crash — the result equals the shared value so re-insertion is a
    // visible no-op rather than NaN.
    expect(nextPosition(5, 5)).toBe(5);
  });
});
