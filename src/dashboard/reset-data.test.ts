import { describe, it, expect, beforeEach, vi } from "vitest";

const mockQuery = vi.fn();
const mockGetPool = vi.fn(() => ({
  query: mockQuery,
}));

vi.mock("../db/connection.js", () => ({
  getPool: () => mockGetPool(),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockClearSnapshotCache = vi.fn();
vi.mock("./dispatch-stream.js", () => ({
  clearDispatchSnapshotCache: (...args: unknown[]) =>
    mockClearSnapshotCache(...args),
}));

import { resetAllData, TABLES_TO_WIPE } from "./reset-data.js";

describe("resetAllData", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockClearSnapshotCache.mockReset();
  });

  it("exports a stable allowlist of tables to wipe", () => {
    expect(TABLES_TO_WIPE).toEqual([
      "dispatches",
      "threads",
      "events",
      "health_check",
    ]);
  });

  it("truncates exactly the allowlisted tables in order", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT")) return [[{ n: 0 }], []];
      return [{}, []];
    });

    const result = await resetAllData();

    expect(result.tablesCleared).toEqual([
      "dispatches",
      "threads",
      "events",
      "health_check",
    ]);
    const truncateSqls = mockQuery.mock.calls
      .map(([sql]) => sql as string)
      .filter((sql) => sql.startsWith("TRUNCATE"));
    expect(truncateSqls).toEqual([
      "TRUNCATE TABLE dispatches",
      "TRUNCATE TABLE threads",
      "TRUNCATE TABLE events",
      "TRUNCATE TABLE health_check",
    ]);
  });

  it("never queries users or api_tokens", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT")) return [[{ n: 0 }], []];
      return [{}, []];
    });

    await resetAllData();

    for (const call of mockQuery.mock.calls) {
      const sql = (call[0] as string).toLowerCase();
      expect(sql).not.toMatch(/\busers\b/);
      expect(sql).not.toMatch(/\bapi_tokens\b/);
    }
  });

  it("returns total row count summed across tables and per-table breakdown", async () => {
    const counts: Record<string, number> = {
      dispatches: 7,
      threads: 5,
      events: 10,
      health_check: 2,
    };
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT")) {
        const m = sql.match(/FROM (\w+)/);
        const table = m ? m[1] : "";
        return [[{ n: counts[table] ?? 0 }], []];
      }
      return [{}, []];
    });

    const result = await resetAllData();

    expect(result.rowsDeleted).toBe(24);
    expect(result.perTable).toEqual(counts);
  });

  it("clears the dispatch snapshot cache after truncating so SSE state is not stale", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT")) return [[{ n: 0 }], []];
      return [{}, []];
    });

    await resetAllData();

    expect(mockClearSnapshotCache).toHaveBeenCalledOnce();
  });

  it("counts rows BEFORE truncating each table", async () => {
    const ops: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      ops.push(sql);
      if (sql.startsWith("SELECT COUNT")) return [[{ n: 1 }], []];
      return [{}, []];
    });

    await resetAllData();

    // For each table, the SELECT COUNT must appear before the TRUNCATE
    for (const table of TABLES_TO_WIPE) {
      const countIdx = ops.indexOf(`SELECT COUNT(*) AS n FROM ${table}`);
      const truncateIdx = ops.indexOf(`TRUNCATE TABLE ${table}`);
      expect(countIdx).toBeGreaterThanOrEqual(0);
      expect(truncateIdx).toBeGreaterThanOrEqual(0);
      expect(countIdx).toBeLessThan(truncateIdx);
    }
  });
});
