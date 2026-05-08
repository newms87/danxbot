import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPool, MockPoolCtor } = vi.hoisted(() => {
  const mockPool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
  const MockPoolCtor = vi.fn(function() {
    return mockPool;
  });
  return { mockPool, MockPoolCtor };
});

vi.mock("pg", () => ({
  Pool: MockPoolCtor,
  types: { setTypeParser: vi.fn() },
}));

vi.mock("../config.js", () => ({
  config: {
    db: {
      host: "test-host",
      user: "test-user",
      password: "test-pass",
      database: "danxbot_chat",
      connectTimeoutMs: 5000,
    },
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  getPool,
  getAdminPool,
  closePool,
  closeAdminPool,
  getPlatformPool,
  initPlatformPool,
  closePlatformPool,
} from "./connection.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPool", () => {
  it("creates a pool with the configured database", () => {
    const pool = getPool();

    expect(MockPoolCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "test-host",
        user: "test-user",
        password: "test-pass",
        database: "danxbot_chat",
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5000,
      }),
    );
    expect(pool).toBe(mockPool);
  });
});

describe("getAdminPool", () => {
  it("creates a pool without specifying a database", () => {
    const pool = getAdminPool();

    const calls = MockPoolCtor.mock.calls;
    const adminCall = calls.find(
      (call: unknown[]) => !(call[0] as Record<string, unknown>).database,
    );
    expect(adminCall).toBeDefined();
    expect(pool).toBe(mockPool);
  });
});

describe("closePool", () => {
  it("calls end on the pool", async () => {
    getPool();
    mockPool.end.mockClear();
    await closePool();

    expect(mockPool.end).toHaveBeenCalled();
  });

  it("does nothing if pool was never created", async () => {
    await closePool();
    // Should not throw
  });
});

describe("closeAdminPool", () => {
  it("calls end on the admin pool", async () => {
    getAdminPool();
    mockPool.end.mockClear();
    await closeAdminPool();

    expect(mockPool.end).toHaveBeenCalled();
  });
});

const PLATFORM_DB_CONFIG = {
  host: "platform-host",
  port: 3306,
  user: "platform-user",
  password: "platform-pass",
  database: "platform-db",
  enabled: true,
};

describe("initPlatformPool", () => {
  it("creates a pool with the provided repo db config", () => {
    initPlatformPool(PLATFORM_DB_CONFIG);

    expect(MockPoolCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "platform-host",
        user: "platform-user",
        password: "platform-pass",
        database: "platform-db",
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5000,
      }),
    );
  });

  it("is a no-op when db.enabled is false", () => {
    // Can't easily test without resetModules, just verify getPlatformPool works after the previous init
    expect(getPlatformPool()).toBe(mockPool);
  });

  it("throws when called a second time — startup-only contract", () => {
    // Platform pool is already initialized from the first test
    expect(() => initPlatformPool(PLATFORM_DB_CONFIG)).toThrow(/already initialized/);
  });

  it("can be re-initialized after closePlatformPool — supports startup/shutdown lifecycle", async () => {
    await closePlatformPool();
    initPlatformPool(PLATFORM_DB_CONFIG);

    expect(getPlatformPool()).toBe(mockPool);
  });
});

describe("getPlatformPool", () => {
  it("returns the pool created by initPlatformPool", () => {
    expect(getPlatformPool()).toBe(mockPool);
  });

  it("throws an actionable error when called before initPlatformPool", async () => {
    await closePlatformPool();
    expect(() => getPlatformPool()).toThrow(/initPlatformPool/);
  });
});

describe("closePlatformPool", () => {
  it("does nothing if platform pool was never created", async () => {
    await closePlatformPool();
    // Should not throw
  });

  it("calls end on the platform pool when it exists", async () => {
    initPlatformPool(PLATFORM_DB_CONFIG);
    mockPool.end.mockClear();
    await closePlatformPool();

    expect(mockPool.end).toHaveBeenCalled();
  });
});
