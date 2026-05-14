import { describe, it, expect } from "vitest";
import {
  ageBuckets,
  compactAge,
  relativeOld,
  relativeTime,
} from "./relativeTime";

const NOW = 1_700_000_000_000;

describe("ageBuckets", () => {
  it("collapses sub-minute diffs to the 'now' unit (count=0)", () => {
    expect(ageBuckets(0)).toEqual({ count: 0, unit: "now" });
    expect(ageBuckets(59_999)).toEqual({ count: 0, unit: "now" });
  });

  it("collapses negative diffs (clock skew, future timestamp) to 'now'", () => {
    expect(ageBuckets(-5_000)).toEqual({ count: 0, unit: "now" });
  });

  it("buckets minutes up to but not including 1 hour", () => {
    expect(ageBuckets(60_000)).toEqual({ count: 1, unit: "min" });
    expect(ageBuckets(59 * 60_000)).toEqual({ count: 59, unit: "min" });
    expect(ageBuckets(3_600_000 - 1)).toEqual({ count: 59, unit: "min" });
  });

  it("buckets hours up to but not including 1 day", () => {
    expect(ageBuckets(3_600_000)).toEqual({ count: 1, unit: "hour" });
    expect(ageBuckets(23 * 3_600_000)).toEqual({ count: 23, unit: "hour" });
    expect(ageBuckets(86_400_000 - 1)).toEqual({ count: 23, unit: "hour" });
  });

  it("buckets days for anything >= 1 day", () => {
    expect(ageBuckets(86_400_000)).toEqual({ count: 1, unit: "day" });
    expect(ageBuckets(7 * 86_400_000)).toEqual({ count: 7, unit: "day" });
  });
});

describe("relativeTime", () => {
  it("renders 'just now' for sub-minute diffs", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeTime(NOW, NOW)).toBe("just now");
  });

  it("renders 'Xm ago' for minutes", () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
  });

  it("renders 'Xh ago' for hours", () => {
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  });

  it("renders 'Xd ago' for days", () => {
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  it("uses Date.now() when `now` arg omitted", () => {
    // Sanity: just shouldn't throw + returns a non-empty string.
    expect(typeof relativeTime(Date.now())).toBe("string");
    expect(relativeTime(Date.now()).length).toBeGreaterThan(0);
  });
});

describe("relativeOld", () => {
  it("renders 'new' for sub-minute diffs", () => {
    expect(relativeOld(NOW - 30_000, NOW)).toBe("new");
    expect(relativeOld(NOW, NOW)).toBe("new");
  });

  it("renders 'Xm old' / 'Xh old' / 'Xd old' for matching buckets", () => {
    expect(relativeOld(NOW - 5 * 60_000, NOW)).toBe("5m old");
    expect(relativeOld(NOW - 3 * 3_600_000, NOW)).toBe("3h old");
    expect(relativeOld(NOW - 2 * 86_400_000, NOW)).toBe("2d old");
  });

  it("renders 'now' for sub-minute diffs in compact form", () => {
    expect(compactAge(NOW - 30_000, NOW)).toBe("now");
    expect(compactAge(NOW, NOW)).toBe("now");
  });

  it("renders compactAge as 'Nm' / 'Nh' / 'Nd' (no suffix, no space)", () => {
    expect(compactAge(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(compactAge(NOW - 2 * 3_600_000, NOW)).toBe("2h");
    expect(compactAge(NOW - 3 * 86_400_000, NOW)).toBe("3d");
  });

  it("never disagrees with relativeTime on the bucket count (shared math)", () => {
    // Crossing every threshold: ago + old must read the same magnitude.
    const fixtures = [
      30_000,
      60_000,
      3_600_000,
      86_400_000,
      5 * 86_400_000,
    ];
    for (const diff of fixtures) {
      const ts = NOW - diff;
      const ago = relativeTime(ts, NOW);
      const old = relativeOld(ts, NOW);
      // Strip suffix; magnitudes (sans " ago"/" old") must match.
      expect(ago.replace(/ ago$/, "")).toBe(
        old.replace(/ old$/, "").replace(/^new$/, "just now"),
      );
    }
  });
});
