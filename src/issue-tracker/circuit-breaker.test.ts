/**
 * Unit tests for the Trello circuit breaker (DX-300).
 *
 * State machine pin:
 *   - closed → open on first 429 with INITIAL_COOLDOWN_MS cooldown.
 *   - open elapses → half-open on next isOpen() check after openUntilMs.
 *   - half-open + 429 → open with doubled cooldown (cap 15min).
 *   - half-open + success → closed, cooldown reset to INITIAL.
 *   - Non-429 errors are no-ops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  TrelloCircuitOpen,
  _resetForTesting,
  _setNowForTesting,
  getState,
  is429,
  isOpen,
  openUntilMs,
  recordFailure,
  recordSuccess,
  setCircuitLogger,
} from "./circuit-breaker.js";

const noopLog = { info: vi.fn(), warn: vi.fn() };

describe("circuit-breaker", () => {
  let now = 0;

  beforeEach(() => {
    // RESET FIRST — `_resetForTesting` reinstates the default now-provider
    // and default no-op logger, so the test-specific overrides MUST come
    // after.
    _resetForTesting();
    now = 1_000_000;
    _setNowForTesting(() => now);
    noopLog.info.mockClear();
    noopLog.warn.mockClear();
    setCircuitLogger(noopLog);
  });

  afterEach(() => {
    _resetForTesting();
  });

  describe("is429", () => {
    it("matches the TrelloTracker wrapper's 429 message format", () => {
      const err = new Error(
        "Trello API error: 429 Too Many Requests (GET /cards/abc)",
      );
      expect(is429(err)).toBe(true);
    });

    it("does NOT match other Trello error codes", () => {
      expect(is429(new Error("Trello API error: 500 Server Error (GET /x)"))).toBe(false);
      expect(is429(new Error("Trello API error: 401 Unauthorized (GET /x)"))).toBe(false);
      expect(is429(new Error("Trello API error: 404 Not Found (GET /x)"))).toBe(false);
    });

    it("does NOT match generic network errors", () => {
      expect(is429(new Error("ECONNRESET"))).toBe(false);
      expect(is429(new Error("fetch failed"))).toBe(false);
    });
  });

  describe("default state", () => {
    it("starts closed", () => {
      expect(getState()).toBe("closed");
      expect(isOpen()).toBe(false);
      expect(openUntilMs()).toBe(0);
    });

    it("non-429 failures are no-ops while closed", () => {
      recordFailure(new Error("Trello API error: 500 Server Error (GET /x)"));
      expect(getState()).toBe("closed");
      expect(isOpen()).toBe(false);
    });
  });

  describe("closed → open on first 429", () => {
    it("trips to open with initial cooldown (60s)", () => {
      recordFailure(
        new Error("Trello API error: 429 Too Many Requests (GET /cards/abc)"),
      );
      expect(getState()).toBe("open");
      expect(isOpen()).toBe(true);
      expect(openUntilMs()).toBe(now + INITIAL_COOLDOWN_MS);
    });

    it("logs ONE open line on transition (not per subsequent 429)", () => {
      recordFailure(
        new Error("Trello API error: 429 Too Many Requests (GET /a)"),
        { endpoint: "GET /a" },
      );
      recordFailure(
        new Error("Trello API error: 429 Too Many Requests (GET /b)"),
        { endpoint: "GET /b" },
      );
      recordFailure(
        new Error("Trello API error: 429 Too Many Requests (GET /c)"),
        { endpoint: "GET /c" },
      );
      expect(noopLog.warn).toHaveBeenCalledTimes(1);
      expect(noopLog.warn.mock.calls[0]![0]).toMatch(/TrelloCircuit: opened.*60s.*GET \/a/);
    });
  });

  describe("open elapses → half-open", () => {
    it("isOpen() flips to false (half-open) once now >= openUntilMs", () => {
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /x)"));
      expect(isOpen()).toBe(true);
      now += INITIAL_COOLDOWN_MS;
      expect(isOpen()).toBe(false);
      expect(getState()).toBe("half-open");
    });

    it("isOpen() stays true strictly before openUntilMs", () => {
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /x)"));
      now += INITIAL_COOLDOWN_MS - 1;
      expect(isOpen()).toBe(true);
    });
  });

  describe("half-open + 429 → reopen with doubled cooldown", () => {
    it("60s → 120s → 240s → ... → cap 15min", () => {
      const expected = [
        INITIAL_COOLDOWN_MS,
        INITIAL_COOLDOWN_MS * 2,
        INITIAL_COOLDOWN_MS * 4,
        INITIAL_COOLDOWN_MS * 8,
        MAX_COOLDOWN_MS, // would be 16x = 960s but cap is 900s
        MAX_COOLDOWN_MS, // stays capped
        MAX_COOLDOWN_MS,
      ];
      // first failure: closed → open with INITIAL
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /1)"));
      expect(openUntilMs() - now).toBe(expected[0]);

      for (let i = 1; i < expected.length; i++) {
        const cooldown = openUntilMs() - now;
        now += cooldown; // advance past openUntilMs
        // confirm half-open
        expect(isOpen()).toBe(false);
        expect(getState()).toBe("half-open");
        recordFailure(
          new Error(`Trello API error: 429 Too Many Requests (GET /${i + 1})`),
        );
        expect(getState()).toBe("open");
        expect(openUntilMs() - now).toBe(expected[i]);
      }
    });

    it("logs one extension line per reopen", () => {
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /1)"));
      now += INITIAL_COOLDOWN_MS;
      expect(isOpen()).toBe(false); // half-open
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /2)"));
      // two log lines: initial open + extension
      expect(noopLog.warn).toHaveBeenCalledTimes(2);
      expect(noopLog.warn.mock.calls[1]![0]).toMatch(/TrelloCircuit: opened.*120s/);
    });
  });

  describe("half-open + success → closed with reset cooldown", () => {
    it("recordSuccess in half-open flips to closed", () => {
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /x)"));
      now += INITIAL_COOLDOWN_MS;
      expect(getState()).toBe("half-open");
      recordSuccess();
      expect(getState()).toBe("closed");
      expect(openUntilMs()).toBe(0);
    });

    it("cooldown resets to INITIAL after a recovery + re-trip", () => {
      // trip + extend twice
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /1)"));
      now += INITIAL_COOLDOWN_MS;
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /2)"));
      now += INITIAL_COOLDOWN_MS * 2;
      // half-open + success
      expect(getState()).toBe("half-open");
      recordSuccess();
      expect(getState()).toBe("closed");
      // next 429 → cooldown is back to INITIAL, not 4x
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /3)"));
      expect(openUntilMs() - now).toBe(INITIAL_COOLDOWN_MS);
    });

    it("logs a recovered line on close", () => {
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /x)"));
      now += INITIAL_COOLDOWN_MS;
      void isOpen(); // force half-open transition
      recordSuccess();
      expect(noopLog.info).toHaveBeenCalledTimes(1);
      expect(noopLog.info.mock.calls[0]![0]).toMatch(/TrelloCircuit: closed/);
    });
  });

  describe("recordSuccess in closed state", () => {
    it("is a safe no-op (no log, no state change)", () => {
      expect(getState()).toBe("closed");
      recordSuccess();
      expect(getState()).toBe("closed");
      expect(noopLog.info).not.toHaveBeenCalled();
    });
  });

  describe("non-429 in half-open", () => {
    it("does NOT extend cooldown or reopen", () => {
      recordFailure(new Error("Trello API error: 429 Too Many Requests (GET /x)"));
      now += INITIAL_COOLDOWN_MS;
      expect(getState()).toBe("half-open");
      recordFailure(new Error("Trello API error: 500 Server Error (GET /y)"));
      // still half-open — non-429 didn't reopen
      expect(getState()).toBe("half-open");
    });
  });

  describe("TrelloCircuitOpen error", () => {
    it("carries retryAtMs and an instanceof-friendly name", () => {
      const err = new TrelloCircuitOpen(123_456);
      expect(err.retryAtMs).toBe(123_456);
      expect(err.name).toBe("TrelloCircuitOpen");
      expect(err instanceof Error).toBe(true);
      expect(err instanceof TrelloCircuitOpen).toBe(true);
    });

    it("recordFailure ignores it (not a 429)", () => {
      const err = new TrelloCircuitOpen(now + 60_000);
      recordFailure(err);
      expect(getState()).toBe("closed");
    });
  });
});
