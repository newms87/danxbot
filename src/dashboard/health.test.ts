import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
const mockGetEvents = vi.fn();
vi.mock("./events.js", () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
}));

const mockIsSlackConnected = vi.fn();
vi.mock("../slack/listener.js", () => ({
  isSlackConnected: (...args: unknown[]) => mockIsSlackConnected(...args),
}));

import { getHealthStatus } from "./health.js";

describe("getHealthStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all required fields", () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);

    const health = getHealthStatus();

    expect(health).toHaveProperty("status");
    expect(health).toHaveProperty("uptime_seconds");
    expect(health).toHaveProperty("slack_connected");
    expect(health).toHaveProperty("events_count");
    expect(health).toHaveProperty("memory_usage_mb");
  });

  it("returns status 'ok' when slack is connected", () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);

    const health = getHealthStatus();

    expect(health.status).toBe("ok");
    expect(health.slack_connected).toBe(true);
  });

  it("returns status 'degraded' when slack is disconnected", () => {
    mockIsSlackConnected.mockReturnValue(false);
    mockGetEvents.mockReturnValue([]);

    const health = getHealthStatus();

    expect(health.status).toBe("degraded");
    expect(health.slack_connected).toBe(false);
  });

  it("returns a positive uptime_seconds", () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);

    const health = getHealthStatus();

    expect(health.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(health.uptime_seconds)).toBe(true);
  });

  it("returns a positive memory_usage_mb", () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);

    const health = getHealthStatus();

    expect(health.memory_usage_mb).toBeGreaterThan(0);
    expect(typeof health.memory_usage_mb).toBe("number");
  });

  it("returns events_count reflecting actual event count", () => {
    mockIsSlackConnected.mockReturnValue(true);
    const fakeEvents = [{ id: "1" }, { id: "2" }, { id: "3" }];
    mockGetEvents.mockReturnValue(fakeEvents);

    const health = getHealthStatus();

    expect(health.events_count).toBe(3);
  });

  it("returns events_count of 0 when no events", () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);

    const health = getHealthStatus();

    expect(health.events_count).toBe(0);
  });
});
