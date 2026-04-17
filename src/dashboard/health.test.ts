import { describe, it, expect, vi, beforeEach } from "vitest";

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
    const health = await getHealthStatus();

    expect(health).toHaveProperty("status");
    expect(health).toHaveProperty("uptime_seconds");
    expect(health).toHaveProperty("db_connected");
    expect(health).toHaveProperty("memory_usage_mb");
  });

  it("returns status 'ok' when DB is connected", async () => {
    mockCheckDbConnection.mockResolvedValue(true);

    const health = await getHealthStatus();

    expect(health.status).toBe("ok");
    expect(health.db_connected).toBe(true);
  });

  it("returns db_connected true when DB ping succeeds", async () => {
    mockCheckDbConnection.mockResolvedValue(true);

    const health = await getHealthStatus();

    expect(health.db_connected).toBe(true);
    expect(mockCheckDbConnection).toHaveBeenCalled();
  });

  it("returns db_connected false when DB ping fails", async () => {
    mockCheckDbConnection.mockResolvedValue(false);

    const health = await getHealthStatus();

    expect(health.db_connected).toBe(false);
  });

  it("returns degraded when DB unreachable", async () => {
    mockCheckDbConnection.mockResolvedValue(false);

    const health = await getHealthStatus();

    expect(health.status).toBe("degraded");
    expect(health.db_connected).toBe(false);
  });

  it("returns a positive uptime_seconds", async () => {
    const health = await getHealthStatus();

    expect(health.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(health.uptime_seconds)).toBe(true);
  });

  it("returns a positive memory_usage_mb", async () => {
    const health = await getHealthStatus();

    expect(health.memory_usage_mb).toBeGreaterThan(0);
    expect(typeof health.memory_usage_mb).toBe("number");
  });
});
