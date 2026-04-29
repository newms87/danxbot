import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

const mockPool = {
  query: mockQuery,
};

describe("013_drop_heartbeat_snapshots migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([[], []]);
  });

  it("drops events.heartbeat_snapshots on up", async () => {
    const { up } = await import("./013_drop_heartbeat_snapshots.js");
    await up(mockPool as never);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ALTER TABLE events");
    expect(sql).toContain("DROP COLUMN heartbeat_snapshots");
  });

  it("re-adds events.heartbeat_snapshots on down (mirrors 007.up)", async () => {
    const { down } = await import("./013_drop_heartbeat_snapshots.js");
    await down(mockPool as never);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ALTER TABLE events");
    expect(sql).toContain("ADD COLUMN heartbeat_snapshots JSON NULL");
    expect(sql).toContain("AFTER agent_log");
  });
});
