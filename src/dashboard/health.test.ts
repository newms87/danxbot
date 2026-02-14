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

const mockQuery = vi.fn();
const mockGetPool = vi.fn(() => ({ query: mockQuery }));
vi.mock("../db/connection.js", () => ({
  getPool: () => mockGetPool(),
}));

import { getHealthStatus } from "./health.js";

describe("getHealthStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  it("returns all required fields", async () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);

    const health = await getHealthStatus();

    expect(health).toHaveProperty("status");
    expect(health).toHaveProperty("uptime_seconds");
    expect(health).toHaveProperty("slack_connected");
    expect(health).toHaveProperty("db_connected");
    expect(health).toHaveProperty("events_count");
    expect(health).toHaveProperty("memory_usage_mb");
  });

  it("returns status 'ok' when both slack and DB are connected", async () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);
    mockQuery.mockResolvedValue([]);

    const health = await getHealthStatus();

    expect(health.status).toBe("ok");
    expect(health.slack_connected).toBe(true);
    expect(health.db_connected).toBe(true);
  });

  it("returns status 'degraded' when slack is disconnected", async () => {
    mockIsSlackConnected.mockReturnValue(false);
    mockGetEvents.mockReturnValue([]);

    const health = await getHealthStatus();

    expect(health.status).toBe("degraded");
    expect(health.slack_connected).toBe(false);
  });

  it("returns db_connected true when DB ping succeeds", async () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);
    mockQuery.mockResolvedValue([]);

    const health = await getHealthStatus();

    expect(health.db_connected).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith("SELECT 1");
  });

  it("returns db_connected false when DB ping fails", async () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);
    mockQuery.mockRejectedValue(new Error("Connection refused"));

    const health = await getHealthStatus();

    expect(health.db_connected).toBe(false);
  });

  it("returns degraded when slack connected but DB unreachable", async () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);
    mockQuery.mockRejectedValue(new Error("ECONNREFUSED"));

    const health = await getHealthStatus();

    expect(health.status).toBe("degraded");
    expect(health.slack_connected).toBe(true);
    expect(health.db_connected).toBe(false);
  });

  it("returns degraded when DB connected but slack disconnected", async () => {
    mockIsSlackConnected.mockReturnValue(false);
    mockGetEvents.mockReturnValue([]);
    mockQuery.mockResolvedValue([]);

    const health = await getHealthStatus();

    expect(health.status).toBe("degraded");
    expect(health.slack_connected).toBe(false);
    expect(health.db_connected).toBe(true);
  });

  it("returns a positive uptime_seconds", async () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);

    const health = await getHealthStatus();

    expect(health.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(health.uptime_seconds)).toBe(true);
  });

  it("returns a positive memory_usage_mb", async () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);

    const health = await getHealthStatus();

    expect(health.memory_usage_mb).toBeGreaterThan(0);
    expect(typeof health.memory_usage_mb).toBe("number");
  });

  it("returns events_count reflecting actual event count", async () => {
    mockIsSlackConnected.mockReturnValue(true);
    const fakeEvents = [{ id: "1" }, { id: "2" }, { id: "3" }];
    mockGetEvents.mockReturnValue(fakeEvents);

    const health = await getHealthStatus();

    expect(health.events_count).toBe(3);
  });

  it("returns events_count of 0 when no events", async () => {
    mockIsSlackConnected.mockReturnValue(true);
    mockGetEvents.mockReturnValue([]);

    const health = await getHealthStatus();

    expect(health.events_count).toBe(0);
  });
});
