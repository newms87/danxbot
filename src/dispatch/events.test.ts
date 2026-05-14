/**
 * DX-365 — `dispatchEvents` bus tests. Singleton EventEmitter; the bus
 * is the wire between `recordStrike` (producer) and Phase 4's
 * evaluator-dispatcher (consumer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchEvents } from "./events.js";

describe("dispatchEvents", () => {
  beforeEach(() => {
    dispatchEvents.removeAllListeners();
  });
  afterEach(() => {
    dispatchEvents.removeAllListeners();
  });

  it("delivers broken-transition events to every listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    dispatchEvents.on("broken-transition", a);
    dispatchEvents.on("broken-transition", b);

    dispatchEvents.emit("broken-transition", {
      repoName: "r",
      agentName: "alice",
    });

    expect(a).toHaveBeenCalledWith({ repoName: "r", agentName: "alice" });
    expect(b).toHaveBeenCalledWith({ repoName: "r", agentName: "alice" });
  });

  it("isolates a throwing listener — other listeners still fire", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    dispatchEvents.on("broken-transition", bad);
    dispatchEvents.on("broken-transition", good);

    expect(() =>
      dispatchEvents.emit("broken-transition", {
        repoName: "r",
        agentName: "alice",
      }),
    ).not.toThrow();
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it("isolates an async listener that rejects", async () => {
    const bad = vi.fn(async () => {
      throw new Error("async boom");
    });
    const good = vi.fn();
    dispatchEvents.on("broken-transition", bad);
    dispatchEvents.on("broken-transition", good);

    dispatchEvents.emit("broken-transition", {
      repoName: "r",
      agentName: "alice",
    });

    // Both listeners were invoked synchronously; the bad one's rejection
    // is caught + logged inside the bus so the emit() call doesn't
    // throw and the queue stays drained.
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    // Yield to the microtask queue so the inner `.catch(...)` runs.
    await Promise.resolve();
  });

  it("listenerCount + removeAllListeners drain the bus", () => {
    dispatchEvents.on("broken-transition", () => {});
    dispatchEvents.on("broken-transition", () => {});
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(2);
    dispatchEvents.removeAllListeners();
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(0);
  });
});
