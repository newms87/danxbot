import { describe, it, expect, beforeEach, vi } from "vitest";
import { PassThrough } from "node:stream";

const mockResetAllData = vi.fn();
vi.mock("../dashboard/reset-data.js", () => ({
  resetAllData: (...args: unknown[]) => mockResetAllData(...args),
}));

const mockClosePool = vi.fn();
vi.mock("../db/connection.js", () => ({
  closePool: (...args: unknown[]) => mockClosePool(...args),
}));

import { runCli } from "./reset-data.js";

function collect(stream: PassThrough): string {
  return (stream.read() as Buffer | null)?.toString() ?? "";
}

describe("reset-data CLI", () => {
  beforeEach(() => {
    mockResetAllData.mockReset();
    mockClosePool.mockReset();
  });

  it("prints a human summary and exits 0 on success", async () => {
    mockResetAllData.mockResolvedValueOnce({
      tablesCleared: ["dispatches", "threads", "events", "health_check"],
      rowsDeleted: 42,
      perTable: {
        dispatches: 10,
        threads: 5,
        events: 25,
        health_check: 2,
      },
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const code = await runCli(stdout, stderr);

    expect(code).toBe(0);
    const out = collect(stdout);
    expect(out).toContain("42 row(s) deleted across 4 table(s)");
    expect(out).toContain("dispatches");
    expect(out).toContain("10");
    expect(out).toContain("health_check");
    expect(mockClosePool).toHaveBeenCalledOnce();
  });

  it("exits 1 and writes to stderr on failure", async () => {
    mockResetAllData.mockRejectedValueOnce(new Error("db unreachable"));
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const code = await runCli(stdout, stderr);

    expect(code).toBe(1);
    expect(collect(stderr)).toContain("db unreachable");
    expect(mockClosePool).toHaveBeenCalledOnce();
  });
});
