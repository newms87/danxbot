import { describe, it, expect, beforeEach, vi } from "vitest";

const mockQuery = vi.fn();
const mockExecute = vi.fn();

vi.mock("../db/connection.js", () => ({
  getPool: vi.fn(() => ({
    query: mockQuery,
    execute: mockExecute,
  })),
}));

vi.mock("../config.js", () => ({
  config: {},
}));

// Mock logger so we can assert on error/info calls
const mockLogError = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
  }),
}));

import {
  createEvent,
  updateEvent,
  getEvents,
  resetEvents,
  loadEvents,
} from "./events.js";

import { COLUMN_MAP } from "./events-db.js";

function makeEvent(overrides: Partial<Parameters<typeof createEvent>[0]> = {}) {
  return createEvent({
    threadTs: overrides.threadTs ?? `t-${Date.now()}-${Math.random()}`,
    messageTs: overrides.messageTs ?? `m-${Date.now()}-${Math.random()}`,
    channelId: overrides.channelId ?? "C123",
    user: overrides.user ?? "U456",
    text: overrides.text ?? "test message",
  });
}

describe("DB persistence", () => {
  beforeEach(() => {
    resetEvents();
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([[], []]);
    mockQuery.mockResolvedValue([[], []]);
  });

  describe("createEvent", () => {
    it("inserts into the events table", async () => {
      makeEvent({ threadTs: "t-1", messageTs: "m-1" });

      // Fire-and-forget is async, give it a tick
      await vi.waitFor(() => {
        expect(mockExecute).toHaveBeenCalledTimes(1);
      });

      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain("INSERT INTO events");
      expect(params[0]).toBe("t-1-m-1"); // id
      expect(params[1]).toBe("t-1"); // thread_ts
      expect(params[2]).toBe("m-1"); // message_ts
    });

    it("does not break in-memory flow when DB insert fails", async () => {
      mockExecute.mockRejectedValue(new Error("connection refused"));

      const event = makeEvent({ threadTs: "t-fail", messageTs: "m-fail" });

      // Event should still be in memory
      expect(getEvents()).toHaveLength(1);
      expect(getEvents()[0].id).toBe(event.id);

      // Wait for the async DB call to complete and log
      await vi.waitFor(() => {
        expect(mockLogError).toHaveBeenCalledWith(
          "Failed to persist event to DB",
          expect.any(Error),
        );
      });
    });

    it("JSON-stringifies JSON columns in INSERT params", async () => {
      // createEvent doesn't set JSON fields, so we test through updateEvent
      // But we can verify that null JSON columns produce null params
      makeEvent({ threadTs: "t-json", messageTs: "m-json" });

      await vi.waitFor(() => {
        expect(mockExecute).toHaveBeenCalledTimes(1);
      });

      const [, params] = mockExecute.mock.calls[0];
      const keys = Object.keys(COLUMN_MAP);
      const routerReqIdx = keys.indexOf("routerRequest");
      // Default event has null for JSON columns
      expect(params[routerReqIdx]).toBeNull();
    });

    it("converts boolean false to 0 in INSERT params", async () => {
      makeEvent({ threadTs: "t-bool", messageTs: "m-bool" });

      await vi.waitFor(() => {
        expect(mockExecute).toHaveBeenCalledTimes(1);
      });

      const [, params] = mockExecute.mock.calls[0];
      const keys = Object.keys(COLUMN_MAP);
      const retriedIdx = keys.indexOf("agentRetried");
      expect(params[retriedIdx]).toBe(0);
    });
  });

  describe("updateEvent", () => {
    it("updates the events table with changed fields", async () => {
      const event = makeEvent({ threadTs: "t-u", messageTs: "m-u" });
      vi.clearAllMocks();
      mockExecute.mockResolvedValue([[], []]);

      updateEvent(event.id, { status: "routing", routerResponse: "hi" });

      await vi.waitFor(() => {
        expect(mockExecute).toHaveBeenCalledTimes(1);
      });

      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain("UPDATE events SET");
      expect(sql).toContain("`status` = ?");
      expect(sql).toContain("router_response = ?");
      expect(sql).toContain("WHERE id = ?");
      // Last param is the event id
      expect(params[params.length - 1]).toBe("t-u-m-u");
    });

    it("does not call DB when event is not found", async () => {
      vi.clearAllMocks();

      updateEvent("nonexistent-id", { status: "error" });

      // Give a tick for any potential async call
      await new Promise((r) => setTimeout(r, 10));
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("does not break in-memory flow when DB update fails", async () => {
      const event = makeEvent({ threadTs: "t-uf", messageTs: "m-uf" });
      vi.clearAllMocks();
      mockExecute.mockRejectedValue(new Error("connection refused"));

      updateEvent(event.id, { status: "complete" });

      // In-memory should still be updated
      const found = getEvents().find((e) => e.id === event.id);
      expect(found?.status).toBe("complete");

      await vi.waitFor(() => {
        expect(mockLogError).toHaveBeenCalledWith(
          "Failed to update event in DB",
          expect.any(Error),
        );
      });
    });

    it("JSON-stringifies agentLog in UPDATE params", async () => {
      const event = makeEvent({ threadTs: "t-jup", messageTs: "m-jup" });
      vi.clearAllMocks();
      mockExecute.mockResolvedValue([[], []]);

      const agentLog = [{ timestamp: 1, type: "tool_use", summary: "test", data: {} }];
      updateEvent(event.id, { agentLog } as any);

      await vi.waitFor(() => {
        expect(mockExecute).toHaveBeenCalledTimes(1);
      });

      const [, params] = mockExecute.mock.calls[0];
      // First param is the agentLog value, last is the id
      expect(params[0]).toBe(JSON.stringify(agentLog));
    });

    it("converts agentRetried=true to 1 in UPDATE params", async () => {
      const event = makeEvent({ threadTs: "t-bup", messageTs: "m-bup" });
      vi.clearAllMocks();
      mockExecute.mockResolvedValue([[], []]);

      updateEvent(event.id, { agentRetried: true });

      await vi.waitFor(() => {
        expect(mockExecute).toHaveBeenCalledTimes(1);
      });

      const [, params] = mockExecute.mock.calls[0];
      expect(params[0]).toBe(1);
    });

    it("does NOT call execute when updates is empty", async () => {
      const event = makeEvent({ threadTs: "t-empty", messageTs: "m-empty" });
      vi.clearAllMocks();
      mockExecute.mockResolvedValue([[], []]);

      updateEvent(event.id, {});

      await new Promise((r) => setTimeout(r, 10));
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("does NOT call execute when all keys are unknown", async () => {
      const event = makeEvent({ threadTs: "t-unk", messageTs: "m-unk" });
      vi.clearAllMocks();
      mockExecute.mockResolvedValue([[], []]);

      updateEvent(event.id, { unknownKey: "value" } as any);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe("loadEvents", () => {
    it("loads events from DB when available", async () => {
      mockQuery.mockResolvedValue([
        [
          {
            id: "t-db-m-db",
            thread_ts: "t-db",
            message_ts: "m-db",
            channel_id: "C1",
            user: "U1",
            user_name: "Test User",
            text: "from database",
            received_at: 5000,
            router_response_at: null,
            router_response: null,
            router_needs_agent: null,
            agent_response_at: null,
            agent_response: null,
            agent_cost_usd: null,
            agent_turns: null,
            status: "complete",
            error: null,
            router_request: null,
            router_raw_response: null,
            agent_config: null,
            agent_log: null,
            agent_retried: 0,
            feedback: null,
            response_ts: null,
          },
        ],
        [],
      ]);

      await loadEvents();

      const events = getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("t-db-m-db");
      expect(events[0].text).toBe("from database");
      expect(events[0].threadTs).toBe("t-db");
      expect(events[0].channelId).toBe("C1");
      expect(events[0].userName).toBe("Test User");
      expect(mockLogInfo).toHaveBeenCalledWith("Loaded 1 events from database");
    });

    it("converts snake_case DB rows to camelCase MessageEvent objects", async () => {
      mockQuery.mockResolvedValue([
        [
          {
            id: "t-c-m-c",
            thread_ts: "t-c",
            message_ts: "m-c",
            channel_id: "C99",
            user: "U99",
            user_name: null,
            text: "conversion test",
            received_at: 1000,
            router_response_at: 2000,
            router_response: "quick reply",
            router_needs_agent: 1,
            agent_response_at: 3000,
            agent_response: "agent reply",
            agent_cost_usd: "0.0500",
            agent_turns: 3,
            status: "complete",
            error: null,
            router_request: JSON.stringify({ model: "haiku" }),
            router_raw_response: JSON.stringify({ text: "hi" }),
            agent_config: JSON.stringify({ maxTurns: 10 }),
            agent_log: JSON.stringify([{ type: "tool_use" }]),
            agent_retried: 1,
            feedback: "positive",
            response_ts: "1234.5678",
          },
        ],
        [],
      ]);

      await loadEvents();

      const event = getEvents()[0];
      expect(event.threadTs).toBe("t-c");
      expect(event.messageTs).toBe("m-c");
      expect(event.channelId).toBe("C99");
      expect(event.routerResponseAt).toBe(2000);
      expect(event.routerResponse).toBe("quick reply");
      expect(event.routerNeedsAgent).toBe(true);
      expect(event.agentResponseAt).toBe(3000);
      expect(event.agentResponse).toBe("agent reply");
      expect(event.agentCostUsd).toBeCloseTo(0.05);
      expect(event.agentTurns).toBe(3);
      expect(event.agentRetried).toBe(true);
      expect(event.feedback).toBe("positive");
      expect(event.responseTs).toBe("1234.5678");
      expect(event.routerRequest).toEqual({ model: "haiku" });
      expect(event.routerRawResponse).toEqual({ text: "hi" });
      expect(event.agentConfig).toEqual({ maxTurns: 10 });
      expect(event.agentLog).toEqual([{ type: "tool_use" }]);
    });

    it("falls back gracefully when DB is unavailable", async () => {
      mockQuery.mockRejectedValue(new Error("connection refused"));

      await loadEvents();

      expect(getEvents()).toHaveLength(0);
      expect(mockLogError).toHaveBeenCalledWith(
        "Failed to load events from DB",
        expect.any(Error),
      );
    });

    it("uses parameterized LIMIT in DB query", async () => {
      await loadEvents();

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("LIMIT ?");
      expect(params).toEqual([500]);
    });

    it("replaces existing in-memory events with DB data", async () => {
      // Add an event to memory
      makeEvent({ threadTs: "t-mem", messageTs: "m-mem", text: "in memory" });
      vi.clearAllMocks();

      mockQuery.mockResolvedValue([
        [
          {
            id: "t-db2-m-db2",
            thread_ts: "t-db2",
            message_ts: "m-db2",
            channel_id: "C9",
            user: "U9",
            user_name: null,
            text: "from db",
            received_at: 5000,
            router_response_at: null,
            router_response: null,
            router_needs_agent: null,
            agent_response_at: null,
            agent_response: null,
            agent_cost_usd: null,
            agent_turns: null,
            status: "complete",
            error: null,
            router_request: null,
            router_raw_response: null,
            agent_config: null,
            agent_log: null,
            agent_retried: 0,
            feedback: null,
            response_ts: null,
          },
        ],
        [],
      ]);

      await loadEvents();

      const events = getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("t-db2-m-db2");
    });

    it("returns null for malformed JSON in DB rows instead of crashing", async () => {
      mockQuery.mockResolvedValue([
        [
          {
            id: "t-bad-m-bad",
            thread_ts: "t-bad",
            message_ts: "m-bad",
            channel_id: "C1",
            user: "U1",
            user_name: null,
            text: "bad json test",
            received_at: 1000,
            router_response_at: null,
            router_response: null,
            router_needs_agent: null,
            agent_response_at: null,
            agent_response: null,
            agent_cost_usd: null,
            agent_turns: null,
            status: "received",
            error: null,
            router_request: "{not valid json",
            router_raw_response: null,
            agent_config: null,
            agent_log: null,
            agent_retried: 0,
            feedback: null,
            response_ts: null,
          },
        ],
        [],
      ]);

      await loadEvents();

      const event = getEvents()[0];
      expect(event.routerRequest).toBeNull();
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("router_request"),
        expect.any(Error),
      );
    });

    it("converts DECIMAL string agent_cost_usd to number", async () => {
      mockQuery.mockResolvedValue([
        [
          {
            id: "t-dec-m-dec",
            thread_ts: "t-dec",
            message_ts: "m-dec",
            channel_id: "C1",
            user: "U1",
            user_name: null,
            text: "decimal test",
            received_at: 1000,
            router_response_at: null,
            router_response: null,
            router_needs_agent: null,
            agent_response_at: null,
            agent_response: null,
            agent_cost_usd: "0.0500",
            agent_turns: null,
            status: "complete",
            error: null,
            router_request: null,
            router_raw_response: null,
            agent_config: null,
            agent_log: null,
            agent_retried: 0,
            feedback: null,
            response_ts: null,
          },
        ],
        [],
      ]);

      await loadEvents();

      const event = getEvents()[0];
      expect(event.agentCostUsd).toBe(0.05);
      expect(typeof event.agentCostUsd).toBe("number");
    });
  });
});
