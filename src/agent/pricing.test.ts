import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { calculateApiCost, buildApiCallUsage } from "./pricing.js";

describe("calculateApiCost", () => {
  const HAIKU = "claude-haiku-4-5-20251001";

  it("calculates correct cost for known token counts", () => {
    // 1000 input tokens at $0.80/MTok = $0.0008
    // 500 output tokens at $4.00/MTok = $0.002
    // 200 cache write tokens at $1.00/MTok = $0.0002
    // 800 cache read tokens at $0.08/MTok = $0.000064
    const cost = calculateApiCost(HAIKU, 1000, 500, 200, 800);
    expect(cost).toBeCloseTo(0.003064, 6);
  });

  it("calculates correct cost with zero cache tokens", () => {
    // 5000 input at $0.80/MTok = $0.004
    // 100 output at $4.00/MTok = $0.0004
    const cost = calculateApiCost(HAIKU, 5000, 100, 0, 0);
    expect(cost).toBeCloseTo(0.0044, 6);
  });

  it("returns 0 for all-zero tokens", () => {
    expect(calculateApiCost(HAIKU, 0, 0, 0, 0)).toBe(0);
  });

  it("returns 0 for unknown model", () => {
    expect(calculateApiCost("unknown-model", 1000, 500, 200, 800)).toBe(0);
  });

  it("calculates correct cost for Sonnet 4", () => {
    const SONNET = "claude-sonnet-4-20250514";
    // 1000 input at $3.00/MTok = $0.003
    // 500 output at $15.00/MTok = $0.0075
    // 200 cache write at $3.75/MTok = $0.00075
    // 800 cache read at $0.30/MTok = $0.00024
    const cost = calculateApiCost(SONNET, 1000, 500, 200, 800);
    expect(cost).toBeCloseTo(0.01149, 5);
  });

  it("calculates correct cost for Sonnet 4.5", () => {
    const SONNET45 = "claude-sonnet-4-5-20250929";
    // Same pricing as Sonnet 4
    const cost = calculateApiCost(SONNET45, 1000, 500, 200, 800);
    expect(cost).toBeCloseTo(0.01149, 5);
  });

  it("calculates correct cost for Opus 4", () => {
    const OPUS = "claude-opus-4-20250514";
    // 1000 input at $15.00/MTok = $0.015
    // 500 output at $75.00/MTok = $0.0375
    // 200 cache write at $18.75/MTok = $0.00375
    // 800 cache read at $1.50/MTok = $0.0012
    const cost = calculateApiCost(OPUS, 1000, 500, 200, 800);
    expect(cost).toBeCloseTo(0.05745, 5);
  });

  it("calculates correct cost for Opus 4.6", () => {
    const OPUS46 = "claude-opus-4-6-20250916";
    // 1000 input at $5.00/MTok = $0.005
    // 500 output at $25.00/MTok = $0.0125
    // 200 cache write at $6.25/MTok = $0.00125
    // 800 cache read at $0.50/MTok = $0.0004
    const cost = calculateApiCost(OPUS46, 1000, 500, 200, 800);
    expect(cost).toBeCloseTo(0.01915, 5);
  });

  it("calculates correct cost for Opus 4.6 short alias", () => {
    const cost = calculateApiCost("claude-opus-4-6", 1000, 500, 200, 800);
    expect(cost).toBeCloseTo(0.01915, 5);
  });

  it("handles large token counts", () => {
    // 1M input at $0.80/MTok = $0.80
    // 1M output at $4.00/MTok = $4.00
    const cost = calculateApiCost(HAIKU, 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(4.80, 2);
  });
});

describe("buildApiCallUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds ApiCallUsage from response usage object", () => {
    const usage = buildApiCallUsage(
      { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
      "claude-haiku-4-5-20251001",
      "router",
    );

    expect(usage.source).toBe("router");
    expect(usage.model).toBe("claude-haiku-4-5-20251001");
    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(200);
    expect(usage.cacheCreationInputTokens).toBe(0);
    expect(usage.cacheReadInputTokens).toBe(500);
    expect(usage.costUsd).toBeGreaterThan(0);
    expect(usage.timestamp).toBe(Date.now());
  });

  it("defaults missing fields to 0", () => {
    const usage = buildApiCallUsage(
      { input_tokens: 100, output_tokens: 50 },
      "claude-haiku-4-5-20251001",
      "heartbeat",
    );

    expect(usage.cacheCreationInputTokens).toBe(0);
    expect(usage.cacheReadInputTokens).toBe(0);
    expect(usage.source).toBe("heartbeat");
  });

  it("handles completely empty usage object", () => {
    const usage = buildApiCallUsage({}, "claude-haiku-4-5-20251001", "router");

    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.costUsd).toBe(0);
  });
});
