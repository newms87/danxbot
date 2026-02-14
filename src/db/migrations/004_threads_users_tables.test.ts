import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

const mockPool = {
  query: mockQuery,
};

describe("004_threads_users_tables migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([[], []]);
  });

  it("creates the threads table with expected columns", async () => {
    const { up } = await import("./004_threads_users_tables.js");
    await up(mockPool as never);

    const threadsCall = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("CREATE TABLE IF NOT EXISTS threads"),
    );
    expect(threadsCall).toBeDefined();

    const sql = threadsCall![0] as string;
    expect(sql).toContain("thread_ts VARCHAR(50) PRIMARY KEY");
    expect(sql).toContain("channel_id VARCHAR(50) NOT NULL");
    expect(sql).toContain("session_id VARCHAR(255) NULL");
    expect(sql).toContain("messages JSON NOT NULL");
    expect(sql).toContain("created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
    expect(sql).toContain("updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
    expect(sql).toContain("INDEX idx_threads_updated_at");
  });

  it("creates the users table with expected columns", async () => {
    const { up } = await import("./004_threads_users_tables.js");
    await up(mockPool as never);

    const usersCall = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("CREATE TABLE IF NOT EXISTS users"),
    );
    expect(usersCall).toBeDefined();

    const sql = usersCall![0] as string;
    expect(sql).toContain("slack_user_id VARCHAR(50) PRIMARY KEY");
    expect(sql).toContain("display_name VARCHAR(255) NULL");
    expect(sql).toContain("preferences JSON NULL");
    expect(sql).toContain("created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
    expect(sql).toContain("updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
  });

  it("drops both tables on down", async () => {
    const { down } = await import("./004_threads_users_tables.js");
    await down(mockPool as never);

    const dropCalls = mockQuery.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(dropCalls).toContain("DROP TABLE IF EXISTS threads");
    expect(dropCalls).toContain("DROP TABLE IF EXISTS users");
  });
});
