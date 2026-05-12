import { describe, expect, it } from "vitest";
import {
  formatCostUsd,
  formatElapsed,
  formatPctOneDp,
  formatPercent,
} from "./markdown-format.js";

describe("formatPercent (2dp)", () => {
  it("formats 0 as 0.00%", () => {
    expect(formatPercent(0)).toBe("0.00%");
  });
  it("formats 1 as 100.00%", () => {
    expect(formatPercent(1)).toBe("100.00%");
  });
  it("formats 0.95 as 95.00%", () => {
    expect(formatPercent(0.95)).toBe("95.00%");
  });
  it("formats 11/12 (0.91666…) as 91.67%", () => {
    expect(formatPercent(11 / 12)).toBe("91.67%");
  });
});

describe("formatPctOneDp", () => {
  it("formats with a single decimal", () => {
    expect(formatPctOneDp(0.5)).toBe("50.0%");
    expect(formatPctOneDp(0.123)).toBe("12.3%");
    expect(formatPctOneDp(1)).toBe("100.0%");
  });
});

describe("formatCostUsd", () => {
  it("renders 4dp prefixed with ~$", () => {
    expect(formatCostUsd(0.0432)).toBe("~$0.0432");
    expect(formatCostUsd(0)).toBe("~$0.0000");
    expect(formatCostUsd(1.1)).toBe("~$1.1000");
  });

  it("never strips the leading tilde (estimate marker is load-bearing)", () => {
    expect(formatCostUsd(0.5).startsWith("~$")).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("renders < 1 minute as `0m Xs`", () => {
    expect(formatElapsed(5)).toBe("0m 0s");
    expect(formatElapsed(12_345)).toBe("0m 12s");
    expect(formatElapsed(45_000)).toBe("0m 45s");
  });

  it("renders multi-minute values", () => {
    expect(formatElapsed(65_000)).toBe("1m 5s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(150_000)).toBe("2m 30s");
  });
});
