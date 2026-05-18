import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tier 4 (DX-637) per-site test for `tryDirectDbWrite`'s `pool.query`
 * wrap. Mocks the `pg` Pool so we can inject a transient pg failure on
 * the first attempt without booting a real Postgres. The other tests
 * in `danxbot-stop-fallback.test.ts` cover the real-pg semantics; this
 * file owns the synthetic-blip retry assertion.
 */

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => {
  class FakePool {
    constructor() {}
    query(...args: unknown[]) {
      return mockQuery(...args);
    }
    end() {
      return mockEnd();
    }
  }
  return { Pool: FakePool };
});

import { tryDirectDbWrite } from "./danxbot-stop-fallback.js";

const baseShape = {
  dispatchId: "tier4-dispatch",
  dbStatus: "completed" as const,
  summary: "ok",
};

const baseDb = {
  host: "127.0.0.1",
  port: 5432,
  user: "u",
  password: "p",
  database: "d",
};

beforeEach(() => {
  mockQuery.mockReset();
  mockEnd.mockClear();
});

describe("tryDirectDbWrite — Tier 4 retry envelope (DX-637)", () => {
  it("retries a transient pg failure and returns true on the recovered attempt", async () => {
    mockQuery
      .mockRejectedValueOnce(
        new Error("Connection terminated due to connection timeout"),
      )
      .mockResolvedValueOnce({ rowCount: 1 });

    const ok = await tryDirectDbWrite(baseShape, baseDb);

    expect(ok).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("returns false (not throw) when the retry budget elapses on persistent transient", async () => {
    // Make every attempt fail transient; tier4Retry's 2000ms budget
    // ensures we surface a thrown transient eventually — and the outer
    // try/catch in `tryDirectDbWrite` swallows the throw into `false`
    // so the fallback chain still progresses to the fs queue.
    mockQuery.mockRejectedValue(
      new Error("Connection terminated due to connection timeout"),
    );

    const ok = await tryDirectDbWrite(baseShape, baseDb);

    expect(ok).toBe(false);
    // At least 2 attempts: 1 initial + ≥1 retry within the budget.
    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
