import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
const mockGetEvents = vi.fn();
vi.mock("./events.js", () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
}));

const mockCheckDbConnection = vi.fn();
vi.mock("../db/health.js", () => ({
  checkDbConnection: (...args: unknown[]) => mockCheckDbConnection(...args),
}));

import { getHealthStatus } from "./health.js";

describe("getHealthStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckDbConnection.mockResolvedValue(true);
  });

  it("returns all required fields", async () => {
    mockGetEvents.mockReturnValue([]);

    const health = await getHealthStatus();

    expect(health).toHaveProperty("status");
    expect(health).toHaveProperty("uptime_seconds");
    expect(health).toHaveProperty("db_connected");
    expect(health).toHaveProperty("events_count");
    expect(health).toHaveProperty("memory_usage_mb");
  });

  it("returns status 'ok' when DB is connected", async () => {
    mockGetEvents.mockReturnValue([]);
    mockCheckDbConnection.mockResolvedValue(true);

    const health = await getHealthStatus();

    expect(health.status).toBe("ok");
    expect(health.db_connected).toBe(true);
  });

  it("returns db_connected true when DB ping succeeds", async () => {
    mockGetEvents.mockReturnValue([]);
    mockCheckDbConnection.mockResolvedValue(true);

    const health = await getHealthStatus();

    expect(health.db_connected).toBe(true);
    expect(mockCheckDbConnection).toHaveBeenCalled();
  });

  it("returns db_connected false when DB ping fails", async () => {
    mockGetEvents.mockReturnValue([]);
    mockCheckDbConnection.mockResolvedValue(false);

    const health = await getHealthStatus();

    expect(health.db_connected).toBe(false);
  });

  it("returns degraded when DB unreachable", async () => {
    mockGetEvents.mockReturnValue([]);
    mockCheckDbConnection.mockResolvedValue(false);

    const health = await getHealthStatus();

    expect(health.status).toBe("degraded");
    expect(health.db_connected).toBe(false);
  });

  it("returns a positive uptime_seconds", async () => {
    mockGetEvents.mockReturnValue([]);

    const health = await getHealthStatus();

    expect(health.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(health.uptime_seconds)).toBe(true);
  });

  it("returns a positive memory_usage_mb", async () => {
    mockGetEvents.mockReturnValue([]);

    const health = await getHealthStatus();

    expect(health.memory_usage_mb).toBeGreaterThan(0);
    expect(typeof health.memory_usage_mb).toBe("number");
  });

  it("returns events_count reflecting actual event count", async () => {
    const fakeEvents = [{ id: "1" }, { id: "2" }, { id: "3" }];
    mockGetEvents.mockReturnValue(fakeEvents);

    const health = await getHealthStatus();

    expect(health.events_count).toBe(3);
  });

  it("returns events_count of 0 when no events", async () => {
    mockGetEvents.mockReturnValue([]);

    const health = await getHealthStatus();

    expect(health.events_count).toBe(0);
  });
});
