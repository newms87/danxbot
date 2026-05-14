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

  // DX-367 — `on()` wraps every caller-supplied listener so a bad
  // subscriber cannot wedge the bus, which means `off()` cannot
  // remove the listener directly (the EventEmitter holds the wrapper,
  // not the original). The wrapper-lookup machinery in events.ts is
  // pinned here so a regression that breaks `off()` lands fast.
  it("off() unsubscribes a registered listener — subsequent emit does not call it", () => {
    const fn = vi.fn();
    dispatchEvents.on("broken-transition", fn);
    dispatchEvents.off("broken-transition", fn);
    dispatchEvents.emit("broken-transition", {
      repoName: "r",
      agentName: "a",
    });
    expect(fn).not.toHaveBeenCalled();
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(0);
  });

  it("off() on a never-registered listener is a silent no-op", () => {
    const never = vi.fn();
    expect(() =>
      dispatchEvents.off("broken-transition", never),
    ).not.toThrow();
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(0);
  });

  it("off() leaves sibling listeners attached when one of many unsubscribes", () => {
    const keep = vi.fn();
    const drop = vi.fn();
    dispatchEvents.on("broken-transition", keep);
    dispatchEvents.on("broken-transition", drop);
    dispatchEvents.off("broken-transition", drop);
    dispatchEvents.emit("broken-transition", {
      repoName: "r",
      agentName: "a",
    });
    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(1);
  });

  it("on() N times + off() N times drains a duplicate registration cleanly", () => {
    // EventEmitter semantics: same function registered N times needs
    // N off() calls. The wrappers Map stores a stack of wrappers per
    // original listener so each off() peels exactly one registration.
    const fn = vi.fn();
    dispatchEvents.on("broken-transition", fn);
    dispatchEvents.on("broken-transition", fn);
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(2);
    dispatchEvents.off("broken-transition", fn);
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(1);
    dispatchEvents.emit("broken-transition", {
      repoName: "r",
      agentName: "a",
    });
    // One wrapper still attached → fn called once on emit.
    expect(fn).toHaveBeenCalledTimes(1);
    dispatchEvents.off("broken-transition", fn);
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(0);
  });
});
