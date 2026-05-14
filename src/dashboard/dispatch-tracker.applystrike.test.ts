/**
 * DX-365 — `applyStrike` shared wrapper. Lives in dispatch-tracker.ts
 * because the live-spawn finalize is its first caller, but is exported
 * so `worker/reattach.ts#buildReattachTracker` and
 * `worker/dispatch.ts#handleStopFromDb` reuse the same skip-condition
 * tree and error-swallow contract.
 *
 * Coverage focus:
 *   - Four skip guards (null `repoLocalPath`, null `agentName`,
 *     null `issueId`, non-strike status) — each guard short-circuits
 *     BEFORE `recordStrike` is called.
 *   - `STRIKE_RAW_ERROR_MAX = 200` slice cap on `rawError`.
 *   - Swallow-on-throw — a `recordStrike` error MUST NOT propagate
 *     out of `applyStrike` (the dispatch row already finalized; the
 *     SSE publish must still fire).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/strikes.js", () => ({
  recordStrike: vi.fn(),
  // The wrapper only consumes `recordStrike` + `isStrikeEligible` from
  // the strikes module. `isStrikeEligible` is pure; we use the real
  // implementation by re-exporting from the actual module below in the
  // factory. Vitest hoists vi.mock so re-importing here would deadlock —
  // inline the small enum check instead.
  isStrikeEligible: (s: string) =>
    s === "failed" || s === "recovered" || s === "throttled",
}));

import { applyStrike } from "./dispatch-tracker.js";
import { recordStrike } from "../agent/strikes.js";

const recordStrikeMock = vi.mocked(recordStrike);

const baseArgs = {
  status: "failed" as const,
  repoLocalPath: "/tmp/repo",
  repoName: "myrepo",
  agentName: "alice",
  dispatchId: "dispatch-1",
  issueId: "DX-100",
  rawError: "boom",
  timestampIso: "2026-05-14T01:00:00Z",
};

describe("applyStrike — wrapper contract", () => {
  beforeEach(() => {
    recordStrikeMock.mockReset();
    recordStrikeMock.mockResolvedValue({
      count: 1,
      brokenTransitionEmitted: false,
    });
  });
  afterEach(() => {
    recordStrikeMock.mockReset();
  });

  describe("skip guards", () => {
    it("skips when repoLocalPath is null", async () => {
      await applyStrike({ ...baseArgs, repoLocalPath: null });
      expect(recordStrikeMock).not.toHaveBeenCalled();
    });

    it("skips when agentName is null", async () => {
      await applyStrike({ ...baseArgs, agentName: null });
      expect(recordStrikeMock).not.toHaveBeenCalled();
    });

    it("skips when issueId is null", async () => {
      await applyStrike({ ...baseArgs, issueId: null });
      expect(recordStrikeMock).not.toHaveBeenCalled();
    });

    it("skips when status is non-strike — completed", async () => {
      await applyStrike({ ...baseArgs, status: "completed" });
      expect(recordStrikeMock).not.toHaveBeenCalled();
    });

    it("skips when status is non-strike — cancelled", async () => {
      await applyStrike({ ...baseArgs, status: "cancelled" });
      expect(recordStrikeMock).not.toHaveBeenCalled();
    });
  });

  describe("happy path", () => {
    it.each(["failed", "recovered", "throttled"] as const)(
      "calls recordStrike for %s with the full input + deps",
      async (status) => {
        await applyStrike({ ...baseArgs, status });
        expect(recordStrikeMock).toHaveBeenCalledTimes(1);
        const [input, deps] = recordStrikeMock.mock.calls[0];
        expect(input).toEqual({
          dispatchId: "dispatch-1",
          issueId: "DX-100",
          terminalStatus: status,
          rawError: "boom",
          timestamp: "2026-05-14T01:00:00Z",
        });
        expect(deps).toEqual({
          localPath: "/tmp/repo",
          repoName: "myrepo",
          agentName: "alice",
        });
      },
    );
  });

  describe("rawError slice cap (STRIKE_RAW_ERROR_MAX = 200)", () => {
    it("truncates oversized rawError to 200 chars", async () => {
      const longError = "x".repeat(500);
      await applyStrike({ ...baseArgs, rawError: longError });
      expect(recordStrikeMock).toHaveBeenCalledTimes(1);
      const [input] = recordStrikeMock.mock.calls[0];
      expect(input.rawError).toHaveLength(200);
      expect(input.rawError).toBe("x".repeat(200));
    });

    it("treats null rawError as empty string", async () => {
      await applyStrike({ ...baseArgs, rawError: null });
      const [input] = recordStrikeMock.mock.calls[0];
      expect(input.rawError).toBe("");
    });
  });

  describe("swallow-on-throw", () => {
    it("does NOT propagate when recordStrike rejects — finalize must keep going so the SSE publish fires", async () => {
      recordStrikeMock.mockRejectedValueOnce(new Error("settings IO failed"));
      // No try/catch here — applyStrike's internal catch must own the
      // failure. If this assertion ever needs `expect().rejects`, the
      // wrapper has regressed and the dashboard will silently freeze.
      await expect(applyStrike({ ...baseArgs })).resolves.toBeUndefined();
    });

    it("does NOT propagate sync throws either", async () => {
      recordStrikeMock.mockImplementationOnce(() => {
        throw new Error("sync boom");
      });
      await expect(applyStrike({ ...baseArgs })).resolves.toBeUndefined();
    });
  });
});
