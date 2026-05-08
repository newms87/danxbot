import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

const mockPool = {
  query: mockQuery,
};

describe("015_dispatches_pid_timestamps migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([[], []]);
  });

  it("adds host_pid_at and pid_terminated_at columns to dispatches", async () => {
    const { up } = await import("./015_dispatches_pid_timestamps.js");
    await up(mockPool as never);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;

    expect(sql).toContain("ALTER TABLE dispatches");
    expect(sql).toContain("ADD COLUMN host_pid_at BIGINT NULL");
    expect(sql).toContain("ADD COLUMN pid_terminated_at BIGINT NULL");
    // Position both new columns relative to the existing host_pid so the
    // PID's lifecycle fields cluster together in the schema.
    expect(sql).toContain("AFTER host_pid");
    expect(sql).toContain("AFTER host_pid_at");
  });

  it("drops both new columns on down (reverse order)", async () => {
    const { down } = await import("./015_dispatches_pid_timestamps.js");
    await down(mockPool as never);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("ALTER TABLE dispatches");
    expect(sql).toContain("DROP COLUMN pid_terminated_at");
    expect(sql).toContain("DROP COLUMN host_pid_at");
    // Reverse order matters because pid_terminated_at sits AFTER host_pid_at —
    // dropping host_pid_at first would leave pid_terminated_at orphan-positioned.
    const dropPidIdx = sql.indexOf("DROP COLUMN pid_terminated_at");
    const dropAtIdx = sql.indexOf("DROP COLUMN host_pid_at");
    expect(dropPidIdx).toBeLessThan(dropAtIdx);
  });
});
