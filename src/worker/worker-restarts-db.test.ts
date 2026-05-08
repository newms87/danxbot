import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockQuery } = vi.hoisted(() => {
  return {
    mockQuery: vi.fn(),
  };
});

vi.mock("../db/connection.js", () => ({
  query: mockQuery,
}));

import {
  insertRestart,
  completeRestart,
  getLatestSuccessfulRestart,
} from "./worker-restarts-db.js";

describe("worker-restarts-db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  it("insertRestart returns RETURNING id", async () => {
    mockQuery.mockResolvedValueOnce([{ id: 42 }]);
    const id = await insertRestart({
      requestingDispatchId: "d-1",
      repo: "danxbot",
      reason: "manual restart",
      outcome: "started",
      oldPid: 1234,
      startedAt: 1_700_000_000_000,
    });
    expect(id).toBe(42);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO worker_restarts");
    expect(sql).toContain("RETURNING id");
    expect(params).toEqual([
      "d-1",
      "danxbot",
      "manual restart",
      "started",
      1234,
      1_700_000_000_000,
    ]);
  });

  it("insertRestart accepts terminal outcomes (cross_repo, cooldown, etc.)", async () => {
    mockQuery.mockResolvedValueOnce([{ id: 7 }]);
    const id = await insertRestart({
      requestingDispatchId: "d-2",
      repo: "danxbot",
      reason: "rejected",
      outcome: "cross_repo",
      oldPid: null,
      startedAt: 1_700_000_000_000,
    });
    expect(id).toBe(7);
    expect(mockQuery.mock.calls[0][1][3]).toBe("cross_repo");
    expect(mockQuery.mock.calls[0][1][4]).toBeNull();
  });

  it("completeRestart updates completed_at + new_pid + outcome + duration", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await completeRestart({
      id: 42,
      outcome: "success",
      newPid: 5678,
      completedAt: 1_700_000_005_000,
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("UPDATE worker_restarts");
    expect(sql).toContain("duration_ms");
    // params = [completedAt, newPid, outcome, id]
    expect(params).toEqual([
      1_700_000_005_000,
      5678,
      "success",
      42,
    ]);
  });

  it("completeRestart writes health_timeout outcome with null new_pid", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await completeRestart({
      id: 99,
      outcome: "health_timeout",
      newPid: null,
      completedAt: 1_700_000_055_000,
    });
    expect(mockQuery.mock.calls[0][1][1]).toBeNull();
    expect(mockQuery.mock.calls[0][1][2]).toBe("health_timeout");
  });

  it("getLatestSuccessfulRestart returns row when present", async () => {
    const row = {
      id: 5,
      requesting_dispatch_id: "d-1",
      repo: "danxbot",
      reason: "x",
      outcome: "success",
      old_pid: 1,
      new_pid: 2,
      started_at: new Date(),
      completed_at: new Date(),
      duration_ms: 100,
    };
    mockQuery.mockResolvedValueOnce([row]);
    const result = await getLatestSuccessfulRestart("danxbot");
    expect(result).toEqual(row);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("outcome = 'success'");
    expect(params).toEqual(["danxbot"]);
  });

  it("getLatestSuccessfulRestart returns null when no rows", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await getLatestSuccessfulRestart("danxbot");
    expect(result).toBeNull();
  });
});
