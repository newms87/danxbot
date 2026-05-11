import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ApiErrorDetector,
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
    expect(onApiError).toHaveBeenCalledWith({
      jobId: "job-test",
      errorText: expect.stringMatching(/Stream idle/i),
      recoverCount: 0,
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
