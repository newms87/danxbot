import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  StallDetector,
  isToolCallPending,
  hasReceivedToolResult,
  getLastToolResultTimestamp,
  DEFAULT_STALL_THRESHOLD_MS,
  DEFAULT_MAX_NUDGES,
} from "./stall-detector.js";
import type { AgentLogEntry } from "../types.js";
import type { TerminalOutputWatcher } from "./terminal-output-watcher.js";

// --- Fixture helpers ---

function assistantEntry(
  toolUseIds: string[] = [],
  textContent = "",
  timestamp = 1000,
): AgentLogEntry {
  const content: Array<Record<string, unknown>> = [];
  if (textContent) {
    content.push({ type: "text", text: textContent });
  }
  for (const id of toolUseIds) {
    content.push({ type: "tool_use", id, name: "SomeTool", input: {} });
  }
  return {
    timestamp,
    type: "assistant",
    summary: "assistant",
    data: { content },
  };
}

function toolResultEntry(
  toolUseIds: string[],
  timestamp = 2000,
): AgentLogEntry {
  const content: Array<Record<string, unknown>> = toolUseIds.map((id) => ({
    type: "tool_result",
    tool_use_id: id,
    content: "result content",
  }));
  return {
    timestamp,
    type: "user",
    summary: "tool_result",
    data: { content },
  };
}

// --- Minimal SessionLogWatcher mock ---

function makeWatcher(entries: AgentLogEntry[]) {
  return {
    getEntries: () => entries,
    onEntry: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as import("./session-log-watcher.js").SessionLogWatcher;
}

// --- Minimal TerminalOutputWatcher mock ---

function makeTerminalWatcher(overrides: Partial<TerminalOutputWatcher> = {}): TerminalOutputWatcher {
  return {
    lastThinkingAt: null,
    lastTextAt: null,
    lastActivityAt: null,
    start: vi.fn(),
    stop: vi.fn(),
    processChunk: vi.fn(),
    ...overrides,
  } as unknown as TerminalOutputWatcher;
}

// --- isToolCallPending ---

describe("isToolCallPending", () => {
  it("returns false for empty entries", () => {
    expect(isToolCallPending([])).toBe(false);
  });

  it("returns true when tool_use has no matching tool_result", () => {
    const entries = [assistantEntry(["tool-1"])];
    expect(isToolCallPending(entries)).toBe(true);
  });

  it("returns false when all tool_uses have matching tool_results", () => {
    const entries = [
      assistantEntry(["tool-1", "tool-2"]),
      toolResultEntry(["tool-1", "tool-2"]),
    ];
    expect(isToolCallPending(entries)).toBe(false);
  });

  it("returns true when only some tool_uses are resolved", () => {
    const entries = [
      assistantEntry(["tool-1", "tool-2"]),
      toolResultEntry(["tool-1"]),
    ];
    expect(isToolCallPending(entries)).toBe(true);
  });

  it("returns false for entries with no tool_use blocks", () => {
    const entries = [
      assistantEntry([], "just thinking"),
      toolResultEntry(["tool-x"]),
    ];
    expect(isToolCallPending(entries)).toBe(false);
  });

  it("handles multiple rounds of tool calls correctly", () => {
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"]),
      assistantEntry(["t2"]),
      toolResultEntry(["t2"]),
      assistantEntry(["t3"]), // pending
    ];
    expect(isToolCallPending(entries)).toBe(true);
  });

  it("returns false after all rounds are resolved", () => {
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"]),
      assistantEntry(["t2"]),
      toolResultEntry(["t2"]),
    ];
    expect(isToolCallPending(entries)).toBe(false);
  });

  it("ignores entries without tool_use or tool_result blocks", () => {
    const entries: AgentLogEntry[] = [
      { timestamp: 1000, type: "system", subtype: "init", summary: "init", data: {} },
      assistantEntry([], "thinking text"),
    ];
    expect(isToolCallPending(entries)).toBe(false);
  });
});

// --- hasReceivedToolResult ---

describe("hasReceivedToolResult", () => {
  it("returns false for empty entries", () => {
    expect(hasReceivedToolResult([])).toBe(false);
  });

  it("returns false when only assistant entries exist", () => {
    const entries = [assistantEntry(["t1"]), assistantEntry([], "text")];
    expect(hasReceivedToolResult(entries)).toBe(false);
  });

  it("returns true when a tool_result exists", () => {
    const entries = [assistantEntry(["t1"]), toolResultEntry(["t1"])];
    expect(hasReceivedToolResult(entries)).toBe(true);
  });

  it("returns true even with multiple tool_results", () => {
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"]),
      assistantEntry(["t2"]),
      toolResultEntry(["t2"]),
    ];
    expect(hasReceivedToolResult(entries)).toBe(true);
  });
});

// --- getLastToolResultTimestamp ---

describe("getLastToolResultTimestamp", () => {
  it("returns null for empty entries", () => {
    expect(getLastToolResultTimestamp([])).toBeNull();
  });

  it("returns null when there are no user/tool_result entries", () => {
    const entries = [assistantEntry(["t1"])];
    expect(getLastToolResultTimestamp(entries)).toBeNull();
  });

  it("returns the timestamp of the only tool_result entry", () => {
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], 5000),
    ];
    expect(getLastToolResultTimestamp(entries)).toBe(5000);
  });

  it("returns the most recent tool_result timestamp when multiple exist", () => {
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], 3000),
      assistantEntry(["t2"]),
      toolResultEntry(["t2"], 7000),
    ];
    expect(getLastToolResultTimestamp(entries)).toBe(7000);
  });

  it("ignores user entries without tool_result blocks", () => {
    const userEntry: AgentLogEntry = {
      timestamp: 9000,
      type: "user",
      summary: "plain user",
      data: { content: [{ type: "text", text: "hello" }] },
    };
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], 5000),
      userEntry,
    ];
    expect(getLastToolResultTimestamp(entries)).toBe(5000);
  });
});

// --- StallDetector.getState ---

describe("StallDetector.getState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- ✻ heartbeat path (with TerminalOutputWatcher) ---

  // Unit test 1: ✻ continuously → thinking, never stalled
  it("returns thinking when ✻ is appearing within stall threshold", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 60_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: now - 1_000,
      lastActivityAt: now - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("thinking");
  });

  // Unit test 2: ✻ stops for 5s after tool_result → stalled
  it("returns stalled when no activity for stallThresholdMs after tool_result", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 60_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("stalled");
  });

  // Unit test 3: ✻ stops but new JSONL entry within threshold → handled by lastActivityAt
  // (JSONL entries don't directly reset the stall timer in terminal mode — terminal activity does)
  // This test verifies that if terminal shows no activity but JSONL has new entries,
  // the state depends on terminal timestamps only when terminalWatcher is present.
  it("returns stalled when terminal is silent even if JSONL has entries", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 1_000), // very recent tool_result
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000, // old activity
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("stalled");
  });

  // Unit test 4: ✻ stops but terminal text activity continues → thinking
  it("returns thinking when text activity (not ✻) is within threshold", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 60_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null, // no ✻
      lastActivityAt: now - 1_000, // but recent text activity
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("thinking");
  });

  // Unit test 5: ✻ resumes after brief gap (< 5s) → thinking
  it("returns thinking when ✻ reappears within threshold", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 60_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: now - 2_000, // 2s ago — within 5s threshold
      lastActivityAt: now - 2_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("thinking");
  });

  // --- Waiting exemptions ---

  // Unit test 7: tool_use(Agent) sent, no tool_result → waiting
  it("returns waiting when tool_use(Agent) is pending regardless of silence", () => {
    const entries = [assistantEntry(["t1"])]; // tool_use with no result
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: null,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("waiting");
  });

  // Unit test 8: tool_use(Read/Bash) sent, no tool_result → waiting
  it("returns waiting when any tool_use is pending (Read, Bash, etc.)", () => {
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"]),
      assistantEntry(["t2"]), // new tool_use, no result yet
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: makeTerminalWatcher(),
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("waiting");
  });

  // Unit test 9: tool_result arrives after waiting → stall timer starts
  it("returns thinking or stalled after tool_result resolves pending tool", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: now - 500,
      lastActivityAt: now - 500,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    // Tool resolved, activity recent → thinking (stall timer running but not expired)
    expect(detector.getState()).toBe("thinking");
  });

  // --- First turn / idle ---

  // Unit test 11: No entries yet → waiting
  it("returns waiting when entries list is empty", () => {
    const detector = new StallDetector({
      watcher: makeWatcher([]),
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("waiting");
  });

  // Unit test 12: Only assistant text (no tool_use) → waiting (no tool_result yet)
  it("returns waiting when only assistant text entries exist (no tool calls)", () => {
    const entries = [assistantEntry([], "I'm thinking...")];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: makeTerminalWatcher(),
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("waiting");
  });

  // Unit test 13: First tool_result arrives → stall detection activates
  it("activates stall detection after first tool_result", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    // Now that a tool_result exists and activity is old → stalled
    expect(detector.getState()).toBe("stalled");
  });

  // --- Docker fallback (no TerminalOutputWatcher) ---

  // Unit test 14: No terminal watcher, 7 minutes pass → stalled
  it("returns stalled in fallback mode after fallback threshold", () => {
    const now = Date.now();
    const FALLBACK_MS = 7 * 60 * 1000;
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - FALLBACK_MS - 1_000),
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      // no terminalWatcher — uses fallback threshold
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("stalled");
  });

  // Unit test 15: No terminal watcher, recent tool_result → thinking
  it("returns thinking in fallback mode when tool_result is recent", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 60_000), // 1 min ago
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      // no terminalWatcher
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("thinking");
  });

  // Unit test 16: No terminal watcher, 5s passes → NOT stalled (5s is terminal mode only)
  it("does not stall after 5s in fallback mode (uses 7-min threshold)", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      // no terminalWatcher — 5s is not enough for 7-min fallback
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("thinking");
  });

  // --- Edge cases ---

  // Terminal watcher exists but has no activity yet
  it("returns thinking when terminal watcher has no activity yet", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: null,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    // Agent is starting up — terminal log not written yet
    expect(detector.getState()).toBe("thinking");
  });

  // No terminal watcher and no tool_result at all
  it("returns waiting in fallback mode when no tool_result exists", () => {
    const entries = [assistantEntry([], "just thinking")];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("waiting");
  });
});

// --- StallDetector start/stop and nudge logic ---

describe("StallDetector start/stop and nudge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call onStall when state is waiting", async () => {
    const onStall = vi.fn();
    const entries = [assistantEntry(["t1"])]; // pending tool
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall,
      checkIntervalMs: 1_000,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(5_000);
    detector.stop();

    expect(onStall).not.toHaveBeenCalled();
  });

  it("does not call onStall when state is thinking", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: now - 500,
      lastActivityAt: now - 500,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 1_000,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(3_000);
    detector.stop();

    expect(onStall).not.toHaveBeenCalled();
  });

  // Unit test 2 + 6: Stall fires, then agent recovers
  it("calls onStall when stall is detected", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 1_000,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(1_500);
    detector.stop();

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(detector.getNudgeCount()).toBe(1);
  });

  // Unit test 17: Stall fires 3 times then stops
  it("limits nudges to maxNudges and stops after reaching limit", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 500,
      maxNudges: 2,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onStall).toHaveBeenCalledTimes(2);
    expect(detector.getNudgeCount()).toBe(2);
  });

  // Unit test 17 (continued): Uses DEFAULT_MAX_NUDGES when not specified
  it("uses DEFAULT_MAX_NUDGES when maxNudges is not specified", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 100,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(1_000);
    detector.stop();

    expect(onStall).toHaveBeenCalledTimes(DEFAULT_MAX_NUDGES);
  });

  // Unit test 19: Multiple rapid tool_use/tool_result cycles
  it("resets when new tool calls appear after stall-eligible window", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    // All tools resolved, old activity → stalled
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 1_000,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onStall).toHaveBeenCalledTimes(1);

    // Simulate new tool_use — enters waiting state
    entries.push(assistantEntry(["t2"], "", now));
    await vi.advanceTimersByTimeAsync(3_000);

    // Should not fire again while tool is pending
    expect(onStall).toHaveBeenCalledTimes(1);
    detector.stop();
  });

  // Unit test 20: Fast tool (immediate tool_result) → brief no-✻ is NOT a stall
  it("does not stall on fast tool cycle when activity is recent", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 100), // tool_result 100ms ago
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: now - 200,
      lastActivityAt: now - 200, // activity 200ms ago
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 500,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(2_000);
    detector.stop();

    expect(onStall).not.toHaveBeenCalled();
  });

  it("stop() prevents further checks and onStall calls", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 500,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(600);
    detector.stop();
    const callCount = onStall.mock.calls.length;

    await vi.advanceTimersByTimeAsync(2_000);

    expect(onStall).toHaveBeenCalledTimes(callCount);
  });

  it("does not propagate when onStall throws", async () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const onStall = vi.fn().mockImplementation(() => {
      throw new Error("callback error");
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 500,
      maxNudges: 3,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(1_200);
    detector.stop();

    expect(onStall).toHaveBeenCalledTimes(2);
    expect(detector.getNudgeCount()).toBe(2);
  });

  it("start() is idempotent — calling twice does not double the timer", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 1_000,
      maxNudges: 10,
    });

    detector.start();
    detector.start();
    await vi.advanceTimersByTimeAsync(2_500);
    detector.stop();

    expect(onStall).toHaveBeenCalledTimes(2);
  });

  // Default threshold selection based on terminalWatcher presence
  it("uses 5s threshold when terminalWatcher is present and no explicit threshold", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 6_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - 6_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    // 6s > 5s default → stalled
    expect(detector.getState()).toBe("stalled");
  });

  it("uses 7-min threshold when no terminalWatcher and no explicit threshold", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 6_000), // 6s ago
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      // no terminalWatcher
      onStall: vi.fn(),
    });
    // 6s is not enough for 7-min fallback
    expect(detector.getState()).toBe("thinking");
  });

  // --- Missing test coverage from review ---

  it("explicit stallThresholdMs overrides auto-selected default", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 15_000), // 15s ago
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - 15_000,
    });
    // Pass explicit 20s threshold — should NOT stall at 15s even with terminal watcher
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      stallThresholdMs: 20_000,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("thinking");
  });

  it("stop() before start() is a no-op", () => {
    const detector = new StallDetector({
      watcher: makeWatcher([]),
      onStall: vi.fn(),
    });
    // Should not throw
    detector.stop();
    expect(detector.getNudgeCount()).toBe(0);
  });

  it("stop() called twice is idempotent", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 500,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(600);
    detector.stop();
    detector.stop(); // second call should be a no-op
    const count = onStall.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onStall).toHaveBeenCalledTimes(count);
  });

  it("getNudgeCount() returns 0 before any checks", () => {
    const detector = new StallDetector({
      watcher: makeWatcher([]),
      onStall: vi.fn(),
    });
    expect(detector.getNudgeCount()).toBe(0);
  });

  it("getNudgeCount() equals maxNudges after auto-stop", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall,
      checkIntervalMs: 100,
      maxNudges: 2,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(1_000);
    // Detector should have auto-stopped after 2 nudges
    expect(detector.getNudgeCount()).toBe(2);
    expect(onStall).toHaveBeenCalledTimes(2);
  });

  it("handles entries with missing content field gracefully", () => {
    const entryWithNoContent: AgentLogEntry = {
      timestamp: 1000,
      type: "assistant",
      summary: "assistant",
      data: {}, // no content field
    };
    expect(isToolCallPending([entryWithNoContent])).toBe(false);
    expect(hasReceivedToolResult([entryWithNoContent])).toBe(false);
  });

  it("ignores tool_use blocks with non-string id", () => {
    const entry: AgentLogEntry = {
      timestamp: 1000,
      type: "assistant",
      summary: "assistant",
      data: {
        content: [
          { type: "tool_use", id: 123, name: "Read", input: {} }, // numeric id
          { type: "tool_use", name: "Read", input: {} }, // missing id
        ],
      },
    };
    // Non-string IDs should be safely skipped
    expect(isToolCallPending([entry])).toBe(false);
  });
});
