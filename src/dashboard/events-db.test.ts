import { describe, it, expect, beforeEach, vi } from "vitest";

const mockQuery = vi.fn();
const mockExecute = vi.fn();
const mockGetPool = vi.fn(() => ({
  query: mockQuery,
  execute: mockExecute,
}));

vi.mock("../db/connection.js", () => ({
  getPool: () => mockGetPool(),
}));

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
  persistEventToDb,
  updateEventInDb,
  loadEventsFromDb,
  eventToRow,
  rowToEvent,
  COLUMN_MAP,
} from "./events-db.js";
import type { MessageEvent } from "./events.js";

function makeFullEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    id: "t-1-m-1",
    threadTs: "t-1",
    messageTs: "m-1",
    channelId: "C123",
    user: "U456",
    userName: null,
    text: "test message",
    receivedAt: 1000,
    routerResponseAt: null,
    routerResponse: null,
    routerNeedsAgent: null,
    agentResponseAt: null,
    agentResponse: null,
    agentCostUsd: null,
    agentTurns: null,
    status: "received",
    error: null,
    routerRequest: null,
    routerRawResponse: null,
    agentConfig: null,
    agentLog: null,
    agentRetried: false,
    feedback: null,
    responseTs: null,
    ...overrides,
  };
}

describe("events-db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([[], []]);
    mockQuery.mockResolvedValue([[], []]);
  });

  describe("COLUMN_MAP", () => {
    it("stores raw column names without backticks", () => {
      expect(COLUMN_MAP.user).toBe("user");
      expect(COLUMN_MAP.text).toBe("text");
      expect(COLUMN_MAP.status).toBe("status");
      expect(COLUMN_MAP.error).toBe("error");
    });

    it("maps all MessageEvent keys to snake_case columns", () => {
      expect(COLUMN_MAP.threadTs).toBe("thread_ts");
      expect(COLUMN_MAP.channelId).toBe("channel_id");
      expect(COLUMN_MAP.routerNeedsAgent).toBe("router_needs_agent");
      expect(COLUMN_MAP.agentCostUsd).toBe("agent_cost_usd");
    });
  });

  describe("eventToRow", () => {
    it("converts a MessageEvent to ordered DB row values", () => {
      const event = makeFullEvent();
      const row = eventToRow(event);
      expect(row[0]).toBe("t-1-m-1"); // id
      expect(row[1]).toBe("t-1"); // thread_ts
      expect(row).toHaveLength(Object.keys(COLUMN_MAP).length);
    });

    it("JSON-stringifies JSON columns", () => {
      const event = makeFullEvent({
        routerRequest: { model: "haiku" },
        agentLog: [{ timestamp: 1, type: "tool_use", summary: "test", data: {} }],
      });
      const row = eventToRow(event);
      // Find the routerRequest and agentLog positions by column order
      const keys = Object.keys(COLUMN_MAP);
      const routerReqIdx = keys.indexOf("routerRequest");
      const agentLogIdx = keys.indexOf("agentLog");
      expect(row[routerReqIdx]).toBe(JSON.stringify({ model: "haiku" }));
      expect(row[agentLogIdx]).toBe(
        JSON.stringify([{ timestamp: 1, type: "tool_use", summary: "test", data: {} }]),
      );
    });

    it("converts boolean columns to TINYINT", () => {
      const event = makeFullEvent({ routerNeedsAgent: true, agentRetried: true });
      const row = eventToRow(event);
      const keys = Object.keys(COLUMN_MAP);
      const needsAgentIdx = keys.indexOf("routerNeedsAgent");
      const retriedIdx = keys.indexOf("agentRetried");
      expect(row[needsAgentIdx]).toBe(1);
      expect(row[retriedIdx]).toBe(1);
    });
  });

  describe("rowToEvent", () => {
    it("converts a DB row to a MessageEvent", () => {
      const event = rowToEvent({
        id: "t-1-m-1",
        thread_ts: "t-1",
        message_ts: "m-1",
        channel_id: "C123",
        user: "U456",
        user_name: null,
        text: "test",
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
        router_request: null,
        router_raw_response: null,
        agent_config: null,
        agent_log: null,
        agent_retried: 0,
        feedback: null,
        response_ts: null,
      });
      expect(event.id).toBe("t-1-m-1");
      expect(event.threadTs).toBe("t-1");
      expect(event.agentRetried).toBe(false);
    });

    it("converts DECIMAL string to number for agent_cost_usd", () => {
      const event = rowToEvent({
        id: "t-1-m-1",
        thread_ts: "t-1",
        message_ts: "m-1",
        channel_id: "C123",
        user: "U456",
        user_name: null,
        text: "test",
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
      });
      expect(event.agentCostUsd).toBe(0.05);
      expect(typeof event.agentCostUsd).toBe("number");
    });

    it("returns null for malformed JSON instead of crashing", () => {
      const event = rowToEvent({
        id: "t-1-m-1",
        thread_ts: "t-1",
        message_ts: "m-1",
        channel_id: "C123",
        user: "U456",
        user_name: null,
        text: "test",
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
        router_request: "{invalid json",
        router_raw_response: null,
        agent_config: null,
        agent_log: null,
        agent_retried: 0,
        feedback: null,
        response_ts: null,
      });
      expect(event.routerRequest).toBeNull();
    });

    it("logs a warning when JSON parsing fails", () => {
      rowToEvent({
        id: "t-1-m-1",
        thread_ts: "t-1",
        message_ts: "m-1",
        channel_id: "C123",
        user: "U456",
        user_name: null,
        text: "test",
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
        router_request: "{invalid json",
        router_raw_response: null,
        agent_config: null,
        agent_log: null,
        agent_retried: 0,
        feedback: null,
        response_ts: null,
      });
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("router_request"),
        expect.any(Error),
      );
    });
  });

  describe("persistEventToDb", () => {
    it("executes INSERT with correct SQL and parameters", async () => {
      const event = makeFullEvent();
      await persistEventToDb(event);

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain("INSERT INTO events");
      expect(params[0]).toBe("t-1-m-1");
    });

    it("derives INSERT columns from COLUMN_MAP", async () => {
      const event = makeFullEvent();
      await persistEventToDb(event);

      const [sql, params] = mockExecute.mock.calls[0];
      // All columns from COLUMN_MAP should appear in the SQL
      const columnCount = Object.keys(COLUMN_MAP).length;
      expect(params).toHaveLength(columnCount);
      // Placeholder count should match column count
      const placeholders = sql.match(/\?/g);
      expect(placeholders).toHaveLength(columnCount);
    });

    it("JSON-stringifies JSON columns in INSERT params", async () => {
      const event = makeFullEvent({
        routerRequest: { model: "haiku" },
        agentLog: [{ timestamp: 1, type: "tool_use", summary: "s", data: {} }],
      });
      await persistEventToDb(event);

      const [, params] = mockExecute.mock.calls[0];
      const keys = Object.keys(COLUMN_MAP);
      const routerReqIdx = keys.indexOf("routerRequest");
      const agentLogIdx = keys.indexOf("agentLog");
      expect(params[routerReqIdx]).toBe(JSON.stringify({ model: "haiku" }));
      expect(params[agentLogIdx]).toBe(
        JSON.stringify([{ timestamp: 1, type: "tool_use", summary: "s", data: {} }]),
      );
    });

    it("converts booleans to TINYINT in INSERT params", async () => {
      const event = makeFullEvent({ routerNeedsAgent: true });
      await persistEventToDb(event);

      const [, params] = mockExecute.mock.calls[0];
      const keys = Object.keys(COLUMN_MAP);
      const needsAgentIdx = keys.indexOf("routerNeedsAgent");
      expect(params[needsAgentIdx]).toBe(1);
    });

    it("logs error but does not throw when DB fails", async () => {
      mockExecute.mockRejectedValue(new Error("connection refused"));
      const event = makeFullEvent();

      await persistEventToDb(event);

      expect(mockLogError).toHaveBeenCalledWith(
        "Failed to persist event to DB",
        expect.any(Error),
      );
    });
  });

  describe("updateEventInDb", () => {
    it("executes UPDATE with mapped columns", async () => {
      await updateEventInDb("test-id", { status: "routing", routerResponse: "hi" });

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain("UPDATE events SET");
      expect(sql).toContain("`status` = ?");
      expect(sql).toContain("router_response = ?");
      expect(sql).toContain("WHERE id = ?");
      expect(params[params.length - 1]).toBe("test-id");
    });

    it("JSON-stringifies JSON columns in UPDATE params", async () => {
      await updateEventInDb("test-id", {
        agentLog: [{ timestamp: 1, type: "tool_use", summary: "s", data: {} }] as any,
      });

      const [, params] = mockExecute.mock.calls[0];
      expect(params[0]).toBe(
        JSON.stringify([{ timestamp: 1, type: "tool_use", summary: "s", data: {} }]),
      );
    });

    it("converts booleans to TINYINT in UPDATE params", async () => {
      await updateEventInDb("test-id", { agentRetried: true });

      const [, params] = mockExecute.mock.calls[0];
      expect(params[0]).toBe(1);
    });

    it("does NOT call execute when updates object is empty", async () => {
      await updateEventInDb("test-id", {});

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("does NOT call execute when all keys are unknown", async () => {
      await updateEventInDb("test-id", { unknownKey: "value" } as any);

      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("logs error but does not throw when DB fails", async () => {
      mockExecute.mockRejectedValue(new Error("connection refused"));

      await updateEventInDb("test-id", { status: "error" });

      expect(mockLogError).toHaveBeenCalledWith(
        "Failed to update event in DB",
        expect.any(Error),
      );
    });
  });

  describe("loadEventsFromDb", () => {
    it("loads events from DB and converts rows", async () => {
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

      const events = await loadEventsFromDb(500);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("t-db-m-db");
      expect(events[0].text).toBe("from database");
    });

    it("uses parameterized LIMIT with MAX_EVENTS", async () => {
      mockQuery.mockResolvedValue([[], []]);

      await loadEventsFromDb(500);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("LIMIT ?");
      expect(sql).not.toContain("LIMIT 500");
      expect(params).toEqual([500]);
    });

    it("falls back gracefully when DB is unavailable", async () => {
      mockQuery.mockRejectedValue(new Error("connection refused"));

      const events = await loadEventsFromDb(500);
      expect(events).toEqual([]);
      expect(mockLogError).toHaveBeenCalledWith(
        "Failed to load events from DB",
        expect.any(Error),
      );
    });

    it("falls back gracefully when getPool() throws synchronously", async () => {
      mockGetPool.mockImplementationOnce(() => {
        throw new Error("pool init failed");
      });

      const events = await loadEventsFromDb(500);
      expect(events).toEqual([]);
      expect(mockLogError).toHaveBeenCalledWith(
        "Failed to load events from DB",
        expect.any(Error),
      );
    });
  });
});
