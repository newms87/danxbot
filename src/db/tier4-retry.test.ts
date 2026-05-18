import { describe, expect, it, vi } from "vitest";
import {
  TIER_4_BUDGET_MS,
  TIER_4_INITIAL_DELAY_MS,
  TIER_4_MAX_DELAY_MS,
  tier4Retry,
} from "./tier4-retry.js";
import { isTransientPgError } from "./pg-retry.js";

function transientErr(msg = "Connection terminated due to connection timeout"): Error {
  return new Error(msg);
}

describe("tier4Retry envelope", () => {
  it("retries a transient failure and returns the eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientErr())
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await tier4Retry("test-success", fn, { sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("rethrows a non-transient error immediately without retry", async () => {
    const fatal = Object.assign(new Error("unique_violation"), { code: "23505" });
    const fn = vi.fn().mockRejectedValue(fatal);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(tier4Retry("test-fatal", fn, { sleep })).rejects.toBe(fatal);

    expect(fn).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows the last transient error once the budget elapses", async () => {
    let nowMs = 1_000;
    const now = vi.fn(() => nowMs);
    const sleep = vi.fn(async (ms: number) => {
      // Advance simulated clock past the Tier 4 budget on first sleep.
      nowMs += TIER_4_BUDGET_MS + ms;
    });
    const fn = vi.fn().mockRejectedValue(transientErr());

    await expect(
      tier4Retry("test-budget", fn, { sleep, now }),
    ).rejects.toMatchObject({ message: /Connection terminated/ });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("Tier 4 envelope constants match the documented user-facing-budget contract", () => {
    expect(TIER_4_BUDGET_MS).toBe(2_000);
    expect(TIER_4_INITIAL_DELAY_MS).toBe(100);
    expect(TIER_4_MAX_DELAY_MS).toBe(1_000);
  });
});

describe("helper invariant — production failure mode still classifies as transient", () => {
  it("isTransientPgError matches the prod connection-timeout message", () => {
    // The exact production string from the DX-616 incident — guard against
    // a future refactor accidentally dropping the message pattern.
    expect(
      isTransientPgError(
        new Error("Connection terminated due to connection timeout"),
      ),
    ).toBe(true);
  });
});
