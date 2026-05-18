import { describe, it, expect, vi } from "vitest";
import { isTransientPgError, retryTransient } from "./pg-retry.js";

describe("isTransientPgError", () => {
  it("matches pg-pool 'Connection terminated' plain Error (the production failure mode)", () => {
    const err = new Error("Connection terminated due to connection timeout");
    expect(isTransientPgError(err)).toBe(true);
  });

  it("matches Node socket codes (ECONNRESET, ETIMEDOUT, ECONNREFUSED)", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"]) {
      const err = Object.assign(new Error("boom"), { code });
      expect(isTransientPgError(err)).toBe(true);
    }
  });

  it("matches pg admin-shutdown SQLSTATE 57P01", () => {
    const err = Object.assign(new Error("terminating connection"), {
      code: "57P01",
    });
    expect(isTransientPgError(err)).toBe(true);
  });

  it("rejects schema / data errors (constraint violation, parse error)", () => {
    const constraint = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    expect(isTransientPgError(constraint)).toBe(false);

    const parse = Object.assign(new Error("syntax error at or near"), {
      code: "42601",
    });
    expect(isTransientPgError(parse)).toBe(false);
  });

  it("rejects non-Error values + arbitrary messages", () => {
    expect(isTransientPgError(null)).toBe(false);
    expect(isTransientPgError("Connection terminated")).toBe(false);
    expect(isTransientPgError(new Error("validation failed"))).toBe(false);
  });
});

describe("retryTransient", () => {
  it("returns immediately on success — no retries, no sleeps", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn();
    const result = await retryTransient(fn, { sleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient errors then resolves once the failure clears", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("Connection terminated due to connection timeout");
      }
      return "ok";
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const result = await retryTransient(fn, {
      sleep,
      onRetry,
      initialDelayMs: 10,
      maxDelayMs: 80,
      budgetMs: 60_000,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("rethrows fatal errors immediately (no retry)", async () => {
    const fatal = Object.assign(new Error("duplicate key"), { code: "23505" });
    const fn = vi.fn().mockRejectedValue(fatal);
    const sleep = vi.fn();
    await expect(retryTransient(fn, { sleep })).rejects.toBe(fatal);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows the last transient error when budgetMs elapses", async () => {
    let virtualNow = 0;
    const fn = vi
      .fn()
      .mockRejectedValue(new Error("Connection terminated"));
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      virtualNow += ms;
    });
    const now = () => virtualNow;
    await expect(
      retryTransient(fn, {
        sleep,
        now,
        initialDelayMs: 100,
        maxDelayMs: 100,
        budgetMs: 250,
      }),
    ).rejects.toThrow(/Connection terminated/);
    // 0 (start) → fn fails → sleep ~100 → fn fails → sleep ~100 →
    // fn fails @ virtualNow=200 < 250 → sleep ~100 → virtualNow=300 ≥ 250 →
    // fn fails final time → throw without sleeping again.
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("caps sleep at maxDelayMs even after many exponential doublings", async () => {
    let virtualNow = 0;
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts > 8) return "ok";
      throw new Error("Connection terminated");
    });
    const sleeps: number[] = [];
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      sleeps.push(ms);
      virtualNow += ms;
    });
    await retryTransient(fn, {
      sleep,
      now: () => virtualNow,
      initialDelayMs: 100,
      maxDelayMs: 500,
      budgetMs: 60_000,
    });
    for (const s of sleeps) {
      // ±20% jitter on the cap is allowed.
      expect(s).toBeLessThanOrEqual(500);
    }
  });
});
