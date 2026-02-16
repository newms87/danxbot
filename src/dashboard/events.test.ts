import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock config to avoid requiring real environment variables
vi.mock("../config.js", () => ({
  config: {
    db: {
      eventsMaxAgeDays: 30,
    },
  },
}));

const mockDeleteOldEventsFromDb = vi.fn().mockResolvedValue(0);

// Mock the db connection module so persistence calls don't hit a real DB
vi.mock("../db/connection.js", () => ({
  getPool: vi.fn(() => ({
    query: vi.fn().mockResolvedValue([[], []]),
    execute: vi.fn().mockResolvedValue([[], []]),
  })),
}));

vi.mock("./events-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./events-db.js")>();
  return {
    ...actual,
    deleteOldEventsFromDb: (...args: unknown[]) => mockDeleteOldEventsFromDb(...args),
  };
});

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createEvent,
  updateEvent,
  getEvents,
  getAnalytics,
  addSSEClient,
  removeSSEClient,
  resetEvents,
  findEventByResponseTs,
  getResponseTimeMs,
  cleanupOldEvents,
  startEventCleanup,
  stopEventCleanup,
} from "./events.js";

beforeEach(() => {
  resetEvents();
});

function makeEvent(overrides: Partial<Parameters<typeof createEvent>[0]> = {}) {
  return createEvent({
    threadTs: overrides.threadTs ?? `t-${Date.now()}-${Math.random()}`,
    messageTs: overrides.messageTs ?? `m-${Date.now()}-${Math.random()}`,
    channelId: overrides.channelId ?? "C123",
    user: overrides.user ?? "U456",
    text: overrides.text ?? "test message",
  });
}

describe("createEvent", () => {
  it("creates event with correct defaults", () => {
    const event = makeEvent();

    expect(event.status).toBe("received");
    expect(event.receivedAt).toBeTypeOf("number");
    expect(event.routerResponse).toBeNull();
    expect(event.routerNeedsAgent).toBeNull();
    expect(event.agentResponse).toBeNull();
    expect(event.subscriptionCostUsd).toBeNull();
    expect(event.error).toBeNull();
    expect(event.feedback).toBeNull();
    expect(event.responseTs).toBeNull();
    expect(event.apiCalls).toBeNull();
    expect(event.apiCostUsd).toBeNull();
    expect(event.agentUsage).toBeNull();
  });

  it("generates ID from threadTs-messageTs", () => {
    const event = createEvent({
      threadTs: "1234.5678",
      messageTs: "9999.0000",
      channelId: "C1",
      user: "U1",
      text: "test",
    });

    expect(event.id).toBe("1234.5678-9999.0000");
  });

  it("adds event to the events array", () => {
    makeEvent();
    expect(getEvents().length).toBe(1);
  });

  it("prepends new events (most recent first)", () => {
    const event = makeEvent();
    expect(getEvents()[0].id).toBe(event.id);
  });
});

describe("updateEvent", () => {
  it("applies partial updates to an existing event", () => {
    const event = makeEvent();
    updateEvent(event.id, { status: "routing" });

    const found = getEvents().find((e) => e.id === event.id);
    expect(found?.status).toBe("routing");
  });

  it("does nothing for non-existent event ID", () => {
    const before = getEvents().length;
    updateEvent("nonexistent-id", { status: "error" });
    expect(getEvents().length).toBe(before);
  });

  it("applies multiple fields at once", () => {
    const event = makeEvent();
    updateEvent(event.id, {
      status: "complete",
      routerResponse: "hi",
      subscriptionCostUsd: 0.05,
    });

    const found = getEvents().find((e) => e.id === event.id);
    expect(found?.status).toBe("complete");
    expect(found?.routerResponse).toBe("hi");
    expect(found?.subscriptionCostUsd).toBe(0.05);
  });
});

describe("getAnalytics", () => {
  it("returns analytics object with expected shape", () => {
    const analytics = getAnalytics();

    expect(analytics).toHaveProperty("totalMessages");
    expect(analytics).toHaveProperty("completedMessages");
    expect(analytics).toHaveProperty("routerOnlyMessages");
    expect(analytics).toHaveProperty("agentMessages");
    expect(analytics).toHaveProperty("avgRouterTimeMs");
    expect(analytics).toHaveProperty("avgAgentTimeMs");
    expect(analytics).toHaveProperty("avgTotalTimeMs");
    expect(analytics).toHaveProperty("totalSubscriptionCostUsd");
    expect(analytics).toHaveProperty("totalApiCostUsd");
    expect(analytics).toHaveProperty("totalCombinedCostUsd");
    expect(analytics).toHaveProperty("errorCount");
  });

  it("counts completed events correctly", () => {
    const event = makeEvent();
    const beforeCompleted = getAnalytics().completedMessages;

    updateEvent(event.id, {
      status: "complete",
      routerResponseAt: Date.now(),
    });

    expect(getAnalytics().completedMessages).toBe(beforeCompleted + 1);
  });

  it("sums agent costs", () => {
    const e1 = makeEvent();
    const e2 = makeEvent();
    const before = getAnalytics().totalSubscriptionCostUsd;

    updateEvent(e1.id, {
      status: "complete",
      routerResponseAt: Date.now(),
      agentResponseAt: Date.now(),
      subscriptionCostUsd: 0.10,
    });
    updateEvent(e2.id, {
      status: "complete",
      routerResponseAt: Date.now(),
      agentResponseAt: Date.now(),
      subscriptionCostUsd: 0.25,
    });

    expect(getAnalytics().totalSubscriptionCostUsd).toBeCloseTo(before + 0.35, 2);
  });

  it("sums API costs across all completed events", () => {
    const e1 = makeEvent();
    const e2 = makeEvent();

    updateEvent(e1.id, {
      status: "complete",
      routerResponseAt: Date.now(),
      apiCostUsd: 0.001,
    });
    updateEvent(e2.id, {
      status: "complete",
      routerResponseAt: Date.now(),
      apiCostUsd: 0.002,
    });

    expect(getAnalytics().totalApiCostUsd).toBeCloseTo(0.003, 6);
  });

  it("computes combined cost as sum of subscription and API costs", () => {
    const e1 = makeEvent();

    updateEvent(e1.id, {
      status: "complete",
      routerResponseAt: Date.now(),
      agentResponseAt: Date.now(),
      subscriptionCostUsd: 0.10,
      apiCostUsd: 0.005,
    });

    const analytics = getAnalytics();
    expect(analytics.totalCombinedCostUsd).toBeCloseTo(0.105, 6);
  });

  it("returns zero API cost when no events have apiCostUsd", () => {
    const e1 = makeEvent();
    updateEvent(e1.id, { status: "complete", routerResponseAt: Date.now() });

    expect(getAnalytics().totalApiCostUsd).toBe(0);
  });

  it("counts errors", () => {
    const event = makeEvent();
    updateEvent(event.id, { status: "error", error: "something broke" });
    expect(getAnalytics().errorCount).toBe(1);
  });
});

describe("MAX_EVENTS cap", () => {
  it("evicts oldest event when exceeding 500", () => {
    const events: ReturnType<typeof makeEvent>[] = [];
    for (let i = 0; i < 501; i++) {
      events.push(makeEvent({ threadTs: `t-${i}`, messageTs: `m-${i}` }));
    }

    expect(getEvents().length).toBe(500);
    // Most recent should be first
    expect(getEvents()[0].id).toBe("t-500-m-500");
    // Oldest (first created) should have been evicted
    expect(getEvents().find((e) => e.id === "t-0-m-0")).toBeUndefined();
  });
});

describe("SSE broadcast", () => {
  it("broadcasts to SSE clients on createEvent", () => {
    const received: string[] = [];
    const client = (data: string) => received.push(data);

    addSSEClient(client);
    const event = makeEvent();

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]).id).toBe(event.id);
  });

  it("broadcasts to SSE clients on updateEvent", () => {
    const received: string[] = [];
    const client = (data: string) => received.push(data);

    const event = makeEvent();
    addSSEClient(client);
    updateEvent(event.id, { status: "routing" });

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]).status).toBe("routing");
  });

  it("stops broadcasting after removeSSEClient", () => {
    const received: string[] = [];
    const client = (data: string) => received.push(data);

    addSSEClient(client);
    makeEvent(); // 1 broadcast
    removeSSEClient(client);
    makeEvent(); // should not reach client

    expect(received).toHaveLength(1);
  });
});

describe("findEventByResponseTs", () => {
  it("returns matching event by responseTs", () => {
    const event = makeEvent();
    updateEvent(event.id, { responseTs: "1234.5678" });

    const found = findEventByResponseTs("1234.5678");
    expect(found?.id).toBe(event.id);
  });

  it("returns undefined for unknown responseTs", () => {
    makeEvent();
    expect(findEventByResponseTs("nonexistent")).toBeUndefined();
  });
});

describe("feedback", () => {
  it("can set feedback to positive via updateEvent", () => {
    const event = makeEvent();
    updateEvent(event.id, { feedback: "positive" });

    const found = getEvents().find((e) => e.id === event.id);
    expect(found?.feedback).toBe("positive");
  });

  it("can set feedback to negative via updateEvent", () => {
    const event = makeEvent();
    updateEvent(event.id, { feedback: "negative" });

    const found = getEvents().find((e) => e.id === event.id);
    expect(found?.feedback).toBe("negative");
  });

  it("includes feedback stats in analytics", () => {
    const e1 = makeEvent();
    const e2 = makeEvent();
    const e3 = makeEvent();

    updateEvent(e1.id, { status: "complete", feedback: "positive" });
    updateEvent(e2.id, { status: "complete", feedback: "negative" });
    updateEvent(e3.id, { status: "complete" });

    const analytics = getAnalytics();
    expect(analytics.feedbackPositive).toBe(1);
    expect(analytics.feedbackNegative).toBe(1);
    expect(analytics.feedbackRate).toBeCloseTo(2 / 3, 2);
  });

  it("returns zero feedback stats when no events", () => {
    const analytics = getAnalytics();
    expect(analytics.feedbackPositive).toBe(0);
    expect(analytics.feedbackNegative).toBe(0);
    expect(analytics.feedbackRate).toBe(0);
  });
});

describe("parsedAgentLog auto-parsing", () => {
  it("auto-parses agentLog when updateEvent receives it", () => {
    const event = makeEvent();
    updateEvent(event.id, {
      agentLog: [
        {
          timestamp: 1000,
          type: "system",
          subtype: "init",
          summary: "Session initialized: sonnet",
          data: { session_id: "s1", model: "sonnet", tools: ["Read"], delta_ms: 0, raw: {} },
        },
        {
          timestamp: 2000,
          type: "assistant",
          summary: "Text: Hello",
          data: {
            content: [{ type: "text", text: "Hello world" }],
            usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            delta_ms: 1000,
            raw: { message: { model: "sonnet" } },
          },
        },
      ],
    });

    const found = getEvents().find((e) => e.id === event.id);
    expect(found?.parsedAgentLog).toHaveLength(2);
    expect(found?.parsedAgentLog?.[0].type).toBe("system_init");
    expect(found?.parsedAgentLog?.[1].type).toBe("assistant");
  });

  it("does not re-parse when parsedAgentLog is already provided", () => {
    const event = makeEvent();
    const customParsed = [{ type: "system_init" as const, timestamp: 1, deltaMs: 0, sessionId: "x", model: "m", tools: [] }];
    updateEvent(event.id, {
      agentLog: [{ timestamp: 1, type: "system", subtype: "init", summary: "s", data: { session_id: "x", model: "m", tools: [], delta_ms: 0, raw: {} } }],
      parsedAgentLog: customParsed,
    });

    const found = getEvents().find((e) => e.id === event.id);
    expect(found?.parsedAgentLog).toBe(customParsed);
  });

  it("defaults parsedAgentLog to null on createEvent", () => {
    const event = makeEvent();
    expect(event.parsedAgentLog).toBeNull();
  });
});

describe("cleanupOldEvents", () => {
  it("calls deleteOldEventsFromDb with maxAgeMs derived from config", async () => {
    mockDeleteOldEventsFromDb.mockResolvedValueOnce(5);

    await cleanupOldEvents();

    expect(mockDeleteOldEventsFromDb).toHaveBeenCalledWith(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  it("does not throw when deleteOldEventsFromDb fails", async () => {
    mockDeleteOldEventsFromDb.mockRejectedValueOnce(new Error("db error"));

    await expect(cleanupOldEvents()).resolves.toBeUndefined();
  });
});

describe("startEventCleanup", () => {
  it("returns an interval reference", () => {
    const interval = startEventCleanup();
    expect(interval).toBeDefined();
    clearInterval(interval);
  });

  it("runs cleanup immediately on startup", async () => {
    vi.useFakeTimers();

    const interval = startEventCleanup();

    await vi.waitFor(() => {
      expect(mockDeleteOldEventsFromDb).toHaveBeenCalled();
    });

    clearInterval(interval);
    vi.useRealTimers();
  });
});

describe("stopEventCleanup", () => {
  it("clears the interval", () => {
    vi.useFakeTimers();
    const interval = startEventCleanup();

    stopEventCleanup(interval);

    vi.clearAllMocks();
    vi.advanceTimersByTime(7 * 60 * 60 * 1000); // beyond 6hr interval
    expect(mockDeleteOldEventsFromDb).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe("getResponseTimeMs", () => {
  it("returns agentResponseAt - receivedAt when agent responded", () => {
    const event = makeEvent();
    updateEvent(event.id, {
      routerResponseAt: event.receivedAt + 200,
      agentResponseAt: event.receivedAt + 1500,
    });
    const updated = getEvents().find((e) => e.id === event.id)!;
    expect(getResponseTimeMs(updated)).toBe(1500);
  });

  it("returns routerResponseAt - receivedAt when no agent response", () => {
    const event = makeEvent();
    updateEvent(event.id, {
      routerResponseAt: event.receivedAt + 400,
    });
    const updated = getEvents().find((e) => e.id === event.id)!;
    expect(getResponseTimeMs(updated)).toBe(400);
  });

  it("returns 0 when no response times available", () => {
    const event = makeEvent();
    expect(getResponseTimeMs(event)).toBe(0);
  });
});
