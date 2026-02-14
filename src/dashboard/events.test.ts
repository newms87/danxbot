import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock config to avoid requiring real environment variables
vi.mock("../config.js", () => ({
  config: {
    eventsFile: "/tmp/test-events.json",
  },
}));

// Mock fs/promises so persistence calls don't hit real disk
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
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
    expect(event.agentCostUsd).toBeNull();
    expect(event.error).toBeNull();
    expect(event.feedback).toBeNull();
    expect(event.responseTs).toBeNull();
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
      agentCostUsd: 0.05,
    });

    const found = getEvents().find((e) => e.id === event.id);
    expect(found?.status).toBe("complete");
    expect(found?.routerResponse).toBe("hi");
    expect(found?.agentCostUsd).toBe(0.05);
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
    expect(analytics).toHaveProperty("totalCostUsd");
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
    const before = getAnalytics().totalCostUsd;

    updateEvent(e1.id, {
      status: "complete",
      routerResponseAt: Date.now(),
      agentResponseAt: Date.now(),
      agentCostUsd: 0.10,
    });
    updateEvent(e2.id, {
      status: "complete",
      routerResponseAt: Date.now(),
      agentResponseAt: Date.now(),
      agentCostUsd: 0.25,
    });

    expect(getAnalytics().totalCostUsd).toBeCloseTo(before + 0.35, 2);
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
