import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPool, mockCreatePool } = vi.hoisted(() => {
  const mockPool = {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn(),
  };
  const mockCreatePool = vi.fn().mockReturnValue(mockPool);
  return { mockPool, mockCreatePool };
});

vi.mock("mysql2/promise", () => ({
  default: { createPool: mockCreatePool },
  createPool: mockCreatePool,
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
  it("creates a pool with the configured database", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    const pool = mod.getPool();

    expect(mockCreatePool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "test-host",
        user: "test-user",
        password: "test-pass",
        database: "danxbot_chat",
      }),
    );
    expect(pool).toBe(mockPool);
  });

  it("returns the same pool on subsequent calls", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    const pool1 = mod.getPool();
    const pool2 = mod.getPool();

    expect(pool1).toBe(pool2);
    expect(mockCreatePool).toHaveBeenCalledTimes(1);
  });

  it("sets connectionLimit to 5", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.getPool();

    expect(mockCreatePool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionLimit: 5,
      }),
    );
  });

  it("sets waitForConnections to true", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.getPool();

    expect(mockCreatePool).toHaveBeenCalledWith(
      expect.objectContaining({
        waitForConnections: true,
      }),
    );
  });

  it("passes connectTimeout from config", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.getPool();

    expect(mockCreatePool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectTimeout: 5000,
      }),
    );
  });
});

describe("getAdminPool", () => {
  it("creates a pool without specifying a database", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    const pool = mod.getAdminPool();

    // The admin pool call should not have a database property
    const adminCall = mockCreatePool.mock.calls.find(
      (call: unknown[]) => !(call[0] as Record<string, unknown>).database,
    );
    expect(adminCall).toBeDefined();
    expect(pool).toBe(mockPool);
  });

  it("returns the same admin pool on subsequent calls", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    const pool1 = mod.getAdminPool();
    const pool2 = mod.getAdminPool();

    expect(pool1).toBe(pool2);
  });

  it("passes connectTimeout from config", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.getAdminPool();

    expect(mockCreatePool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectTimeout: 5000,
      }),
    );
  });
});

describe("closePool", () => {
  it("calls end on the pool", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.getPool();
    await mod.closePool();

    expect(mockPool.end).toHaveBeenCalled();
  });

  it("does nothing if pool was never created", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    await mod.closePool();
    // Should not throw
  });
});

describe("closeAdminPool", () => {
  it("calls end on the admin pool", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.getAdminPool();
    await mod.closeAdminPool();

    expect(mockPool.end).toHaveBeenCalled();
  });
});

const PLATFORM_DB_CONFIG = {
  host: "platform-host",
  user: "platform-user",
  password: "platform-pass",
  database: "platform-db",
  enabled: true,
};

describe("initPlatformPool", () => {
  it("creates a pool with the provided repo db config", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.initPlatformPool(PLATFORM_DB_CONFIG);

    expect(mockCreatePool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "platform-host",
        user: "platform-user",
        password: "platform-pass",
        database: "platform-db",
      }),
    );
  });

  it("applies shared pool settings (connectionLimit, waitForConnections, connectTimeout)", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.initPlatformPool(PLATFORM_DB_CONFIG);

    expect(mockCreatePool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionLimit: 5,
        waitForConnections: true,
        connectTimeout: 5000,
      }),
    );
  });

  it("is a no-op when db.enabled is false", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.initPlatformPool({ ...PLATFORM_DB_CONFIG, enabled: false });

    expect(mockCreatePool).not.toHaveBeenCalled();
    expect(() => mod.getPlatformPool()).toThrow(/db\.enabled=false/);
  });

  it("throws when called a second time — startup-only contract", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.initPlatformPool(PLATFORM_DB_CONFIG);

    expect(() => mod.initPlatformPool(PLATFORM_DB_CONFIG)).toThrow(/already initialized/);
    expect(mockCreatePool).toHaveBeenCalledTimes(1);
  });

  it("throws on second call even if the first call was a disabled no-op", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.initPlatformPool({ ...PLATFORM_DB_CONFIG, enabled: false });

    expect(() => mod.initPlatformPool(PLATFORM_DB_CONFIG)).toThrow(/already initialized/);
  });

  it("can be re-initialized after closePlatformPool — supports startup/shutdown lifecycle", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.initPlatformPool(PLATFORM_DB_CONFIG);
    await mod.closePlatformPool();
    mod.initPlatformPool(PLATFORM_DB_CONFIG);

    expect(mockCreatePool).toHaveBeenCalledTimes(2);
    expect(mod.getPlatformPool()).toBe(mockPool);
  });
});

describe("getPlatformPool", () => {
  it("returns the pool created by initPlatformPool", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.initPlatformPool(PLATFORM_DB_CONFIG);

    expect(mod.getPlatformPool()).toBe(mockPool);
  });

  it("returns the same pool on subsequent calls", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.initPlatformPool(PLATFORM_DB_CONFIG);
    const pool1 = mod.getPlatformPool();
    const pool2 = mod.getPlatformPool();

    expect(pool1).toBe(pool2);
    expect(mockCreatePool).toHaveBeenCalledTimes(1);
  });

  it("throws an actionable error when called before initPlatformPool", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    expect(() => mod.getPlatformPool()).toThrow(/initPlatformPool/);
  });
});

describe("closePlatformPool", () => {
  it("calls end on the platform pool", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    mod.initPlatformPool(PLATFORM_DB_CONFIG);
    await mod.closePlatformPool();

    expect(mockPool.end).toHaveBeenCalled();
  });

  it("does nothing if platform pool was never created", async () => {
    vi.resetModules();
    const mod = await import("./connection.js");
    await mod.closePlatformPool();
    // Should not throw
  });
});
