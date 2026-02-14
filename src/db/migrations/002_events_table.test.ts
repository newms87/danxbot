import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

const mockPool = {
  query: mockQuery,
};

describe("002_events_table migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([[], []]);
  });

  it("creates the events table with expected columns", async () => {
    const { up } = await import("./002_events_table.js");
    await up(mockPool as never);

    const createCall = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("CREATE TABLE IF NOT EXISTS events"),
    );
    expect(createCall).toBeDefined();

    const sql = createCall![0] as string;
    // Verify key columns exist
    expect(sql).toContain("id VARCHAR(255) PRIMARY KEY");
    expect(sql).toContain("thread_ts VARCHAR(50) NOT NULL");
    expect(sql).toContain("message_ts VARCHAR(50) NOT NULL");
    expect(sql).toContain("channel_id VARCHAR(50) NOT NULL");
    expect(sql).toContain("`user` VARCHAR(50) NOT NULL");
    expect(sql).toContain("`text` TEXT NOT NULL");
    expect(sql).toContain("received_at BIGINT NOT NULL");
    expect(sql).toContain("router_response_at BIGINT NULL");
    expect(sql).toContain("router_response TEXT NULL");
    expect(sql).toContain("router_needs_agent TINYINT(1) NULL");
    expect(sql).toContain("agent_response_at BIGINT NULL");
    expect(sql).toContain("agent_response MEDIUMTEXT NULL");
    expect(sql).toContain("agent_cost_usd DECIMAL(10,4) NULL");
    expect(sql).toContain("agent_turns INT NULL");
    expect(sql).toContain("`status` VARCHAR(20) NOT NULL DEFAULT 'received'");
    expect(sql).toContain("`error` TEXT NULL");
    expect(sql).toContain("router_request JSON NULL");
    expect(sql).toContain("router_raw_response JSON NULL");
    expect(sql).toContain("agent_config JSON NULL");
    expect(sql).toContain("agent_log JSON NULL");
    expect(sql).toContain("agent_retried TINYINT(1) NOT NULL DEFAULT 0");
    expect(sql).toContain("feedback VARCHAR(10) NULL");
    expect(sql).toContain("response_ts VARCHAR(50) NULL");
    expect(sql).toContain("user_name VARCHAR(255) NULL");
  });

  it("creates indexes on status, channel_id, received_at, and feedback", async () => {
    const { up } = await import("./002_events_table.js");
    await up(mockPool as never);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("INDEX idx_events_status");
    expect(sql).toContain("INDEX idx_events_channel_id");
    expect(sql).toContain("INDEX idx_events_received_at");
    expect(sql).toContain("INDEX idx_events_feedback");
  });

  it("drops the events table on down", async () => {
    const { down } = await import("./002_events_table.js");
    await down(mockPool as never);

    expect(mockQuery).toHaveBeenCalledWith("DROP TABLE IF EXISTS events");
  });
});
