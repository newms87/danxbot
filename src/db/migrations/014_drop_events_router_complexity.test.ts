import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

const mockPool = {
  query: mockQuery,
};

describe("014_drop_events_router_complexity migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([[], []]);
  });

  it("drops events.router_complexity on up", async () => {
    const { up } = await import("./014_drop_events_router_complexity.js");
    await up(mockPool as never);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ALTER TABLE events");
    expect(sql).toContain("DROP COLUMN router_complexity");
  });

  it("re-adds events.router_complexity on down (mirrors 003.up)", async () => {
    const { down } = await import("./014_drop_events_router_complexity.js");
    await down(mockPool as never);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ALTER TABLE events");
    expect(sql).toContain("ADD COLUMN router_complexity VARCHAR(10) NULL");
    expect(sql).toContain("AFTER router_needs_agent");
  });
});
