import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("./connection.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { checkDbConnection } from "./health.js";

describe("checkDbConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when DB responds", async () => {
    mockQuery.mockResolvedValue([]);

    const result = await checkDbConnection();

    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith("SELECT 1");
  });

  it("returns false when DB query rejects", async () => {
    mockQuery.mockRejectedValue(new Error("Connection refused"));

    const result = await checkDbConnection();

    expect(result).toBe(false);
  });

  it("returns false when DB query times out", async () => {
    vi.useFakeTimers();
    mockQuery.mockImplementation(() => new Promise(() => {})); // never resolves

    const promise = checkDbConnection();
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(result).toBe(false);
    vi.useRealTimers();
  });
});
