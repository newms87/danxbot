import { describe, it, expect, beforeEach } from "vitest";
import {
  isProcessing,
  markProcessing,
  markIdle,
  enqueue,
  dequeue,
  queueSize,
  getQueueStats,
  getTotalQueuedCount,
  resetQueue,
} from "./message-queue.js";
import type { QueuedMessage } from "./message-queue.js";

function makeQueuedMessage(overrides?: Partial<QueuedMessage>): QueuedMessage {
  return {
    threadTs: "1234567890.000001",
    messageTs: "1234567890.000100",
    channelId: "C-TEST",
    userId: "U-HUMAN",
    text: "Hello",
    queuedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  resetQueue();
});

describe("isProcessing / markProcessing / markIdle", () => {
  it("returns false for a thread that is not processing", () => {
    expect(isProcessing("thread-1")).toBe(false);
  });

  it("returns true after markProcessing", () => {
    markProcessing("thread-1");
    expect(isProcessing("thread-1")).toBe(true);
  });

  it("returns false after markIdle", () => {
    markProcessing("thread-1");
    markIdle("thread-1");
    expect(isProcessing("thread-1")).toBe(false);
  });

  it("tracks multiple threads independently", () => {
    markProcessing("thread-1");
    markProcessing("thread-2");
    expect(isProcessing("thread-1")).toBe(true);
    expect(isProcessing("thread-2")).toBe(true);

    markIdle("thread-1");
    expect(isProcessing("thread-1")).toBe(false);
    expect(isProcessing("thread-2")).toBe(true);
  });
});

describe("enqueue / dequeue", () => {
  it("dequeues messages in FIFO order", () => {
    const msg1 = makeQueuedMessage({ text: "first" });
    const msg2 = makeQueuedMessage({ text: "second" });
    enqueue(msg1);
    enqueue(msg2);

    expect(dequeue("1234567890.000001")).toEqual(msg1);
    expect(dequeue("1234567890.000001")).toEqual(msg2);
  });

  it("returns undefined when queue is empty", () => {
    expect(dequeue("nonexistent")).toBeUndefined();
  });

  it("returns undefined after all messages are dequeued", () => {
    enqueue(makeQueuedMessage());
    dequeue("1234567890.000001");
    expect(dequeue("1234567890.000001")).toBeUndefined();
  });

  it("queues messages per-thread independently", () => {
    const msg1 = makeQueuedMessage({ threadTs: "thread-A", text: "A" });
    const msg2 = makeQueuedMessage({ threadTs: "thread-B", text: "B" });
    enqueue(msg1);
    enqueue(msg2);

    expect(dequeue("thread-A")).toEqual(msg1);
    expect(dequeue("thread-B")).toEqual(msg2);
    expect(dequeue("thread-A")).toBeUndefined();
    expect(dequeue("thread-B")).toBeUndefined();
  });
});

describe("queueSize", () => {
  it("returns 0 for empty/nonexistent queue", () => {
    expect(queueSize("nonexistent")).toBe(0);
  });

  it("returns correct count after enqueue", () => {
    enqueue(makeQueuedMessage());
    enqueue(makeQueuedMessage());
    expect(queueSize("1234567890.000001")).toBe(2);
  });

  it("decrements after dequeue", () => {
    enqueue(makeQueuedMessage());
    enqueue(makeQueuedMessage());
    dequeue("1234567890.000001");
    expect(queueSize("1234567890.000001")).toBe(1);
  });
});

describe("getQueueStats", () => {
  it("returns empty object when no queues exist", () => {
    expect(getQueueStats()).toEqual({});
  });

  it("returns sizes keyed by threadTs", () => {
    enqueue(makeQueuedMessage({ threadTs: "thread-A" }));
    enqueue(makeQueuedMessage({ threadTs: "thread-A" }));
    enqueue(makeQueuedMessage({ threadTs: "thread-B" }));

    expect(getQueueStats()).toEqual({
      "thread-A": 2,
      "thread-B": 1,
    });
  });
});

describe("getTotalQueuedCount", () => {
  it("returns 0 when no messages are queued", () => {
    expect(getTotalQueuedCount()).toBe(0);
  });

  it("returns total across all threads", () => {
    enqueue(makeQueuedMessage({ threadTs: "thread-A" }));
    enqueue(makeQueuedMessage({ threadTs: "thread-A" }));
    enqueue(makeQueuedMessage({ threadTs: "thread-B" }));
    expect(getTotalQueuedCount()).toBe(3);
  });
});

describe("resetQueue", () => {
  it("clears all queues and processing state", () => {
    markProcessing("thread-1");
    enqueue(makeQueuedMessage({ threadTs: "thread-1" }));
    enqueue(makeQueuedMessage({ threadTs: "thread-2" }));

    resetQueue();

    expect(isProcessing("thread-1")).toBe(false);
    expect(queueSize("thread-1")).toBe(0);
    expect(queueSize("thread-2")).toBe(0);
    expect(getTotalQueuedCount()).toBe(0);
  });
});
