import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  StallDetector,
  isSubAgentRunning,
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

// --- isSubAgentRunning ---

describe("isSubAgentRunning", () => {
  it("returns false for empty entries", () => {
    expect(isSubAgentRunning([])).toBe(false);
  });

  it("returns true when tool_use has no matching tool_result", () => {
    const entries = [
      assistantEntry(["tool-1"]),
    ];
    expect(isSubAgentRunning(entries)).toBe(true);
  });

  it("returns false when all tool_uses have matching tool_results", () => {
    const entries = [
      assistantEntry(["tool-1", "tool-2"]),
      toolResultEntry(["tool-1", "tool-2"]),
    ];
    expect(isSubAgentRunning(entries)).toBe(false);
  });

  it("returns true when only some tool_uses are resolved", () => {
    const entries = [
      assistantEntry(["tool-1", "tool-2"]),
      toolResultEntry(["tool-1"]), // only tool-1 resolved
    ];
    expect(isSubAgentRunning(entries)).toBe(true);
  });

  it("returns false for entries with no tool_use blocks", () => {
    const entries = [
      assistantEntry([], "just thinking"),
      toolResultEntry(["tool-x"]), // spurious result with no preceding call
    ];
    expect(isSubAgentRunning(entries)).toBe(false);
  });

  it("handles multiple rounds of tool calls correctly", () => {
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"]),
      assistantEntry(["t2"]),
      toolResultEntry(["t2"]),
      assistantEntry(["t3"]), // pending
    ];
    expect(isSubAgentRunning(entries)).toBe(true);
  });

  it("returns false after all rounds are resolved", () => {
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"]),
      assistantEntry(["t2"]),
      toolResultEntry(["t2"]),
    ];
    expect(isSubAgentRunning(entries)).toBe(false);
  });

  it("ignores entries without tool_use or tool_result blocks", () => {
    const entries: AgentLogEntry[] = [
      { timestamp: 1000, type: "system", subtype: "init", summary: "init", data: {} },
      assistantEntry([], "thinking text"),
    ];
    expect(isSubAgentRunning(entries)).toBe(false);
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
    // userEntry at 9000 has no tool_result, should still return 5000
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

  it("returns actively_thinking when entries list is empty", () => {
    const detector = new StallDetector({
      watcher: makeWatcher([]),
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("actively_thinking");
  });

  it("returns sub_agent_running when tool_use has no tool_result", () => {
    const entries = [assistantEntry(["t1"])];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("sub_agent_running");
  });

  it("returns actively_thinking when thinking indicator was seen recently", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 60_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: now - 30_000, // 30s ago — within 2 min window
      lastActivityAt: now - 30_000,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("actively_thinking");
  });

  it("returns actively_thinking when recent terminal activity within stall threshold", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 200_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - 60_000, // 1 min ago — within 7 min stall threshold
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("actively_thinking");
  });

  it("returns stalled when terminal activity exceeds stall threshold", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 500_000),
    ];
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: now - DEFAULT_STALL_THRESHOLD_MS - 1_000, // just past threshold
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("stalled");
  });

  it("returns actively_thinking when no terminal watcher and tool_result is recent", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 60_000),
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      // no terminalWatcher
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("actively_thinking");
  });

  it("returns stalled when no terminal watcher and last tool_result is old", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      // no terminalWatcher
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("stalled");
  });

  it("returns actively_thinking when no terminal watcher and no tool_result at all", () => {
    const entries = [assistantEntry([], "just thinking")];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall: vi.fn(),
    });
    expect(detector.getState()).toBe("actively_thinking");
  });

  it("returns actively_thinking when thinking window expired but lastActivityAt is still within stall threshold", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 500_000),
    ];
    const THINKING_ACTIVE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
    const terminal = makeTerminalWatcher({
      lastThinkingAt: now - THINKING_ACTIVE_WINDOW_MS - 1_000, // thinking window expired
      lastActivityAt: now - 60_000, // but recent activity within 7-min stall threshold
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    // Thinking window expired, but lastActivityAt is recent enough → still actively_thinking
    expect(detector.getState()).toBe("actively_thinking");
  });

  it("returns actively_thinking when terminal watcher exists but has no activity yet", () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    // Terminal watcher with no activity (agent just started, log file not written yet)
    const terminal = makeTerminalWatcher({
      lastThinkingAt: null,
      lastActivityAt: null,
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      terminalWatcher: terminal,
      onStall: vi.fn(),
    });
    // When terminal watcher is present but has no activity, don't fall through to
    // JSONL heuristic — agent is starting up, not stalled
    expect(detector.getState()).toBe("actively_thinking");
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

  it("does not call onStall when state is sub_agent_running", async () => {
    const onStall = vi.fn();
    const entries = [assistantEntry(["t1"])];
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

  it("does not call onStall when state is actively_thinking", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - 60_000),
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall,
      checkIntervalMs: 1_000,
      stallThresholdMs: 420_000,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(5_000);
    detector.stop();

    expect(onStall).not.toHaveBeenCalled();
  });

  it("calls onStall when stall is detected", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall,
      checkIntervalMs: 1_000,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(1_500);
    detector.stop();

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(detector.getNudgeCount()).toBe(1);
  });

  it("limits nudges to maxNudges and stops after reaching limit", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall,
      checkIntervalMs: 500,
      maxNudges: 2,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(5_000);
    // Detector should auto-stop after maxNudges

    expect(onStall).toHaveBeenCalledTimes(2);
    expect(detector.getNudgeCount()).toBe(2);
  });

  it("uses DEFAULT_MAX_NUDGES when maxNudges is not specified", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall,
      checkIntervalMs: 100,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(1_000);
    detector.stop();

    expect(onStall).toHaveBeenCalledTimes(DEFAULT_MAX_NUDGES);
  });

  it("stop() prevents further checks and onStall calls", async () => {
    const onStall = vi.fn();
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall,
      checkIntervalMs: 500,
    });

    detector.start();
    await vi.advanceTimersByTimeAsync(600);
    detector.stop();
    const callCount = onStall.mock.calls.length;

    await vi.advanceTimersByTimeAsync(2_000);

    expect(onStall).toHaveBeenCalledTimes(callCount); // no more calls after stop
  });

  it("does not propagate when onStall throws", async () => {
    const now = Date.now();
    const entries = [
      assistantEntry(["t1"]),
      toolResultEntry(["t1"], now - DEFAULT_STALL_THRESHOLD_MS - 1_000),
    ];
    const onStall = vi.fn().mockImplementation(() => {
      throw new Error("callback error");
    });
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall,
      checkIntervalMs: 500,
      maxNudges: 3,
    });

    detector.start();
    // Should not throw; detector keeps running
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
    const detector = new StallDetector({
      watcher: makeWatcher(entries),
      onStall,
      checkIntervalMs: 1_000,
      maxNudges: 10,
    });

    detector.start();
    detector.start(); // second call should be no-op
    await vi.advanceTimersByTimeAsync(2_500);
    detector.stop();

    // Should only fire twice (at 1s and 2s), not four times
    expect(onStall).toHaveBeenCalledTimes(2);
  });
});
