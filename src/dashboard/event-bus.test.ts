import { describe, it, expect, beforeEach, vi } from "vitest";
import { eventBus } from "./event-bus.js";
import type { BusEvent } from "./event-bus.js";

beforeEach(() => {
  eventBus._clear();
});

// Helper to build a minimal dispatch:created event.
function createdEvent(id = "job-1"): BusEvent {
  return {
    topic: "dispatch:created",
    data: {
      id,
      repoName: "danxbot",
      trigger: "api",
      triggerMetadata: {
        endpoint: "/api/launch",
        callerIp: null,
        statusUrl: null,
        initialPrompt: "test",
      },
      sessionUuid: null,
      jsonlPath: null,
      parentJobId: null,
      status: "running",
      startedAt: Date.now(),
      completedAt: null,
      summary: null,
      error: null,
      runtimeMode: "docker",
      tokensTotal: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      toolCallCount: 0,
      subagentCount: 0,
      nudgeCount: 0,
      danxbotCommit: null,
    },
  };
}

describe("EventBus — publish / subscribe", () => {
  it("delivers an event to a subscriber of the matching topic", () => {
    const cb = vi.fn();
    eventBus.subscribe("dispatch:created", cb);
    const evt = createdEvent();
    eventBus.publish(evt);
    expect(cb).toHaveBeenCalledWith(evt);
  });

  it("does NOT deliver to a subscriber of a different topic", () => {
    const cb = vi.fn();
    eventBus.subscribe("dispatch:updated", cb);
    eventBus.publish(createdEvent());
    expect(cb).not.toHaveBeenCalled();
  });

  it("delivers to multiple subscribers on the same topic", () => {
    const a = vi.fn();
    const b = vi.fn();
    eventBus.subscribe("dispatch:created", a);
    eventBus.subscribe("dispatch:created", b);
    eventBus.publish(createdEvent());
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("the returned unsubscribe function stops delivery", () => {
    const cb = vi.fn();
    const unsub = eventBus.subscribe("dispatch:created", cb);
    unsub();
    eventBus.publish(createdEvent());
    expect(cb).not.toHaveBeenCalled();
  });

  it("handles dynamic dispatch:jsonl:<id> topic correctly", () => {
    const cb = vi.fn();
    eventBus.subscribe("dispatch:jsonl:abc123", cb);
    const evt: BusEvent = {
      topic: "dispatch:jsonl:abc123",
      data: [{ type: "assistant_text" as const, text: "hi", timestampMs: 0 }],
    };
    eventBus.publish(evt);
    expect(cb).toHaveBeenCalledWith(evt);
  });

  it("swallows subscriber callback errors so other subscribers still fire", () => {
    const throwing = vi.fn().mockImplementation(() => { throw new Error("boom"); });
    const surviving = vi.fn();
    eventBus.subscribe("dispatch:created", throwing);
    eventBus.subscribe("dispatch:created", surviving);
    eventBus.publish(createdEvent());
    expect(surviving).toHaveBeenCalledOnce();
  });
});

describe("EventBus — subscriberCount", () => {
  it("returns 0 for an unknown topic", () => {
    expect(eventBus.subscriberCount("dispatch:created")).toBe(0);
  });

  it("returns the correct count as subscribers are added and removed", () => {
    const unsub1 = eventBus.subscribe("dispatch:created", vi.fn());
    expect(eventBus.subscriberCount("dispatch:created")).toBe(1);
    const unsub2 = eventBus.subscribe("dispatch:created", vi.fn());
    expect(eventBus.subscriberCount("dispatch:created")).toBe(2);
    unsub1();
    expect(eventBus.subscriberCount("dispatch:created")).toBe(1);
    unsub2();
    expect(eventBus.subscriberCount("dispatch:created")).toBe(0);
  });
});

describe("EventBus — backpressure eviction", () => {
  it("evicts a subscriber when isSlowConsumer() returns true and calls onEvict", () => {
    const onEvict = vi.fn();
    const cb = vi.fn();
    // Subscribe with a predicate that always reports slow.
    eventBus.subscribe("dispatch:created", cb, onEvict, () => true);

    eventBus.publish(createdEvent());

    // Subscriber was evicted: onEvict called, callback NOT invoked.
    expect(onEvict).toHaveBeenCalledOnce();
    expect(cb).not.toHaveBeenCalled();
    // Evicted subscriber removed — count drops to zero.
    expect(eventBus.subscriberCount("dispatch:created")).toBe(0);
  });

  it("does not evict a subscriber when isSlowConsumer() returns false", () => {
    const onEvict = vi.fn();
    const cb = vi.fn();
    eventBus.subscribe("dispatch:created", cb, onEvict, () => false);

    eventBus.publish(createdEvent());

    expect(cb).toHaveBeenCalledOnce();
    expect(onEvict).not.toHaveBeenCalled();
  });

  it("evicts only the slow subscriber; fast ones still receive the event", () => {
    const slowEvict = vi.fn();
    const slowCb = vi.fn();
    const fastCb = vi.fn();
    eventBus.subscribe("dispatch:created", slowCb, slowEvict, () => true);
    eventBus.subscribe("dispatch:created", fastCb);

    eventBus.publish(createdEvent());

    expect(slowEvict).toHaveBeenCalledOnce();
    expect(slowCb).not.toHaveBeenCalled();
    expect(fastCb).toHaveBeenCalledOnce();
  });
});
