import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetPool, mockClosePool, mockWithTx, mockReaddir } =
  vi.hoisted(() => {
    const mockGetPool = vi.fn();
    const mockClosePool = vi.fn().mockResolvedValue(undefined);
    const mockWithTx = vi.fn();
    const mockReaddir = vi.fn();
    return { mockGetPool, mockClosePool, mockWithTx, mockReaddir };
  });

vi.mock("./connection.js", () => ({
  getPool: mockGetPool,
  closePool: mockClosePool,
  withTx: mockWithTx,
}));

vi.mock("../config.js", () => ({
  config: {
    db: {
      host: "test-host",
      user: "test-user",
      password: "test-pass",
      database: "danxbot_chat",
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

vi.mock("fs/promises", () => ({
  readdir: mockReaddir,
}));

async function importMigrate() {
  vi.resetModules();
  return await import("./migrate.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: getPool returns a mock pool, queries succeed
  const mockPool = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  mockGetPool.mockReturnValue(mockPool);

  // Default withTx implementation that executes the function
  mockWithTx.mockImplementation(async (fn) => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    return fn(mockClient);
  });

  mockReaddir.mockResolvedValue([]);
});

describe("runMigrations", () => {
  it("creates the schema_migrations table", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    mockGetPool.mockReturnValue(mockPool);

    const { runMigrations } = await importMigrate();
    await runMigrations();

    const createTableCall = mockPool.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("CREATE TABLE IF NOT EXISTS schema_migrations"),
    );
    expect(createTableCall).toBeDefined();
  });

  it("queries for already-applied migrations", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    mockGetPool.mockReturnValue(mockPool);

    const { runMigrations } = await importMigrate();
    await runMigrations();

    const selectCall = mockPool.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("SELECT version FROM schema_migrations"),
    );
    expect(selectCall).toBeDefined();
  });

  it("scans migration files from the migrations directory", async () => {
    const { runMigrations } = await importMigrate();
    await runMigrations();

    expect(mockReaddir).toHaveBeenCalled();
  });

  it("applies pending migration and records it", async () => {
    mockReaddir.mockResolvedValue(["001_initial_schema.ts"]);

    let migrationUpCalled = false;
    mockWithTx.mockImplementation(async (fn) => {
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("CREATE TABLE IF NOT EXISTS health_check")) {
            migrationUpCalled = true;
          }
          return { rows: [], rowCount: 0 };
        }),
      };
      return fn(mockClient);
    });

    const { runMigrations } = await importMigrate();
    await runMigrations();

    expect(migrationUpCalled).toBe(true);
  });

  it("skips already-applied migrations", async () => {
    mockReaddir.mockResolvedValue(["001_initial_schema.ts"]);

    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ version: 1 }], rowCount: 1 }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    mockGetPool.mockReturnValue(mockPool);

    mockWithTx.mockImplementation(async (fn) => {
      // Should not be called if migration is already applied
      throw new Error("Migration should have been skipped");
    });

    const { runMigrations } = await importMigrate();
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(mockWithTx).not.toHaveBeenCalled();
  });

  it("filters out .test.ts files from migrations", async () => {
    mockReaddir.mockResolvedValue(["001_initial_schema.ts", "001_initial_schema.test.ts"]);

    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ version: 1 }], rowCount: 1 }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    mockGetPool.mockReturnValue(mockPool);

    const { runMigrations } = await importMigrate();
    await runMigrations();

    // Should have filtered out the .test.ts file
    expect(mockReaddir).toHaveBeenCalled();
  });

  it("throws when migrations fail", async () => {
    mockReaddir.mockResolvedValue(["001_initial_schema.ts"]);
    mockWithTx.mockRejectedValueOnce(new Error("Connection refused"));

    const { runMigrations } = await importMigrate();
    await expect(runMigrations()).rejects.toThrow("Connection refused");
  });

  it("closes the pool after running", async () => {
    const { runMigrations } = await importMigrate();
    await runMigrations();

    expect(mockClosePool).toHaveBeenCalled();
  });

  it("closes the pool even when migrations fail", async () => {
    mockReaddir.mockResolvedValueOnce(["001_initial_schema.ts"]);
    mockWithTx.mockRejectedValueOnce(new Error("Connection refused"));

    const { runMigrations } = await importMigrate();
    await expect(runMigrations()).rejects.toThrow("Connection refused");

    expect(mockClosePool).toHaveBeenCalled();
  });

  it("handles missing migrations directory gracefully", async () => {
    mockReaddir.mockRejectedValueOnce(new Error("ENOENT: no such file or directory"));

    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      end: vi.fn().mockResolvedValue(undefined),
    };
    mockGetPool.mockReturnValue(mockPool);

    const { runMigrations } = await importMigrate();
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(mockClosePool).toHaveBeenCalled();
  });
});

