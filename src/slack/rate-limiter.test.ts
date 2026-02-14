import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { rateLimitSeconds: 30 },
}));

const { isRateLimited, recordAgentRun, resetRateLimiter } = await import(
  "./rate-limiter.js"
);

beforeEach(() => {
  vi.useFakeTimers();
  resetRateLimiter();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isRateLimited", () => {
  it("returns false for an unknown user", () => {
    expect(isRateLimited("U-NEW")).toBe(false);
  });

  it("returns true during cooldown after recordAgentRun", () => {
    recordAgentRun("U-1");
    expect(isRateLimited("U-1")).toBe(true);
  });

  it("returns false after cooldown expires", () => {
    recordAgentRun("U-1");
    vi.advanceTimersByTime(30_001);
    expect(isRateLimited("U-1")).toBe(false);
  });

  it("returns true just before cooldown expires", () => {
    recordAgentRun("U-1");
    vi.advanceTimersByTime(29_999);
    expect(isRateLimited("U-1")).toBe(true);
  });

  it("tracks multiple users independently", () => {
    recordAgentRun("U-1");
    vi.advanceTimersByTime(15_000);
    recordAgentRun("U-2");

    // U-1 still limited (15s elapsed of 30s)
    expect(isRateLimited("U-1")).toBe(true);
    // U-2 just recorded
    expect(isRateLimited("U-2")).toBe(true);

    // Advance past U-1 cooldown but not U-2
    vi.advanceTimersByTime(16_000);
    expect(isRateLimited("U-1")).toBe(false);
    expect(isRateLimited("U-2")).toBe(true);
  });
});

describe("recordAgentRun", () => {
  it("records the current timestamp for a user", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordAgentRun("U-1");
    expect(isRateLimited("U-1")).toBe(true);
  });

  it("overwrites previous timestamp on subsequent call", () => {
    recordAgentRun("U-1");
    vi.advanceTimersByTime(25_000);
    // Re-record resets the cooldown
    recordAgentRun("U-1");
    vi.advanceTimersByTime(10_000);
    // Only 10s since last record, still limited
    expect(isRateLimited("U-1")).toBe(true);
  });
});

describe("resetRateLimiter", () => {
  it("clears all tracked users", () => {
    recordAgentRun("U-1");
    recordAgentRun("U-2");
    resetRateLimiter();
    expect(isRateLimited("U-1")).toBe(false);
    expect(isRateLimited("U-2")).toBe(false);
  });
});
