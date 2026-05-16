/**
 * Tests for {@link getDispatchCandidate} / {@link getPriorAttempts} /
 * {@link insertRepairAttempt} / {@link setRepairAttemptCard} /
 * {@link flipErrorStatus}. Each helper is a thin wrapper over a single
 * SQL statement — tests assert the SQL the helper runs against a mock
 * `db.query`, not against a real Postgres pool. The integration test in
 * `self-repair-dispatch.integration.test.ts` exercises the full chain
 * against a live `system_errors` + `system_error_repairs` schema.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// DX-565: spy on the SSE fan-out — the helpers MUST publish post-write
// for the Self-Repair tab to live-update.
const { publishSpy } = vi.hoisted(() => ({ publishSpy: vi.fn() }));
vi.mock("./publish.js", () => ({
  publishRepairErrorUpdated: publishSpy,
}));

import {
  getDispatchCandidate,
  getPriorAttempts,
  insertRepairAttempt,
  setRepairAttemptCard,
  flipErrorStatus,
} from "./dispatch-pick.js";
import type { SystemErrorRow, SystemErrorRepairRow } from "./types.js";

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function mockPool(rows: object[][]): MockPool {
  const fn = vi.fn();
  for (const set of rows) fn.mockResolvedValueOnce({ rows: set });
  return { query: fn };
}

describe("getDispatchCandidate", () => {
  it("returns null when no candidate found", async () => {
    const db = mockPool([[]]);
    const result = await getDispatchCandidate({ db: db as any, repo: "danxbot", threshold: 3 });
    expect(result).toBeNull();
  });

  it("filters by repo, status=open, count >= threshold, < 3 attempts, no live attempt; orders by count DESC", async () => {
    const db = mockPool([[]]);
    await getDispatchCandidate({ db: db as any, repo: "danxbot", threshold: 5 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/FROM system_errors/);
    expect(sql).toMatch(/e\.repo = \$1/);
    expect(sql).toMatch(/e\.status = 'open'/);
    expect(sql).toMatch(/e\.count >= \$2/);
    expect(sql).toMatch(/COUNT\(\*\) FROM system_error_repairs/);
    expect(sql).toMatch(/< \$3/);
    expect(sql).toMatch(/r2\.ended_at IS NULL/);
    expect(sql).toMatch(/ORDER BY e\.count DESC, e\.last_seen DESC/);
    expect(sql).toMatch(/LIMIT 1/);
    // 3rd param is REPAIR_CAP from types.ts (currently 3 — DX-566).
    expect(params).toEqual(["danxbot", 5, 3]);
  });

  it("returns the row when one matches", async () => {
    const row = {
      id: 7, signature_hash: "h", category_key: "k", component: "c", err_class: "E",
      normalized_msg: "m", sample_payload: { raw_msg: "m" }, count: 5,
      first_seen: new Date(), last_seen: new Date(), status: "open", repo: "danxbot",
    };
    const db = mockPool([[row]]);
    const result = await getDispatchCandidate({ db: db as any, repo: "danxbot", threshold: 3 });
    expect(result?.id).toBe(7);
    expect(result?.status).toBe("open");
  });

  it("throws on unknown status value (schema drift)", async () => {
    const db = mockPool([[{ id: 1, signature_hash: "h", category_key: "k", component: "c", err_class: "E", normalized_msg: "m", sample_payload: {}, count: 1, first_seen: new Date(), last_seen: new Date(), status: "weird", repo: "r" }]]);
    await expect(getDispatchCandidate({ db: db as any, repo: "r", threshold: 1 })).rejects.toThrow(/unknown status/);
  });
});

describe("getPriorAttempts", () => {
  it("returns all attempts for an error_id in ascending attempt_n order", async () => {
    const db = mockPool([[
      { id: 1, error_id: 7, attempt_n: 1, card_id: "DX-700", dispatch_id: "d1", started_at: new Date(), ended_at: new Date(), verdict: "failed", report_md: "x" },
      { id: 2, error_id: 7, attempt_n: 2, card_id: "DX-701", dispatch_id: "d2", started_at: new Date(), ended_at: null, verdict: null, report_md: null },
    ]]);
    const result = await getPriorAttempts({ db: db as any, errorId: 7 });
    expect(result).toHaveLength(2);
    expect(result[0].attempt_n).toBe(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/FROM system_error_repairs/);
    expect(sql).toMatch(/error_id = \$1/);
    expect(sql).toMatch(/ORDER BY attempt_n ASC/);
    expect(params).toEqual([7]);
  });
});

describe("insertRepairAttempt", () => {
  it("inserts with error_id + attempt_n + started_at; returns the new row id", async () => {
    const db = mockPool([[{ id: 42, error_id: 7, attempt_n: 3, card_id: null, dispatch_id: null, started_at: new Date(), ended_at: null, verdict: null, report_md: null }]]);
    const row = await insertRepairAttempt({ db: db as any, errorId: 7, attemptN: 3 });
    expect(row.id).toBe(42);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO system_error_repairs/);
    expect(sql).toMatch(/RETURNING/);
    expect(params).toEqual([7, 3]);
  });
});

describe("setRepairAttemptCard", () => {
  it("updates card_id for the given attempt id", async () => {
    const db = mockPool([[{ error_id: 99 }]]);
    await setRepairAttemptCard({ db: db as any, attemptId: 42, cardId: "DX-700" });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE system_error_repairs/);
    expect(sql).toMatch(/SET card_id = \$1/);
    expect(sql).toMatch(/WHERE id = \$2/);
    expect(sql).toMatch(/RETURNING error_id/);
    expect(params).toEqual(["DX-700", 42]);
  });

  it("DX-565: publishes the post-write snapshot for the linked error", async () => {
    publishSpy.mockReset();
    const db = mockPool([[{ error_id: 99 }]]);
    await setRepairAttemptCard({ db: db as any, attemptId: 42, cardId: "DX-700" });
    expect(publishSpy).toHaveBeenCalledWith({ db: expect.anything(), errorId: 99 });
  });

  it("DX-565: skips publish when the attempt id has no matching row", async () => {
    publishSpy.mockReset();
    const db = mockPool([[]]);
    await setRepairAttemptCard({ db: db as any, attemptId: 9999, cardId: "DX-700" });
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

describe("flipErrorStatus", () => {
  beforeEach(() => publishSpy.mockReset());

  it("flips the system_errors row to the new status", async () => {
    const db = mockPool([[]]);
    await flipErrorStatus({ db: db as any, errorId: 7, status: "repairing" });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE system_errors/);
    expect(sql).toMatch(/SET status = \$1/);
    expect(sql).toMatch(/WHERE id = \$2/);
    expect(params).toEqual(["repairing", 7]);
  });

  it("DX-565: publishes the post-flip snapshot", async () => {
    const db = mockPool([[]]);
    await flipErrorStatus({ db: db as any, errorId: 7, status: "repairing" });
    expect(publishSpy).toHaveBeenCalledWith({ db: expect.anything(), errorId: 7 });
  });
});
