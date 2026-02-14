import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock fs/promises before importing the module under test
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
}));

// Mock config to provide a test eventsFile path
vi.mock("../config.js", () => ({
  config: {
    eventsFile: "/tmp/test-events.json",
  },
}));

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import {
  createEvent,
  updateEvent,
  getEvents,
  resetEvents,
  loadEvents,
} from "./events.js";

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);
const mockRename = vi.mocked(rename);

function makeEvent(overrides: Partial<Parameters<typeof createEvent>[0]> = {}) {
  return createEvent({
    threadTs: overrides.threadTs ?? `t-${Date.now()}-${Math.random()}`,
    messageTs: overrides.messageTs ?? `m-${Date.now()}-${Math.random()}`,
    channelId: overrides.channelId ?? "C123",
    user: overrides.user ?? "U456",
    text: overrides.text ?? "test message",
  });
}

describe("persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEvents();
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("schedulePersist", () => {
    it("writes events to disk after debounce delay on createEvent", async () => {
      makeEvent({ threadTs: "t-1", messageTs: "m-1" });

      // Should not have written yet (debounce)
      expect(mockWriteFile).not.toHaveBeenCalled();

      // Advance past the debounce delay
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockMkdir).toHaveBeenCalledWith("/tmp", { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/tmp/test-events.json.tmp",
        expect.any(String),
      );
      expect(mockRename).toHaveBeenCalledWith(
        "/tmp/test-events.json.tmp",
        "/tmp/test-events.json",
      );

      // Verify the written data is valid JSON containing our event
      const writtenData = JSON.parse(
        mockWriteFile.mock.calls[0][1] as string,
      );
      expect(writtenData).toBeInstanceOf(Array);
      expect(writtenData[0].id).toBe("t-1-m-1");
    });

    it("writes events to disk after debounce delay on updateEvent", async () => {
      const event = makeEvent({ threadTs: "t-2", messageTs: "m-2" });

      // Advance past first debounce (from createEvent)
      await vi.advanceTimersByTimeAsync(2000);
      vi.clearAllMocks();
      mockWriteFile.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      updateEvent(event.id, { status: "routing" });

      expect(mockWriteFile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const writtenData = JSON.parse(
        mockWriteFile.mock.calls[0][1] as string,
      );
      expect(writtenData[0].status).toBe("routing");
    });

    it("coalesces multiple rapid calls into a single write", async () => {
      makeEvent({ threadTs: "t-a", messageTs: "m-a" });
      makeEvent({ threadTs: "t-b", messageTs: "m-b" });
      makeEvent({ threadTs: "t-c", messageTs: "m-c" });

      await vi.advanceTimersByTimeAsync(2000);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const writtenData = JSON.parse(
        mockWriteFile.mock.calls[0][1] as string,
      );
      expect(writtenData).toHaveLength(3);
    });
  });

  describe("loadEvents", () => {
    it("reads from disk and populates events array", async () => {
      const storedEvents = [
        {
          id: "t-1-m-1",
          threadTs: "t-1",
          messageTs: "m-1",
          channelId: "C1",
          user: "U1",
          text: "hello",
          receivedAt: 1000,
          routerResponseAt: null,
          routerResponse: null,
          routerNeedsAgent: null,
          agentResponseAt: null,
          agentResponse: null,
          agentCostUsd: null,
          agentTurns: null,
          status: "complete",
          error: null,
          routerRequest: null,
          routerRawResponse: null,
          agentConfig: null,
          agentLog: null,
          feedback: null,
          responseTs: null,
        },
      ];
      mockReadFile.mockResolvedValue(JSON.stringify(storedEvents));

      await loadEvents();

      const events = getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("t-1-m-1");
      expect(events[0].text).toBe("hello");
    });

    it("handles missing file gracefully (ENOENT)", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockReadFile.mockRejectedValue(error);

      await loadEvents();

      expect(getEvents()).toHaveLength(0);
    });

    it("handles invalid JSON gracefully", async () => {
      mockReadFile.mockResolvedValue("not valid json{{{");

      await loadEvents();

      expect(getEvents()).toHaveLength(0);
    });

    it("handles non-array JSON gracefully", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ not: "an array" }));

      await loadEvents();

      expect(getEvents()).toHaveLength(0);
    });

    it("respects MAX_EVENTS cap of 500", async () => {
      const bigArray = Array.from({ length: 600 }, (_, i) => ({
        id: `id-${i}`,
        threadTs: `t-${i}`,
        messageTs: `m-${i}`,
        channelId: "C1",
        user: "U1",
        text: `msg ${i}`,
        receivedAt: 1000 + i,
        routerResponseAt: null,
        routerResponse: null,
        routerNeedsAgent: null,
        agentResponseAt: null,
        agentResponse: null,
        agentCostUsd: null,
        agentTurns: null,
        status: "complete",
        error: null,
        routerRequest: null,
        routerRawResponse: null,
        agentConfig: null,
        agentLog: null,
        feedback: null,
        responseTs: null,
      }));
      mockReadFile.mockResolvedValue(JSON.stringify(bigArray));

      await loadEvents();

      expect(getEvents()).toHaveLength(500);
    });
  });

  describe("persistToDisk error handling", () => {
    it("logs error when writeFile rejects", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockWriteFile.mockRejectedValue(new Error("disk full"));

      makeEvent({ threadTs: "t-err", messageTs: "m-err" });
      await vi.advanceTimersByTimeAsync(2000);

      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to persist events to disk:",
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("debounce timer reset", () => {
    it("resets the debounce timer when a new event is created", async () => {
      makeEvent({ threadTs: "t-d1", messageTs: "m-d1" });

      // Advance 1900ms (just under debounce threshold)
      await vi.advanceTimersByTimeAsync(1900);
      expect(mockWriteFile).not.toHaveBeenCalled();

      // Create another event, which should reset the timer
      makeEvent({ threadTs: "t-d2", messageTs: "m-d2" });

      // Advance 1900ms more (3800ms total, but only 1900ms from last event)
      await vi.advanceTimersByTimeAsync(1900);
      expect(mockWriteFile).not.toHaveBeenCalled();

      // Advance 200ms more (2100ms from last event)
      await vi.advanceTimersByTimeAsync(200);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("loadEvents replaces in-memory events", () => {
    it("replaces existing in-memory events with disk data", async () => {
      // Add an event to memory
      makeEvent({ threadTs: "t-mem", messageTs: "m-mem", text: "in memory" });

      // Load different events from disk
      const diskEvents = [
        {
          id: "t-disk-m-disk",
          threadTs: "t-disk",
          messageTs: "m-disk",
          channelId: "C9",
          user: "U9",
          text: "from disk",
          receivedAt: 5000,
          routerResponseAt: null,
          routerResponse: null,
          routerNeedsAgent: null,
          agentResponseAt: null,
          agentResponse: null,
          agentCostUsd: null,
          agentTurns: null,
          status: "complete",
          error: null,
          routerRequest: null,
          routerRawResponse: null,
          agentConfig: null,
          agentLog: null,
          feedback: null,
          responseTs: null,
        },
      ];
      mockReadFile.mockResolvedValue(JSON.stringify(diskEvents));

      await loadEvents();

      const events = getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("t-disk-m-disk");
      expect(events[0].text).toBe("from disk");
    });
  });

  describe("resetEvents clears persist timer", () => {
    it("prevents pending persist from firing after reset", async () => {
      makeEvent({ threadTs: "t-reset", messageTs: "m-reset" });

      // Immediately reset before debounce fires
      resetEvents();

      await vi.advanceTimersByTimeAsync(2000);

      // writeFile should NOT have been called because resetEvents cleared the timer
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});
