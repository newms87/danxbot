/**
 * Unit tests for the per-agent + per-card quarantine cooldown map
 * (`src/dispatch/quarantine.ts`).
 *
 * AC #2 of DX-221 — replaces the deleted per-poller global backoff
 * window from the legacy poller-tick state.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const recordSpy = vi.fn();
vi.mock("../dashboard/system-errors.js", () => ({
  recordSystemError: (...args: unknown[]) => recordSpy(...args),
}));

import {
  _resetQuarantine,
  clearQuarantineForSuccess,
  DEFAULT_AGENT_QUARANTINE_MS,
  DEFAULT_CARD_QUARANTINE_MS,
  isAgentQuarantined,
  isCardQuarantined,
  quarantineAgent,
  quarantineCard,
} from "./quarantine.js";

describe("agent quarantine", () => {
  beforeEach(() => {
    _resetQuarantine();
    recordSpy.mockReset();
  });

  it("default agent cooldown is 60 seconds", () => {
    expect(DEFAULT_AGENT_QUARANTINE_MS).toBe(60_000);
  });

  it("default card cooldown is 5 minutes", () => {
    expect(DEFAULT_CARD_QUARANTINE_MS).toBe(5 * 60_000);
  });

  it("returns false for an un-quarantined agent", () => {
    expect(
      isAgentQuarantined({ repoName: "danxbot", agentName: "phil" }),
    ).toBe(false);
  });

  it("returns true after quarantine, false after expiry", () => {
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "transient",
      durationMs: 1_000,
      now: 1_000_000,
    });
    expect(
      isAgentQuarantined({
        repoName: "danxbot",
        agentName: "phil",
        now: 1_000_500,
      }),
    ).toBe(true);
    expect(
      isAgentQuarantined({
        repoName: "danxbot",
        agentName: "phil",
        now: 1_002_001,
      }),
    ).toBe(false);
  });

  it("isolates by repoName + agentName", () => {
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "x",
      now: 1_000_000,
    });
    expect(
      isAgentQuarantined({
        repoName: "danxbot",
        agentName: "murphy",
        now: 1_000_000,
      }),
    ).toBe(false);
    expect(
      isAgentQuarantined({
        repoName: "gpt-manager",
        agentName: "phil",
        now: 1_000_000,
      }),
    ).toBe(false);
  });

  it("extends the cooldown when a later expiry arrives", () => {
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "first",
      durationMs: 1_000,
      now: 1_000_000,
    });
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "second",
      durationMs: 5_000,
      now: 1_000_000,
    });
    expect(
      isAgentQuarantined({
        repoName: "danxbot",
        agentName: "phil",
        now: 1_004_500,
      }),
    ).toBe(true);
  });

  it("does NOT shorten the cooldown when an earlier expiry arrives", () => {
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "first",
      durationMs: 10_000,
      now: 1_000_000,
    });
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "second",
      durationMs: 1_000,
      now: 1_000_000,
    });
    expect(
      isAgentQuarantined({
        repoName: "danxbot",
        agentName: "phil",
        now: 1_005_000,
      }),
    ).toBe(true);
  });

  it("fires recordSystemError on first quarantine", () => {
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "transient claude-auth",
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const call = recordSpy.mock.calls[0][0];
    expect(call.source).toBe("quarantine");
    expect(call.severity).toBe("warn");
    expect(call.repo).toBe("danxbot");
    expect(call.message).toContain("phil");
    expect(call.details.reason).toContain("claude-auth");
  });

  it("does NOT fire recordSystemError when a shorter retry arrives during an active cooldown", () => {
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "first",
      durationMs: 10_000,
      now: 1_000_000,
    });
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "second",
      durationMs: 1_000,
      now: 1_000_000,
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });
});

describe("card quarantine", () => {
  beforeEach(() => {
    _resetQuarantine();
    recordSpy.mockReset();
  });

  it("isolates per-card", () => {
    quarantineCard({
      repoName: "danxbot",
      cardId: "DX-221",
      reason: "x",
      now: 1_000_000,
    });
    expect(
      isCardQuarantined({
        repoName: "danxbot",
        cardId: "DX-220",
        now: 1_000_000,
      }),
    ).toBe(false);
    expect(
      isCardQuarantined({
        repoName: "danxbot",
        cardId: "DX-221",
        now: 1_000_000,
      }),
    ).toBe(true);
  });

  it("fires recordSystemError with card source + details", () => {
    quarantineCard({
      repoName: "danxbot",
      cardId: "DX-221",
      reason: "stuck",
    });
    const call = recordSpy.mock.calls[0][0];
    expect(call.source).toBe("quarantine");
    expect(call.message).toContain("DX-221");
    expect(call.details.reason).toBe("stuck");
  });
});

describe("clearQuarantineForSuccess", () => {
  beforeEach(() => {
    _resetQuarantine();
    recordSpy.mockReset();
  });

  it("clears both agent and card cooldowns", () => {
    quarantineAgent({
      repoName: "danxbot",
      agentName: "phil",
      reason: "x",
      durationMs: 60_000,
      now: 1_000_000,
    });
    quarantineCard({
      repoName: "danxbot",
      cardId: "DX-221",
      reason: "x",
      durationMs: 60_000,
      now: 1_000_000,
    });
    clearQuarantineForSuccess({
      repoName: "danxbot",
      agentName: "phil",
      cardId: "DX-221",
    });
    expect(
      isAgentQuarantined({
        repoName: "danxbot",
        agentName: "phil",
        now: 1_000_000,
      }),
    ).toBe(false);
    expect(
      isCardQuarantined({
        repoName: "danxbot",
        cardId: "DX-221",
        now: 1_000_000,
      }),
    ).toBe(false);
  });

  it("does NOT clear unrelated entries", () => {
    quarantineAgent({
      repoName: "danxbot",
      agentName: "alice",
      reason: "x",
      now: 1_000_000,
    });
    clearQuarantineForSuccess({
      repoName: "danxbot",
      agentName: "phil",
      cardId: "DX-221",
    });
    expect(
      isAgentQuarantined({
        repoName: "danxbot",
        agentName: "alice",
        now: 1_000_000,
      }),
    ).toBe(true);
  });
});
