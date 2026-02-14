import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery, mockEnd, mockAdminPool, mockCloseAdminPool, mockReaddir } =
  vi.hoisted(() => {
    const mockQuery = vi.fn();
    const mockEnd = vi.fn().mockResolvedValue(undefined);
    const mockAdminPool = {
      query: mockQuery,
      end: mockEnd,
      getConnection: vi.fn(),
    };
    const mockCloseAdminPool = vi.fn().mockResolvedValue(undefined);
    const mockReaddir = vi.fn();
    return { mockQuery, mockEnd, mockAdminPool, mockCloseAdminPool, mockReaddir };
  });

vi.mock("./connection.js", () => ({
  getAdminPool: vi.fn(() => mockAdminPool),
  closeAdminPool: mockCloseAdminPool,
}));

vi.mock("../config.js", () => ({
  config: {
    db: {
      host: "test-host",
      user: "test-user",
      password: "test-pass",
      database: "flytebot_chat",
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
  // Default: queries succeed with empty results
  mockQuery.mockResolvedValue([[], []]);
  mockReaddir.mockResolvedValue([]);
});

describe("runMigrations", () => {
  it("creates the database if it does not exist", async () => {
    const { runMigrations } = await importMigrate();
    await runMigrations();

    expect(mockQuery).toHaveBeenCalledWith(
      "CREATE DATABASE IF NOT EXISTS `flytebot_chat`",
    );
  });

  it("switches to the database with USE", async () => {
    const { runMigrations } = await importMigrate();
    await runMigrations();

    expect(mockQuery).toHaveBeenCalledWith("USE `flytebot_chat`");
  });

  it("creates the migrations tracking table", async () => {
    const { runMigrations } = await importMigrate();
    await runMigrations();

    const createTableCall = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("CREATE TABLE IF NOT EXISTS migrations"),
    );
    expect(createTableCall).toBeDefined();
  });

  it("queries for already-applied migrations", async () => {
    const { runMigrations } = await importMigrate();
    await runMigrations();

    const selectCall = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("SELECT name FROM migrations"),
    );
    expect(selectCall).toBeDefined();
  });

  it("scans migration files from the migrations directory", async () => {
    const { runMigrations } = await importMigrate();
    await runMigrations();

    expect(mockReaddir).toHaveBeenCalled();
  });

  it("applies pending migration and records it", async () => {
    // Real migration file exists at src/db/migrations/001_initial_schema.ts
    // It calls pool.query() which uses our mocked pool
    mockReaddir.mockResolvedValue(["001_initial_schema.ts"]);

    const { runMigrations } = await importMigrate();
    await runMigrations();

    // The migration's up() should have called CREATE TABLE health_check
    const createTableCall = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("CREATE TABLE IF NOT EXISTS health_check"),
    );
    expect(createTableCall).toBeDefined();

    // It should also have recorded the migration
    const insertCalls = mockQuery.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO migrations"),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual(["001_initial_schema.ts"]);
  });

  it("skips already-applied migrations", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("SELECT name")) {
        return Promise.resolve([[{ name: "001_initial_schema.ts" }], []]);
      }
      return Promise.resolve([[], []]);
    });

    mockReaddir.mockResolvedValue(["001_initial_schema.ts"]);

    const { runMigrations } = await importMigrate();
    await runMigrations();

    const insertCalls = mockQuery.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO"),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it("filters out .test.ts files from migrations", async () => {
    mockReaddir.mockResolvedValue(["001_initial_schema.ts", "001_initial_schema.test.ts"]);

    mockQuery.mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("SELECT name")) {
        return Promise.resolve([[{ name: "001_initial_schema.ts" }], []]);
      }
      return Promise.resolve([[], []]);
    });

    const { runMigrations } = await importMigrate();
    await runMigrations();

    // Only 001_initial_schema.ts should be considered (and it's already applied)
    // The .test.ts file should not trigger any INSERT
    const insertCalls = mockQuery.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO"),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it("does not crash when migrations fail", async () => {
    mockQuery.mockRejectedValueOnce(new Error("Connection refused"));

    const { runMigrations } = await importMigrate();
    await expect(runMigrations()).resolves.toBeUndefined();
  });

  it("closes the admin pool after running", async () => {
    const { runMigrations } = await importMigrate();
    await runMigrations();

    expect(mockCloseAdminPool).toHaveBeenCalled();
  });

  it("closes the admin pool even when migrations fail", async () => {
    mockQuery.mockRejectedValueOnce(new Error("Connection refused"));

    const { runMigrations } = await importMigrate();
    await runMigrations();

    expect(mockCloseAdminPool).toHaveBeenCalled();
  });

  it("handles missing migrations directory gracefully", async () => {
    mockReaddir.mockRejectedValueOnce(new Error("ENOENT: no such file or directory"));

    // Need fresh queries for CREATE DATABASE + USE + CREATE TABLE + SELECT
    mockQuery
      .mockResolvedValueOnce([[], []]) // CREATE DATABASE
      .mockResolvedValueOnce([[], []]) // USE
      .mockResolvedValueOnce([[], []]) // CREATE TABLE
      .mockResolvedValueOnce([[], []]); // SELECT applied

    const { runMigrations } = await importMigrate();
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(mockCloseAdminPool).toHaveBeenCalled();
  });
});

describe("runMigrations with missing config", () => {
  it("skips migrations when db host is not configured", async () => {
    vi.doMock("../config.js", () => ({
      config: {
        db: {
          host: "",
          user: "test-user",
          password: "test-pass",
          database: "flytebot_chat",
        },
      },
    }));

    vi.resetModules();
    const { runMigrations } = await import("./migrate.js");
    await runMigrations();

    expect(mockQuery).not.toHaveBeenCalled();
    // closeAdminPool should NOT be called since we early-returned
    expect(mockCloseAdminPool).not.toHaveBeenCalled();
  });
});
