/**
 * DX-652 — unit tests for the self-repair finalize hook.
 *
 * Pure-helper tests cover the verdict parser + cap-mapping. The
 * `finalizeRepairByDispatchId` integration-style cases drive a fake
 * pool that records every SQL invocation so we can assert the
 * transactional shape (BEGIN/SELECT/UPDATE/UPDATE/COMMIT) without
 * standing up Postgres.
 */

import { describe, it, expect, vi } from "vitest";

import {
  finalizeRepairByDispatchId,
  nextErrorStatus,
  parseRepairVerdict,
} from "./finalize-by-dispatch-id.js";
import { REPAIR_CAP } from "./types.js";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

interface FakePool {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

interface LookupRow {
  id: number;
  error_id: number;
  attempt_n: number;
}

function makePool(lookupRows: LookupRow[]): {
  pool: FakePool;
  client: FakeClient;
  calls: { sql: string; params: unknown[] | undefined }[];
} {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  const client: FakeClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/SELECT id, error_id, attempt_n\s/.test(sql)) {
        return { rows: lookupRows, rowCount: lookupRows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool: FakePool = {
    connect: vi.fn(async () => client),
    query: vi.fn(),
  };
  return { pool, client, calls };
}

describe("parseRepairVerdict", () => {
  it("recognizes the `fixed:` prefix (case-insensitive, with surrounding whitespace)", () => {
    expect(parseRepairVerdict("fixed: rolled the schema bump", "completed"))
      .toBe("fixed");
    expect(parseRepairVerdict("  FIXED:   x", "completed")).toBe("fixed");
  });

  it("recognizes the `unfixable:` prefix", () => {
    expect(parseRepairVerdict("unfixable: requires schema migration", "completed"))
      .toBe("unfixable");
  });

  it("recognizes the `failed:` prefix", () => {
    expect(parseRepairVerdict("failed: could not reproduce in worktree", "completed"))
      .toBe("failed");
  });

  it("defaults to `failed` when no recognized prefix on a completed terminal", () => {
    expect(parseRepairVerdict("Patched the bug", "completed")).toBe("failed");
  });

  it("defaults to `failed` when no recognized prefix on a failed terminal", () => {
    expect(parseRepairVerdict("crashed mid-run", "failed")).toBe("failed");
  });

  it("treats empty / null / undefined summary as `failed`", () => {
    expect(parseRepairVerdict("", "completed")).toBe("failed");
    expect(parseRepairVerdict(null, "completed")).toBe("failed");
    expect(parseRepairVerdict(undefined, "completed")).toBe("failed");
  });
});

describe("nextErrorStatus", () => {
  it("verdict=fixed → 'fixed'", () => {
    expect(nextErrorStatus("fixed", 1)).toBe("fixed");
    expect(nextErrorStatus("fixed", REPAIR_CAP)).toBe("fixed");
  });

  it("verdict=unfixable → 'unfixable'", () => {
    expect(nextErrorStatus("unfixable", 1)).toBe("unfixable");
  });

  it("verdict=failed below cap → 'open' (next tick may retry)", () => {
    expect(nextErrorStatus("failed", 1)).toBe("open");
    expect(nextErrorStatus("failed", REPAIR_CAP - 1)).toBe("open");
  });

  it("verdict=failed at/over cap → 'unfixable'", () => {
    expect(nextErrorStatus("failed", REPAIR_CAP)).toBe("unfixable");
    expect(nextErrorStatus("failed", REPAIR_CAP + 5)).toBe("unfixable");
  });
});

describe("finalizeRepairByDispatchId", () => {
  function commonInput(opts: {
    pool: FakePool;
    dispatchId?: string;
    summary?: string | null;
    terminalStatus?: "completed" | "failed";
  }) {
    return {
      db: opts.pool as never,
      dispatchId: opts.dispatchId ?? "d-1",
      summary: opts.summary ?? "fixed: ok",
      terminalStatus: opts.terminalStatus ?? ("completed" as const),
      publish: vi.fn(),
      now: () => new Date("2026-05-18T17:00:00Z"),
    };
  }

  it("returns finalized=false when no system_error_repairs row matches dispatch_id", async () => {
    const { pool, client } = makePool([]);
    const input = commonInput({ pool });
    const result = await finalizeRepairByDispatchId(input);

    expect(result).toEqual({ finalized: false });
    // BEGIN + SELECT + ROLLBACK — never reaches the UPDATE pair.
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /BEGIN/.test(s))).toBe(true);
    expect(sqls.some((s) => /ROLLBACK/.test(s))).toBe(true);
    expect(sqls.some((s) => /^UPDATE system_error_repairs/.test(s.trim())))
      .toBe(false);
    expect(sqls.some((s) => /^UPDATE system_errors/.test(s.trim())))
      .toBe(false);
    expect(input.publish).not.toHaveBeenCalled();
  });

  it("`fixed:` summary → status='fixed', verdict='fixed', ended_at stamped", async () => {
    const { pool, calls } = makePool([
      { id: 11, error_id: 22, attempt_n: 1 },
    ]);
    const input = commonInput({
      pool,
      summary: "fixed: rolled the migration",
      terminalStatus: "completed",
    });
    const result = await finalizeRepairByDispatchId(input);

    expect(result).toEqual({
      finalized: true,
      verdict: "fixed",
      errorId: 22,
      errorStatus: "fixed",
      attemptN: 1,
    });
    const repairUpdate = calls.find((c) =>
      /UPDATE system_error_repairs/.test(c.sql),
    );
    expect(repairUpdate?.params?.[0]).toEqual(new Date("2026-05-18T17:00:00Z"));
    expect(repairUpdate?.params?.[1]).toBe("fixed");
    expect(repairUpdate?.params?.[2]).toBe("fixed: rolled the migration");
    expect(repairUpdate?.params?.[3]).toBe(11);

    const errorUpdate = calls.find((c) => /UPDATE system_errors/.test(c.sql));
    expect(errorUpdate?.params).toEqual(["fixed", 22]);

    expect(input.publish).toHaveBeenCalledWith(pool, 22);
  });

  it("`unfixable:` summary → status='unfixable', verdict='unfixable'", async () => {
    const { pool, calls } = makePool([
      { id: 12, error_id: 23, attempt_n: 2 },
    ]);
    const input = commonInput({
      pool,
      summary: "unfixable: requires manual schema migration",
    });
    const result = await finalizeRepairByDispatchId(input);

    expect(result.verdict).toBe("unfixable");
    expect(result.errorStatus).toBe("unfixable");
    const errorUpdate = calls.find((c) => /UPDATE system_errors/.test(c.sql));
    expect(errorUpdate?.params).toEqual(["unfixable", 23]);
  });

  it("`failed:` summary at attempt_n < REPAIR_CAP → status='open', verdict='failed'", async () => {
    const { pool, calls } = makePool([
      { id: 13, error_id: 24, attempt_n: REPAIR_CAP - 1 },
    ]);
    const result = await finalizeRepairByDispatchId(
      commonInput({
        pool,
        summary: "failed: stack still throws on reset path",
        terminalStatus: "failed",
      }),
    );

    expect(result.verdict).toBe("failed");
    expect(result.errorStatus).toBe("open");
    const errorUpdate = calls.find((c) => /UPDATE system_errors/.test(c.sql));
    expect(errorUpdate?.params).toEqual(["open", 24]);
  });

  it("`failed:` summary at attempt_n = REPAIR_CAP → status='unfixable' (cap exhausted)", async () => {
    const { pool, calls } = makePool([
      { id: 14, error_id: 25, attempt_n: REPAIR_CAP },
    ]);
    const result = await finalizeRepairByDispatchId(
      commonInput({
        pool,
        summary: "failed: exhausted the retry budget",
        terminalStatus: "failed",
      }),
    );

    expect(result.verdict).toBe("failed");
    expect(result.errorStatus).toBe("unfixable");
    const errorUpdate = calls.find((c) => /UPDATE system_errors/.test(c.sql));
    expect(errorUpdate?.params).toEqual(["unfixable", 25]);
  });

  it("plain-text summary on terminalStatus='completed' → default verdict='failed', cap rules apply", async () => {
    const { pool } = makePool([
      { id: 15, error_id: 26, attempt_n: 1 },
    ]);
    const result = await finalizeRepairByDispatchId(
      commonInput({
        pool,
        summary: "Patched the issue but did not use the prefix convention",
        terminalStatus: "completed",
      }),
    );
    expect(result.verdict).toBe("failed");
    expect(result.errorStatus).toBe("open");
  });

  it("plain-text summary on terminalStatus='failed' → default verdict='failed', cap rules apply", async () => {
    const { pool } = makePool([
      { id: 16, error_id: 27, attempt_n: REPAIR_CAP },
    ]);
    const result = await finalizeRepairByDispatchId(
      commonInput({
        pool,
        summary: "crashed mid-rebase",
        terminalStatus: "failed",
      }),
    );
    expect(result.verdict).toBe("failed");
    expect(result.errorStatus).toBe("unfixable");
  });

  it("commits inside a single transaction (BEGIN → ... → COMMIT, no ROLLBACK on the success path)", async () => {
    const { pool, client } = makePool([
      { id: 17, error_id: 28, attempt_n: 1 },
    ]);
    await finalizeRepairByDispatchId(
      commonInput({ pool, summary: "fixed: done" }),
    );
    const order = client.query.mock.calls.map((c) => (c[0] as string).trim().split(/\s+/)[0]);
    expect(order[0]).toBe("BEGIN");
    expect(order).toContain("COMMIT");
    expect(order).not.toContain("ROLLBACK");
  });

  it("releases the client on the no-op path and on the success path", async () => {
    const noopCase = makePool([]);
    await finalizeRepairByDispatchId(
      commonInput({ pool: noopCase.pool }),
    );
    expect(noopCase.client.release).toHaveBeenCalledTimes(1);

    const successCase = makePool([
      { id: 18, error_id: 29, attempt_n: 1 },
    ]);
    await finalizeRepairByDispatchId(
      commonInput({ pool: successCase.pool, summary: "fixed: ok" }),
    );
    expect(successCase.client.release).toHaveBeenCalledTimes(1);
  });

  it("parser-wins: `fixed:` prefix on terminalStatus='failed' still yields verdict='fixed'", async () => {
    // Cross-pair guard. If the dispatch row ended `failed` (e.g. the
    // worker timed it out) but the agent's summary STILL declares
    // `fixed:`, the agent's intent wins — the verdict parser does not
    // re-route to `failed` based on the terminal status.
    const { pool, calls } = makePool([
      { id: 20, error_id: 31, attempt_n: 1 },
    ]);
    const result = await finalizeRepairByDispatchId(
      commonInput({
        pool,
        summary: "fixed: applied the migration before crashing on cleanup",
        terminalStatus: "failed",
      }),
    );
    expect(result.verdict).toBe("fixed");
    expect(result.errorStatus).toBe("fixed");
    const errorUpdate = calls.find((c) => /UPDATE system_errors/.test(c.sql));
    expect(errorUpdate?.params).toEqual(["fixed", 31]);
  });

  it("second call with the same dispatch_id is idempotent by VALUE (re-stamps the same deterministic verdict + errorStatus)", async () => {
    // Pinned per header — idempotency is not status-guarded; the
    // SELECT re-finds the row, both UPDATEs re-fire, and the values
    // land identically because `nextErrorStatus(verdict, attempt_n)`
    // is pure on the persisted attempt_n. SSE publish does re-fire
    // — subscribers MUST be idempotent.
    const lookup = { id: 21, error_id: 32, attempt_n: 1 };
    const { pool: pool1 } = makePool([lookup]);
    const input1 = commonInput({
      pool: pool1,
      summary: "fixed: locked in",
      terminalStatus: "completed",
    });
    const r1 = await finalizeRepairByDispatchId(input1);

    const { pool: pool2 } = makePool([lookup]);
    const input2 = commonInput({
      pool: pool2,
      summary: "fixed: locked in",
      terminalStatus: "completed",
    });
    const r2 = await finalizeRepairByDispatchId(input2);

    expect(r1).toEqual(r2);
    expect(r1.finalized).toBe(true);
    expect(r2.finalized).toBe(true);
    expect(input1.publish).toHaveBeenCalledWith(pool1, 32);
    expect(input2.publish).toHaveBeenCalledWith(pool2, 32);
  });

  it("rolls back + releases the client when an UPDATE throws", async () => {
    const calls: { sql: string }[] = [];
    const client: FakeClient = {
      query: vi.fn(async (sql: string) => {
        calls.push({ sql });
        if (/SELECT id, error_id, attempt_n\s/.test(sql)) {
          return {
            rows: [{ id: 19, error_id: 30, attempt_n: 1 }],
            rowCount: 1,
          };
        }
        if (/^UPDATE system_error_repairs/.test(sql.trim())) {
          throw new Error("boom");
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool: FakePool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    };
    await expect(
      finalizeRepairByDispatchId({
        db: pool as never,
        dispatchId: "d-x",
        summary: "fixed: ok",
        terminalStatus: "completed",
        publish: vi.fn(),
        now: () => new Date(),
      }),
    ).rejects.toThrow(/boom/);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.sql).some((s) => /ROLLBACK/.test(s))).toBe(true);
  });
});
