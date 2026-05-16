/**
 * DX-565 (Phase 5): tests for `listRepairErrors`, `getRepairErrorDetail`,
 * `resetRepairError`, `markUnfixable`. Each helper is exercised against
 * a mock `db.query` (and for the transactional reset path, a mock
 * pool with `connect()` returning a mock client). Side-effects via
 * `publishRepairErrorUpdated` are stubbed at the module level so the
 * test isolates the SQL behavior from the SSE fan-out.
 */

import { describe, it, expect, vi } from "vitest";

import {
  listRepairErrors,
  getRepairErrorDetail,
  resetRepairError,
  markUnfixable,
} from "./db-reads.js";

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  connect?: ReturnType<typeof vi.fn>;
}

function mockPool(queryResults: object[][]): MockPool {
  const fn = vi.fn();
  for (const set of queryResults) fn.mockResolvedValueOnce({ rows: set });
  return { query: fn };
}

function errorRow(id: number, status: string = "open"): Record<string, unknown> {
  return {
    id,
    signature_hash: `h${id}`,
    category_key: "foo:Error",
    component: "foo",
    err_class: "Error",
    normalized_msg: "m",
    sample_payload: { raw_msg: "m" },
    count: 3,
    first_seen: new Date("2026-05-15T00:00:00Z"),
    last_seen: new Date("2026-05-15T00:00:00Z"),
    status,
    repo: "danxbot",
    recurrence_count: 0,
  };
}

function attemptRow(id: number, errorId: number, n: number): Record<string, unknown> {
  return {
    id,
    error_id: errorId,
    attempt_n: n,
    card_id: `DX-${600 + id}`,
    dispatch_id: `d${id}`,
    started_at: new Date(),
    ended_at: null,
    verdict: null,
    report_md: null,
  };
}

describe("listRepairErrors", () => {
  it("returns [] when no errors match", async () => {
    const db = mockPool([[]]);
    const result = await listRepairErrors({
      db: db as never,
      repo: "danxbot",
    });
    expect(result).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("filters by repo and orders count DESC, last_seen DESC", async () => {
    const db = mockPool([[]]);
    await listRepairErrors({ db: db as never, repo: "danxbot", limit: 50 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE repo = \$1/);
    expect(sql).toMatch(/ORDER BY count DESC, last_seen DESC/);
    expect(params).toEqual(["danxbot", 50]);
  });

  it("returns rows grouped with their attempt history", async () => {
    const db = mockPool([
      [errorRow(7, "repairing"), errorRow(9, "open")],
      [attemptRow(1, 7, 1), attemptRow(2, 7, 2), attemptRow(3, 9, 1)],
    ]);
    const result = await listRepairErrors({ db: db as never, repo: null });
    expect(result).toHaveLength(2);
    expect(result[0].error.id).toBe(7);
    expect(result[0].error.status).toBe("repairing");
    expect(result[0].attempts).toHaveLength(2);
    expect(result[0].attempts.map((a) => a.attempt_n)).toEqual([1, 2]);
    expect(result[1].error.id).toBe(9);
    expect(result[1].attempts).toHaveLength(1);
  });

  it("omits the repo filter when repo is null", async () => {
    const db = mockPool([[]]);
    await listRepairErrors({ db: db as never, repo: null, limit: 10 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/WHERE repo =/);
    expect(params).toEqual([10]);
  });

  it("returns empty attempts[] for an error with no repair history", async () => {
    const db = mockPool([[errorRow(11)], []]);
    const result = await listRepairErrors({ db: db as never, repo: "danxbot" });
    expect(result[0].attempts).toEqual([]);
  });

  it("throws on schema drift in the error status column", async () => {
    const db = mockPool([[errorRow(1, "weird-status")]]);
    await expect(
      listRepairErrors({ db: db as never, repo: "danxbot" }),
    ).rejects.toThrow(/unknown status/);
  });
});

describe("getRepairErrorDetail", () => {
  it("returns null when the id is missing", async () => {
    const db = mockPool([[]]);
    const result = await getRepairErrorDetail({ db: db as never, id: 999 });
    expect(result).toBeNull();
  });

  it("returns full {error, attempts} when found", async () => {
    const db = mockPool([
      [errorRow(7, "fixed")],
      [attemptRow(1, 7, 1), attemptRow(2, 7, 2)],
    ]);
    const result = await getRepairErrorDetail({ db: db as never, id: 7 });
    expect(result?.error.id).toBe(7);
    expect(result?.error.status).toBe("fixed");
    expect(result?.attempts).toHaveLength(2);
  });
});

describe("resetRepairError", () => {
  function txMockPool(steps: object[][]): MockPool {
    const fn = vi.fn();
    for (const set of steps) fn.mockResolvedValueOnce({ rows: set });
    return {
      // The function uses a connected client for transactions; the
      // `query` on the pool itself is unused.
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue({
        query: fn,
        release: vi.fn(),
      }),
    };
  }

  it("returns {kind: 'not-found'} when the id is missing", async () => {
    const db = txMockPool([
      [], // BEGIN
      [], // SELECT ... FOR UPDATE → empty
    ]);
    const result = await resetRepairError({ db: db as never, id: 999 });
    expect(result).toEqual({ kind: "not-found" });
  });

  it("clears attempts + flips status='open' on success, in SELECT-DELETE-UPDATE-COMMIT order", async () => {
    let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } | null = null;
    const fn = vi.fn();
    fn.mockResolvedValueOnce({ rows: [] }); // BEGIN
    fn.mockResolvedValueOnce({ rows: [errorRow(7, "unfixable")] }); // SELECT FOR UPDATE
    fn.mockResolvedValueOnce({ rows: [] }); // DELETE
    fn.mockResolvedValueOnce({ rows: [errorRow(7, "open")] }); // UPDATE
    fn.mockResolvedValueOnce({ rows: [] }); // COMMIT
    client = { query: fn, release: vi.fn() };
    const db = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client) };
    const result = await resetRepairError({ db: db as never, id: 7 });
    expect(result.kind).toBe("reset");
    if (result.kind === "reset") {
      expect(result.row.id).toBe(7);
      expect(result.row.status).toBe("open");
    }
    // The transactional ordering is load-bearing for race-prevention —
    // the docstring claims SELECT FOR UPDATE blocks a concurrent
    // dispatcher's flip and the DELETE runs before the status UPDATE.
    const sqls = fn.mock.calls.map((c) => String(c[0]).trim().split("\n")[0]);
    expect(sqls[0]).toMatch(/BEGIN/i);
    expect(sqls[1]).toMatch(/SELECT/i);
    expect(sqls[1]).toMatch(/FOR UPDATE/i);
    expect(sqls[2]).toMatch(/DELETE FROM system_error_repairs/);
    expect(sqls[3]).toMatch(/UPDATE system_errors SET status = 'open', recurrence_count = 0/);
    expect(sqls[4]).toMatch(/COMMIT/i);
    expect(client!.release).toHaveBeenCalled();
  });

  it("rolls back + releases the client when a mid-tx query throws", async () => {
    const fn = vi.fn();
    fn.mockResolvedValueOnce({ rows: [] }); // BEGIN
    fn.mockResolvedValueOnce({ rows: [errorRow(7, "unfixable")] }); // SELECT FOR UPDATE
    fn.mockRejectedValueOnce(new Error("DELETE failed")); // DELETE
    fn.mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    const release = vi.fn();
    const db = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue({ query: fn, release }),
    };
    await expect(
      resetRepairError({ db: db as never, id: 7 }),
    ).rejects.toThrow(/DELETE failed/);
    const sqls = fn.mock.calls.map((c) => String(c[0]).trim().split("\n")[0]);
    expect(sqls).toContain("ROLLBACK");
    expect(release).toHaveBeenCalled();
  });
});

describe("markUnfixable", () => {
  it("flips status='unfixable' on the row", async () => {
    const db = mockPool([[errorRow(11, "unfixable")]]);
    const result = await markUnfixable({ db: db as never, id: 11 });
    expect(result.kind).toBe("marked");
    if (result.kind === "marked") {
      expect(result.row.status).toBe("unfixable");
    }
  });

  it("returns {kind: 'not-found'} on no matching row", async () => {
    const db = mockPool([[]]);
    const result = await markUnfixable({ db: db as never, id: 999 });
    expect(result).toEqual({ kind: "not-found" });
  });
});
