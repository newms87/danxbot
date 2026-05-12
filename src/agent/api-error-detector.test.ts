import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ApiErrorDetector,
  classifyApiError,
  parseRateLimitResume,
  type ApiErrorInfo,
  type EntryConsumer,
  type WatcherLike,
} from "./api-error-detector.js";
import type { AgentLogEntry } from "../types.js";

/**
 * Unit tests for ApiErrorDetector (DX-259 / Phase 1 of DX-246). The detector
 * watches `SessionLogWatcher` entries for the synthetic API-error JSONL pair
 * Claude Code emits when the Anthropic stream times out mid-turn. The 5s
 * confirmation window protects against transient API-recover-on-its-own
 * cases by waiting before firing the recover handler. Idempotency is keyed
 * to the recover-count epoch so the same chain never fires twice without an
 * explicit retry.
 *
 * Tests use `vi.useFakeTimers()` so the 5s window is deterministic and the
 * suite runs in milliseconds. The mock watcher is a tiny `EntryConsumer`
 * registry — the real watcher's polling loop is irrelevant for the
 * detector's behavior, only the entries it forwards.
 */

class MockWatcher implements WatcherLike {
  private consumers: EntryConsumer[] = [];

  onEntry(consumer: EntryConsumer): void {
    this.consumers.push(consumer);
  }

  /** Test helper — push an entry to every registered consumer. */
  emit(entry: AgentLogEntry): void {
    for (const consumer of this.consumers) consumer(entry);
  }

  /** For introspection in tests that assert subscription happened once. */
  consumerCount(): number {
    return this.consumers.length;
  }
}

function syntheticByFlag(): AgentLogEntry {
  // Surface form 1 — `isApiErrorMessage: true` flag.
  return {
    timestamp: Date.now(),
    type: "assistant",
    summary: "synthetic-api-error",
    data: {
      messageId: "msg-flag",
      content: [{ type: "text", text: "API Error: Stream idle timeout" }],
      raw: {
        isApiErrorMessage: true,
        message: {
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "API Error: Stream idle timeout" }],
        },
      },
    },
  };
}

function syntheticByModel(): AgentLogEntry {
  // Surface form 2 — `model: "<synthetic>"` + `/API Error/i` text.
  return {
    timestamp: Date.now(),
    type: "assistant",
    summary: "synthetic-api-error-by-model",
    data: {
      messageId: "msg-model",
      content: [{ type: "text", text: "API error: Stream idle timeout" }],
      raw: {
        message: {
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          content: [
            { type: "text", text: "API error: Stream idle timeout" },
          ],
        },
      },
    },
  };
}

function realAssistant(): AgentLogEntry {
  return {
    timestamp: Date.now(),
    type: "assistant",
    summary: "real assistant turn",
    data: {
      messageId: "msg-real",
      content: [{ type: "text", text: "Sure, I'll do that." }],
      raw: {
        message: {
          model: "claude-opus-4-7",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Sure, I'll do that." }],
        },
      },
    },
  };
}

function syntheticSidechain(): AgentLogEntry {
  // Sub-agent (sidechain) synthetic error — must be ignored.
  return {
    timestamp: Date.now(),
    type: "assistant",
    summary: "sidechain-api-error",
    data: {
      messageId: "msg-sidechain",
      subagent_id: "agent-abc",
      raw: {
        isSidechain: true,
        isApiErrorMessage: true,
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "API Error: Stream idle" }],
        },
      },
    },
  };
}

describe("ApiErrorDetector", () => {
  let watcher: MockWatcher;
  let recoverCount: number;
  let onApiError: ReturnType<typeof vi.fn<(info: ApiErrorInfo) => void>>;
  let detector: ApiErrorDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    watcher = new MockWatcher();
    recoverCount = 0;
    onApiError = vi.fn();
    detector = new ApiErrorDetector({
      jobId: "job-test",
      watcher,
      getRecoverCount: () => recoverCount,
      onApiError,
    });
  });

  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
  });

  it("subscribes to the watcher exactly once on construction", () => {
    expect(watcher.consumerCount()).toBe(1);
  });

  it("fires onApiError after the 5s confirmation window when isApiErrorMessage is true", () => {
    watcher.emit(syntheticByFlag());
    // Pre-window — handler MUST NOT fire yet (real assistant entry could
    // still arrive and cancel).
    expect(onApiError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_999);
    expect(onApiError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onApiError).toHaveBeenCalledTimes(1);
    // DX-322 — every stream-idle synthetic carries `kind: "stream_idle"`
    // and NO `resume_at`. Rate-limit synthetics carry `kind: "rate_limit"`
    // + `resume_at`, asserted in its own block below.
    expect(onApiError).toHaveBeenCalledWith({
      jobId: "job-test",
      errorText: expect.stringMatching(/Stream idle/i),
      recoverCount: 0,
      kind: "stream_idle",
    });
  });

  it("fires onApiError when model is <synthetic> AND content matches /API Error/i", () => {
    watcher.emit(syntheticByModel());
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(onApiError).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-test",
        errorText: expect.stringMatching(/API error/i),
      }),
    );
  });

  it("ignores a real assistant entry with no synthetic markers", () => {
    watcher.emit(realAssistant());
    vi.advanceTimersByTime(10_000);
    expect(onApiError).not.toHaveBeenCalled();
  });

  it("ignores synthetic entries that carry isSidechain: true (sub-agent error → no parent recover)", () => {
    watcher.emit(syntheticSidechain());
    vi.advanceTimersByTime(10_000);
    expect(onApiError).not.toHaveBeenCalled();
  });

  it("5s confirmation window — a real assistant entry within 5s cancels the recover", () => {
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(2_000);
    watcher.emit(realAssistant()); // API recovered on its own
    vi.advanceTimersByTime(10_000);
    expect(onApiError).not.toHaveBeenCalled();
  });

  it("5s confirmation window — another synthetic entry inside the window does NOT cancel; original timer still fires once", () => {
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(1_000);
    // A duplicate synthetic should NOT count as a "real recovery" — the API
    // is still failing. The first timer must fire normally.
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(4_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
  });

  it("idempotent — repeated synthetic entries within the SAME recoverCount epoch fire at most once", () => {
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(1);

    // Same epoch — another synthetic must NOT re-arm the timer.
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(10_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
  });

  it("re-arms when getRecoverCount() returns a higher value (multi-epoch)", () => {
    // Epoch 0 → fires once.
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(onApiError).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoverCount: 0 }),
    );

    // Caller (Phase 2 launcher) bumps recoverCount after invoking the
    // recover handler. The detector must re-arm so the next synthetic
    // entry in the new epoch fires again.
    recoverCount = 1;

    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(2);
    expect(onApiError).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoverCount: 1 }),
    );
  });

  it("stop() unsubscribes the timer so a delayed window does NOT fire after cleanup", () => {
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(2_000);
    detector.stop();
    vi.advanceTimersByTime(10_000);
    expect(onApiError).not.toHaveBeenCalled();
  });

  it("ignores entries whose type is not 'assistant' even if the raw payload contains synthetic-shaped fields", () => {
    // A `system` or `result` entry that happened to embed an API-error-
    // shaped message MUST NOT trigger the recover — only the assistant
    // turn carrying the synthetic stop is the real signal.
    const systemEntry: AgentLogEntry = {
      timestamp: Date.now(),
      type: "system",
      subtype: "init",
      summary: "init",
      data: {
        raw: {
          isApiErrorMessage: true,
          message: { model: "<synthetic>", content: [] },
        },
      },
    };
    watcher.emit(systemEntry);
    vi.advanceTimersByTime(10_000);
    expect(onApiError).not.toHaveBeenCalled();
  });

  it("non-assistant entry mid-window does NOT cancel the pending recover", () => {
    // The cancellation branch lives AFTER the early-return guards — only
    // entries that survive `type === "assistant"` AND `!isSidechain` can
    // cancel a pending timer. A `system` event arriving mid-window must
    // not be misread as "API recovered."
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(2_000);
    const systemMidWindow: AgentLogEntry = {
      timestamp: Date.now(),
      type: "system",
      subtype: "init",
      summary: "system entry",
      data: { raw: {} },
    };
    watcher.emit(systemMidWindow);
    vi.advanceTimersByTime(3_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
  });

  it("sidechain (sub-agent) assistant entry mid-window does NOT cancel the pending recover", () => {
    // A sub-agent's real reply during the parent's confirmation window
    // is unrelated to the parent's API health. Cancelling on it would
    // suppress recovers any time a sub-agent was active concurrently
    // with a synthetic on the parent stream.
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(2_000);
    const sidechainReal: AgentLogEntry = {
      timestamp: Date.now(),
      type: "assistant",
      summary: "sidechain real reply",
      data: {
        subagent_id: "agent-zzz",
        raw: {
          isSidechain: true,
          message: {
            model: "claude-opus-4-7",
            content: [{ type: "text", text: "sub-agent doing its thing" }],
          },
        },
      },
    };
    watcher.emit(sidechainReal);
    vi.advanceTimersByTime(3_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
  });

  it("epoch bump between arm and fire — timer still uses the arm-time epoch (Phase 2 contract)", () => {
    // Phase 2's launcher will increment recoverCount AFTER onApiError
    // returns, so this race cannot occur in practice. But pinning the
    // contract here protects against a refactor that re-reads
    // getRecoverCount() at fire time and silently swallows the new
    // epoch's first synthetic detection.
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(2_000);
    recoverCount = 1; // external bump arrives mid-window
    vi.advanceTimersByTime(3_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(onApiError).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoverCount: 0 }),
    );

    // Idempotency-after-bump — the next epoch-1 synthetic still fires
    // because firedAtEpoch is 0 (the arm-time epoch), strictly less than
    // the current epoch 1.
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(2);
    expect(onApiError).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoverCount: 1 }),
    );
  });

  it("synthetic entry with empty content + no raw.error — falls back to the static error text", () => {
    // extractErrorText() has a 3-tier fallback. The first tier exits
    // early when content is empty; the second tier exits when raw.error
    // is missing. The static fallback is the last line of defense.
    const empty: AgentLogEntry = {
      timestamp: Date.now(),
      type: "assistant",
      summary: "synthetic-empty",
      data: {
        raw: {
          isApiErrorMessage: true,
          message: { model: "<synthetic>", content: [] },
          // raw.error intentionally absent
        },
      },
    };
    watcher.emit(empty);
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(onApiError).toHaveBeenLastCalledWith(
      expect.objectContaining({
        errorText: "API error (synthetic — no error text in JSONL)",
      }),
    );
  });

  it("synthetic entry with empty content but raw.error string — falls back to raw.error", () => {
    const withRawError: AgentLogEntry = {
      timestamp: Date.now(),
      type: "assistant",
      summary: "synthetic-raw-error",
      data: {
        raw: {
          isApiErrorMessage: true,
          error: "stream-idle-fallback",
          message: { model: "<synthetic>", content: [] },
        },
      },
    };
    watcher.emit(withRawError);
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
    expect(onApiError).toHaveBeenLastCalledWith(
      expect.objectContaining({ errorText: "stream-idle-fallback" }),
    );
  });

  it("constructor rejects confirmationWindowMs <= 0 (defensive validation)", () => {
    const spawn = (ms: number) =>
      new ApiErrorDetector({
        jobId: "job-x",
        watcher: new MockWatcher(),
        getRecoverCount: () => 0,
        onApiError: () => {},
        confirmationWindowMs: ms,
      });
    expect(() => spawn(0)).toThrow(/confirmationWindowMs/);
    expect(() => spawn(-1)).toThrow(/confirmationWindowMs/);
    expect(() => spawn(Number.NaN)).toThrow(/confirmationWindowMs/);
  });
});

/**
 * DX-322 — rate-limit kind discrimination + reset-time parsing.
 *
 * The detector classifies every synthetic JSONL entry as
 * `kind: "stream_idle" | "rate_limit"` BEFORE arming the confirmation
 * window so the recover handler can branch on the kind without re-
 * parsing the error text. Rate-limit synthetics carry `resume_at` (ISO
 * UTC); stream-idle synthetics do not.
 *
 * `parseRateLimitResume` is exported separately so the IANA tz + DST
 * cases get exhaustive coverage without spinning up the detector for
 * each variant.
 */
function rateLimitSynthetic(): AgentLogEntry {
  return {
    timestamp: Date.now(),
    type: "assistant",
    summary: "rate-limit-synthetic",
    data: {
      messageId: "msg-rate-limit",
      content: [
        {
          type: "text",
          text:
            "API Error: You've hit your limit · resets 7:20am " +
            "(America/Montevideo)",
        },
      ],
      raw: {
        isApiErrorMessage: true,
        error: "rate_limit",
        message: {
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          content: [
            {
              type: "text",
              text:
                "API Error: You've hit your limit · resets 7:20am " +
                "(America/Montevideo)",
            },
          ],
        },
      },
    },
  };
}

function rateLimitSyntheticUnparseable(): AgentLogEntry {
  // Rate-limit pattern matches, but the reset wording is something the
  // parser doesn't understand. Must fall back to stream_idle so the
  // legacy recover loop fires.
  return {
    timestamp: Date.now(),
    type: "assistant",
    summary: "rate-limit-unparseable",
    data: {
      messageId: "msg-rate-limit-bad",
      raw: {
        isApiErrorMessage: true,
        error: "rate_limit",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text:
                "API Error: 429 You've hit your limit · resets soon",
            },
          ],
        },
      },
    },
  };
}

describe("ApiErrorDetector — rate-limit kind discrimination (DX-322)", () => {
  let watcher: MockWatcher;
  let onApiError: ReturnType<typeof vi.fn<(info: ApiErrorInfo) => void>>;
  let detector: ApiErrorDetector;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Pin Date.now() to a known instant in UTC so resume_at assertions
    // are deterministic across CI hosts. 2026-05-12T20:00:00Z is well
    // outside any DST transition for both tested tzs (Montevideo +
    // Tokyo) so the math is stable.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T20:00:00.000Z"));
    watcher = new MockWatcher();
    onApiError = vi.fn();
    detector = new ApiErrorDetector({
      jobId: "job-rate-limit",
      watcher,
      getRecoverCount: () => 0,
      onApiError,
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    detector.stop();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("rate-limit synthetic → kind=rate_limit + parsed resume_at (Montevideo)", () => {
    watcher.emit(rateLimitSynthetic());
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
    const fired = onApiError.mock.calls[0][0] as ApiErrorInfo;
    expect(fired.kind).toBe("rate_limit");
    // Montevideo runs UTC-3 in 2026-05 (autumn standard time). The reset
    // wall clock is 07:20 Montevideo on 2026-05-13 (next day — the
    // observed time is 20:00 UTC = 17:00 Montevideo, so today's 07:20
    // is already in the past). Expected UTC: 10:20.
    expect(fired.resume_at).toBe("2026-05-13T10:20:00.000Z");
    expect(fired.errorText).toMatch(/hit your limit/);
  });

  it("stream-idle synthetic → kind=stream_idle, no resume_at", () => {
    watcher.emit(syntheticByFlag());
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
    const fired = onApiError.mock.calls[0][0] as ApiErrorInfo;
    expect(fired.kind).toBe("stream_idle");
    expect(fired.resume_at).toBeUndefined();
  });

  it("rate-limit pattern with UNPARSEABLE reset wording → falls back to stream_idle (legacy recover loop)", () => {
    watcher.emit(rateLimitSyntheticUnparseable());
    vi.advanceTimersByTime(5_000);
    expect(onApiError).toHaveBeenCalledTimes(1);
    const fired = onApiError.mock.calls[0][0] as ApiErrorInfo;
    // Fallback contract: never silently swallow. We log a warn so the
    // operator sees the parser regression on the next dashboard tick.
    expect(fired.kind).toBe("stream_idle");
    expect(fired.resume_at).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/rate-limit pattern matched but reset-time unparseable/),
    );
  });
});

describe("parseRateLimitResume (DX-322 — reset-time parser)", () => {
  // Pin the "live now" used by the wall-clock-to-UTC two-pass refinement
  // so DST offset queries hit deterministic answers across CI hosts.
  const now2026May = Date.parse("2026-05-12T20:00:00.000Z");

  it("parses `resets 7:20am (America/Montevideo)` → next-day UTC 10:20", () => {
    // 20:00 UTC = 17:00 Montevideo (UTC-3 standard time in May 2026).
    // 07:20 Montevideo today is in the PAST → tomorrow → 13 May 07:20 MV
    // → 13 May 10:20 UTC.
    const iso = parseRateLimitResume(
      "API Error: You've hit your limit · resets 7:20am (America/Montevideo)",
      now2026May,
    );
    expect(iso).toBe("2026-05-13T10:20:00.000Z");
  });

  it("parses `resets 11:59pm (UTC)` → today UTC if still in the future", () => {
    const iso = parseRateLimitResume(
      "resets 11:59pm (UTC)",
      Date.parse("2026-05-12T20:00:00.000Z"),
    );
    expect(iso).toBe("2026-05-12T23:59:00.000Z");
  });

  it("parses `resets 12:00am (UTC)` (midnight) — bumps to next day if equal to now", () => {
    const iso = parseRateLimitResume(
      "resets 12:00am (UTC)",
      Date.parse("2026-05-12T00:00:00.000Z"),
    );
    // 12:00am === 00:00, today's 00:00 UTC equals `now`, so today's
    // candidate fails the `<= now` guard and rolls to tomorrow.
    expect(iso).toBe("2026-05-13T00:00:00.000Z");
  });

  it("DST-aware: Montevideo crossing into DST returns the live offset, not a stale -3h assumption", () => {
    // Synthetic: query during the DST window. Montevideo historically
    // observed UTC-2 during summer. We just assert the parser uses the
    // live ICU offset for the date being computed — exact offset value
    // is whatever V8's ICU bundle returns at test time. The contract is
    // "no hand-rolled offset math"; we pin that by asserting the result
    // is a valid ISO and within the 24h cap.
    const iso = parseRateLimitResume(
      "resets 3:00am (America/Montevideo)",
      Date.parse("2026-01-15T12:00:00.000Z"),
    );
    expect(iso).toMatch(/^2026-01-1[56]T0[5-7]:00:00\.000Z$/);
  });

  it("today→tomorrow rollover always lands within the 24h cap for non-DST days", () => {
    // Cap is `(resume_at - now) > 24h → undefined`. With the
    // today-first / tomorrow-on-rollover logic, the natural ceiling is
    // ~24h (give-or-take DST). This test pins the boundary against
    // accidental regressions where a refactor might double-bump
    // (today→tomorrow→day-after) and push past the cap.
    //
    // 1) Reset earlier today vs now → tomorrow bump → ≤24h ahead.
    const tomorrowIso = parseRateLimitResume(
      "resets 7:20am (America/Montevideo)",
      Date.parse("2026-05-12T20:00:00.000Z"),
    );
    expect(tomorrowIso).toBe("2026-05-13T10:20:00.000Z");
    const tomorrowMs = Date.parse(tomorrowIso!);
    const nowMs = Date.parse("2026-05-12T20:00:00.000Z");
    expect(tomorrowMs - nowMs).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);

    // 2) Reset later today vs now → today → ≤24h ahead.
    const todayIso = parseRateLimitResume(
      "resets 11:59pm (UTC)",
      Date.parse("2026-05-12T20:00:00.000Z"),
    );
    expect(todayIso).toBe("2026-05-12T23:59:00.000Z");
  });

  it("returns undefined for an unknown IANA tz (Intl.DateTimeFormat throws)", () => {
    const iso = parseRateLimitResume(
      "resets 7:20am (Made/UpRegion)",
      now2026May,
    );
    expect(iso).toBeUndefined();
  });

  it("returns undefined when the pattern doesn't match", () => {
    expect(parseRateLimitResume("everything is fine", now2026May)).toBeUndefined();
    expect(
      parseRateLimitResume("resets 7:20am Tokyo", now2026May), // no parens
    ).toBeUndefined();
    expect(
      parseRateLimitResume("resets 25:00am (UTC)", now2026May), // hour > 12
    ).toBeUndefined();
  });

  it("handles 12am/12pm meridiem boundary correctly", () => {
    // 12am === midnight (00:00); 12pm === noon (12:00).
    const midnight = parseRateLimitResume(
      "resets 12:00am (UTC)",
      Date.parse("2026-05-12T22:00:00.000Z"),
    );
    expect(midnight).toBe("2026-05-13T00:00:00.000Z");
    const noon = parseRateLimitResume(
      "resets 12:00pm (UTC)",
      Date.parse("2026-05-12T11:00:00.000Z"),
    );
    expect(noon).toBe("2026-05-12T12:00:00.000Z");
  });
});

describe("classifyApiError (DX-322 — kind selection)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  const now = Date.parse("2026-05-12T20:00:00.000Z");

  it("`hit your limit` → rate_limit + resume_at", () => {
    const result = classifyApiError(
      "hit your limit · resets 7:20am (America/Montevideo)",
      now,
    );
    expect(result.kind).toBe("rate_limit");
    expect(result.resumeAt).toBe("2026-05-13T10:20:00.000Z");
  });

  it("bare `429` token → rate_limit (if parseable reset present)", () => {
    const result = classifyApiError(
      "API Error: 429 — resets 11:59pm (UTC)",
      Date.parse("2026-05-12T20:00:00.000Z"),
    );
    expect(result.kind).toBe("rate_limit");
    expect(result.resumeAt).toBe("2026-05-12T23:59:00.000Z");
  });

  it("`rate_limit` token → rate_limit (if parseable reset present)", () => {
    const result = classifyApiError(
      "rate_limit hit · resets 11:59pm (UTC)",
      Date.parse("2026-05-12T20:00:00.000Z"),
    );
    expect(result.kind).toBe("rate_limit");
  });

  it("Stream idle → stream_idle (no rate-limit pattern)", () => {
    const result = classifyApiError(
      "API Error: Stream idle timeout - partial response received",
      now,
    );
    expect(result.kind).toBe("stream_idle");
    expect(result.resumeAt).toBeUndefined();
  });

  it("rate-limit token but UNPARSEABLE reset → fallback stream_idle + warn", () => {
    const result = classifyApiError(
      "API Error: rate_limit hit — try again later",
      now,
    );
    expect(result.kind).toBe("stream_idle");
    expect(result.resumeAt).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});
