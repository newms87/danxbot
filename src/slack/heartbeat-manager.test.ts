import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WebClient } from "@slack/web-api";
import type { AgentLogEntry, HeartbeatUpdate } from "../types.js";
import { createMockWebClient } from "../__tests__/helpers/slack-mock.js";

// --- Mocks ---

const mockGenerateHeartbeatMessage = vi.fn();
const mockBuildActivitySummary = vi.fn();

vi.mock("../agent/heartbeat.js", () => ({
  generateHeartbeatMessage: mockGenerateHeartbeatMessage,
  buildActivitySummary: mockBuildActivitySummary,
}));

vi.mock("./formatter.js", () => ({
  markdownToSlackMrkdwn: vi.fn((text: string) => text),
}));

vi.mock("./helpers.js", () => ({
  buildHeartbeatAttachment: vi.fn(
    (hb: HeartbeatUpdate, elapsed: number) => [{ color: hb.color, text: hb.text }],
  ),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { HeartbeatManager } = await import("./heartbeat-manager.js");

// --- Constants ---

const DEFAULT_HEARTBEAT_UPDATE: HeartbeatUpdate = {
  emoji: ":mag:",
  color: "#3498db",
  text: "Working",
  stop: false,
};

// --- Helpers ---

function createManager(client = createMockWebClient()) {
  return {
    manager: new HeartbeatManager(
      client as unknown as WebClient,
      "C123",
      "ts-placeholder",
      "ts-thread",
      Date.now(),
    ),
    client,
  };
}

function logEntry(type: string, summary: string): AgentLogEntry {
  return { timestamp: Date.now(), type, summary, data: {} };
}

function setupOrchestratorMocks(update: HeartbeatUpdate = DEFAULT_HEARTBEAT_UPDATE) {
  mockBuildActivitySummary.mockReturnValue("activity summary");
  mockGenerateHeartbeatMessage.mockResolvedValue({ update, usage: null });
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe("HeartbeatManager", () => {
  describe("onLogEntry", () => {
    it("passes accumulated entries to orchestrator on heartbeat tick", () => {
      vi.useRealTimers();
      const { manager } = createManager();
      const entry = logEntry("assistant", "Tools: Read");

      manager.onLogEntry(entry);
      manager.onLogEntry(logEntry("user", "Tool results"));

      // Verify entries are tracked by checking that orchestrator receives them
      // We do this indirectly by starting the heartbeat and checking buildActivitySummary args
      vi.useFakeTimers();
      setupOrchestratorMocks();

      manager.start();
      // Advance 2 ticks (10000ms) so orchestrator fires
      vi.advanceTimersByTime(10000);

      expect(mockBuildActivitySummary).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: "assistant", summary: "Tools: Read" }),
          expect.objectContaining({ type: "user", summary: "Tool results" }),
        ]),
        0,
        expect.any(Number),
      );

      manager.stop();
    });
  });

  describe("onStream", () => {
    it("flushes immediately when throttle window has passed", () => {
      const { manager, client } = createManager();

      // Advance time so the throttle window is clearly passed
      vi.advanceTimersByTime(1000);

      manager.onStream("Hello streaming text");

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C123",
          ts: "ts-placeholder",
          text: "Hello streaming text",
        }),
      );

      manager.stop();
    });

    it("defers flush when called within throttle window", () => {
      const { manager, client } = createManager();

      // First call - flushes immediately (window has passed)
      vi.advanceTimersByTime(1000);
      manager.onStream("first");
      expect(client.chat.update).toHaveBeenCalledTimes(1);

      // Second call immediately after - should be deferred
      manager.onStream("second");
      expect(client.chat.update).toHaveBeenCalledTimes(1); // Still just 1

      manager.stop();
    });

    it("deferred flush fires after remaining throttle time", () => {
      const { manager, client } = createManager();

      // First call flushes immediately
      vi.advanceTimersByTime(1000);
      manager.onStream("first");
      expect(client.chat.update).toHaveBeenCalledTimes(1);

      // Second call deferred
      manager.onStream("second");
      expect(client.chat.update).toHaveBeenCalledTimes(1);

      // Advance past the throttle window (500ms)
      vi.advanceTimersByTime(500);
      expect(client.chat.update).toHaveBeenCalledTimes(2);
      expect(client.chat.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "second",
        }),
      );

      manager.stop();
    });

    it("cancels pending timer when immediate flush fires", () => {
      const { manager, client } = createManager();

      // First call flushes immediately
      vi.advanceTimersByTime(1000);
      manager.onStream("first");
      expect(client.chat.update).toHaveBeenCalledTimes(1);

      // Second call within window - creates deferred timer
      manager.onStream("second");
      expect(client.chat.update).toHaveBeenCalledTimes(1);

      // Advance past the full throttle window so next call is immediate
      vi.advanceTimersByTime(500);
      // Deferred fires
      expect(client.chat.update).toHaveBeenCalledTimes(2);

      // Third call after throttle window - flushes immediately, should cancel any pending timer
      vi.advanceTimersByTime(500);
      manager.onStream("third");
      expect(client.chat.update).toHaveBeenCalledTimes(3);

      // Record count - no more flushes should happen from a stale deferred timer
      const countAfterThird = client.chat.update.mock.calls.length;
      vi.advanceTimersByTime(2000);
      expect(client.chat.update).toHaveBeenCalledTimes(countAfterThird);

      manager.stop();
    });

    it("multiple rapid calls within window produce exactly 2 flushes", () => {
      const { manager, client } = createManager();

      // First call flushes immediately (throttle window passed)
      vi.advanceTimersByTime(1000);
      manager.onStream("first");
      expect(client.chat.update).toHaveBeenCalledTimes(1);

      // Three rapid calls within the throttle window
      manager.onStream("second");
      manager.onStream("third");
      manager.onStream("fourth");

      // Still just the initial immediate flush
      expect(client.chat.update).toHaveBeenCalledTimes(1);

      // Advance past throttle window - the single deferred timer fires with latest text
      vi.advanceTimersByTime(500);
      expect(client.chat.update).toHaveBeenCalledTimes(2);
      expect(client.chat.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "fourth",
        }),
      );

      // No additional flushes after that
      vi.advanceTimersByTime(2000);
      expect(client.chat.update).toHaveBeenCalledTimes(2);

      manager.stop();
    });
  });

  describe("stop", () => {
    it("clears heartbeat interval and pending flush timer", () => {
      const { manager, client } = createManager();

      manager.start();

      // Create a pending flush timer
      vi.advanceTimersByTime(1000);
      manager.onStream("first");
      manager.onStream("deferred"); // This creates a pending timer

      manager.stop();

      // Advance time - nothing should fire
      vi.advanceTimersByTime(20000);

      // The update call count should not increase after stop
      const callCountAfterStop = client.chat.update.mock.calls.length;
      vi.advanceTimersByTime(20000);
      expect(client.chat.update).toHaveBeenCalledTimes(callCountAfterStop);
    });
  });

  describe("start", () => {
    it("creates interval that calls updateHeartbeatSlack every tick", () => {
      const { manager, client } = createManager();

      manager.start();

      // After 1 tick (5000ms), should update Slack
      vi.advanceTimersByTime(5000);
      expect(client.chat.update).toHaveBeenCalled();

      // After 2 more ticks
      const countAfterFirstTick = client.chat.update.mock.calls.length;
      vi.advanceTimersByTime(5000);
      expect(client.chat.update.mock.calls.length).toBeGreaterThan(countAfterFirstTick);

      manager.stop();
    });

    it("calls orchestrator every 2 ticks, not every tick", () => {
      const { manager } = createManager();
      setupOrchestratorMocks();

      manager.start();

      // After 1 tick - orchestrator should NOT be called
      vi.advanceTimersByTime(5000);
      expect(mockGenerateHeartbeatMessage).not.toHaveBeenCalled();

      // After 2 ticks - orchestrator SHOULD be called
      vi.advanceTimersByTime(5000);
      expect(mockGenerateHeartbeatMessage).toHaveBeenCalledTimes(1);

      manager.stop();
    });

    it("orchestrator result updates latestHeartbeat", async () => {
      const { manager } = createManager();
      const update: HeartbeatUpdate = {
        emoji: ":rocket:",
        color: "#e74c3c",
        text: "Blasting off!",
        stop: false,
      };
      setupOrchestratorMocks(update);

      manager.start();

      // Advance 2 ticks to trigger orchestrator
      vi.advanceTimersByTime(10000);

      // Flush the resolved promise
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.latestHeartbeat).toEqual(update);

      manager.stop();
    });

    it("caps snapshot history at 5 entries", async () => {
      const { manager } = createManager();
      mockBuildActivitySummary.mockReturnValue("summary");

      let callCount = 0;
      mockGenerateHeartbeatMessage.mockImplementation(async () => {
        callCount++;
        return {
          update: {
            emoji: `:num${callCount}:`,
            color: "#000",
            text: `Update ${callCount}`,
            stop: false,
          },
          usage: null,
        };
      });

      manager.start();

      // Trigger orchestrator 7 times (14 ticks)
      for (let i = 0; i < 7; i++) {
        vi.advanceTimersByTime(10000);
        await vi.advanceTimersByTimeAsync(0);
      }

      // The last call to generateHeartbeatMessage should receive max 5 snapshots
      const lastCall = mockGenerateHeartbeatMessage.mock.calls[
        mockGenerateHeartbeatMessage.mock.calls.length - 1
      ];
      const previousSnapshots = lastCall[1];
      expect(previousSnapshots.length).toBeLessThanOrEqual(5);

      manager.stop();
    });

    it("stop signal from orchestrator clears the interval", async () => {
      const { manager, client } = createManager();
      setupOrchestratorMocks({
        emoji: ":skull:",
        color: "#e74c3c",
        text: "Agent crashed",
        stop: true,
      });

      manager.start();

      // Trigger orchestrator (2 ticks)
      vi.advanceTimersByTime(10000);
      await vi.advanceTimersByTimeAsync(0);

      // Record call count after stop signal
      const callCountAfterStop = client.chat.update.mock.calls.length;

      // Advance many more ticks - should NOT produce more updates
      vi.advanceTimersByTime(50000);
      expect(client.chat.update.mock.calls.length).toBe(callCountAfterStop);

      manager.stop();
    });

    it("resets orchestratorPending on error so next cycle fires", async () => {
      const { manager } = createManager();
      mockBuildActivitySummary.mockReturnValue("summary");

      // First call rejects
      mockGenerateHeartbeatMessage.mockRejectedValueOnce(new Error("API failure"));
      // Second call succeeds
      mockGenerateHeartbeatMessage.mockResolvedValueOnce({ update: DEFAULT_HEARTBEAT_UPDATE, usage: null });

      manager.start();

      // Trigger orchestrator (2 ticks) - this will reject
      vi.advanceTimersByTime(10000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockGenerateHeartbeatMessage).toHaveBeenCalledTimes(1);

      // Trigger orchestrator again (2 more ticks) - should fire because pending was reset
      vi.advanceTimersByTime(10000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockGenerateHeartbeatMessage).toHaveBeenCalledTimes(2);
      // Verify the second call succeeded and updated the heartbeat
      expect(manager.latestHeartbeat).toEqual(DEFAULT_HEARTBEAT_UPDATE);

      manager.stop();
    });
  });

  describe("getApiCalls", () => {
    it("returns empty array initially", () => {
      const { manager } = createManager();
      expect(manager.getApiCalls()).toEqual([]);
      manager.stop();
    });

    it("accumulates usage from orchestrator calls", async () => {
      const { manager } = createManager();
      mockBuildActivitySummary.mockReturnValue("summary");

      const mockUsage = {
        source: "heartbeat" as const,
        model: "claude-haiku-4-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        costUsd: 0.0001,
        timestamp: Date.now(),
      };

      mockGenerateHeartbeatMessage.mockResolvedValue({
        update: DEFAULT_HEARTBEAT_UPDATE,
        usage: mockUsage,
      });

      manager.start();

      // Trigger orchestrator (2 ticks)
      vi.advanceTimersByTime(10000);
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.getApiCalls()).toHaveLength(1);
      expect(manager.getApiCalls()[0]).toBe(mockUsage);

      // Trigger again (2 more ticks)
      vi.advanceTimersByTime(10000);
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.getApiCalls()).toHaveLength(2);

      manager.stop();
    });

    it("skips null usage from orchestrator", async () => {
      const { manager } = createManager();
      mockBuildActivitySummary.mockReturnValue("summary");

      mockGenerateHeartbeatMessage.mockResolvedValue({
        update: DEFAULT_HEARTBEAT_UPDATE,
        usage: null,
      });

      manager.start();

      // Trigger orchestrator (2 ticks)
      vi.advanceTimersByTime(10000);
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.getApiCalls()).toHaveLength(0);

      manager.stop();
    });
  });

  describe("flushToSlack", () => {
    it("does nothing when latestStreamText is empty", () => {
      const { manager, client } = createManager();

      // Trigger flushToSlack indirectly via onStream with empty string
      // If we call onStream with empty string, latestStreamText will be ""
      // and flushToSlack should return early
      vi.advanceTimersByTime(1000);
      manager.onStream("");

      // chat.update should NOT be called because text is empty
      expect(client.chat.update).not.toHaveBeenCalled();

      manager.stop();
    });

    it("truncates text exceeding 3900 chars", () => {
      const { manager, client } = createManager();

      const longText = "x".repeat(4500);
      vi.advanceTimersByTime(1000);
      manager.onStream(longText);

      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("...still generating..."),
        }),
      );

      // Verify the truncated text is at most 3900 + the suffix
      const calledText = client.chat.update.mock.calls[0][0].text;
      expect(calledText.length).toBeLessThan(4500);
      expect(calledText.startsWith("x".repeat(3900))).toBe(true);

      manager.stop();
    });
  });
});
