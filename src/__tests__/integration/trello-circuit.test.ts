/**
 * Integration: process-wide Trello circuit breaker — N concurrent
 * callers all 429ing trip the breaker ONCE, and every subsequent
 * Trello-bound call short-circuits without hitting the network
 * (DX-300).
 *
 * This is the "concurrent callers fan-in" test referenced in AC #8.
 * The state-machine semantics are unit-tested in
 * `src/issue-tracker/circuit-breaker.test.ts`; the per-method
 * wiring on `TrelloTracker` is pinned in
 * `src/__tests__/issue-tracker/trello.test.ts`. Here we cover the
 * end-to-end behaviour with a synthetic 429-returning fetch and a
 * real `TrelloTracker` instance.
 *
 * Why integration vs unit:
 *   - The unit test for the breaker uses fake state; this test uses
 *     a real tracker.
 *   - The unit test for the tracker validates ONE call at a time;
 *     this test runs 20 concurrent ones to assert the fan-in
 *     property the production bug report described.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrelloTracker } from "../../issue-tracker/trello.js";
import {
  TrelloCircuitOpen,
  _resetForTesting as resetCircuit,
  _setNowForTesting as setCircuitNow,
  getState as getCircuitState,
  setCircuitLogger,
} from "../../issue-tracker/circuit-breaker.js";
import type { TrelloConfig } from "../../types.js";

const TRELLO: TrelloConfig = {
  apiKey: "k",
  apiToken: "t",
  boardId: "board",
  reviewListId: "list-review",
  todoListId: "list-todo",
  inProgressListId: "list-ip",
  needsHelpListId: "list-nh",
  doneListId: "list-done",
  cancelledListId: "list-cancelled",
  actionItemsListId: "list-ai",
  bugLabelId: "lbl-bug",
  featureLabelId: "lbl-feature",
  epicLabelId: "lbl-epic",
  needsHelpLabelId: "lbl-nh",
  blockedLabelId: "lbl-blocked",
  requiresHumanLabelId: "lbl-rh",
  triagedLabelId: "lbl-triaged",
};

describe("Trello circuit breaker — concurrent callers fan-in (DX-300)", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  // Capture the warn lines without spamming stdout.
  const warnSpy = vi.fn();
  const infoSpy = vi.fn();

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    resetCircuit();
    setCircuitLogger({ info: infoSpy, warn: warnSpy });
    warnSpy.mockClear();
    infoSpy.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCircuit();
  });

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function rateLimited(): Response {
    return new Response("Too Many Requests", {
      status: 429,
      statusText: "Too Many Requests",
    });
  }

  it("after the first 429 lands, subsequent concurrent calls short-circuit without hitting the network", async () => {
    // This is the production failure mode the breaker exists to fix.
    // Pre-breaker: 20 retry-queue timers fire in the same ~500ms
    // window; ALL 20 issue 429-bound fetches; ALL 20 get 429 back.
    // Trello sees 20 calls inside its rate-limit window and may
    // extend it. The breaker can't intercept the INITIAL parallel
    // burst (we have no control over when timers fire), but it
    // pins the invariant that AFTER the first 429 responds, the
    // NEXT batch of callers short-circuits. So in production, a
    // sustained outage's load drops from N/tick to ~1/tick once
    // the breaker trips.
    //
    // Pin the wall-clock so the cooldown math is testable.
    let nowMs = 1_700_000_000_000;
    setCircuitNow(() => nowMs);

    // First call → 429 (response). Every subsequent fetch is also
    // mocked to 429 in case any of them slip through; the assertion
    // is that the wrapper short-circuits before the fetch fires.
    fetchMock.mockImplementation(async () => rateLimited());

    const tracker = new TrelloTracker(TRELLO);

    // Trip the breaker with a single (await-ed) 429.
    await expect(tracker.getComments("card-probe")).rejects.toThrow(/429/);
    expect(getCircuitState()).toBe("open");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Now fan out 20 concurrent callers — every one of them must
    // short-circuit at the wrapper, not hit fetch.
    fetchMock.mockClear();
    const concurrent = 20;
    const results = await Promise.allSettled(
      Array.from({ length: concurrent }, () =>
        tracker.getComments("card-probe"),
      ),
    );

    // No fetch calls AT ALL during the burst — the breaker is open.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(
      results.every(
        (r) => r.status === "rejected" && r.reason instanceof TrelloCircuitOpen,
      ),
    ).toBe(true);

    // Exactly ONE "opened" log line for the whole sequence (the
    // initial trip). Subsequent 429s never reach the breaker
    // because the wrapper short-circuited before calling fetch.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/TrelloCircuit: opened.*60s/);
  });

  it("recovers cleanly: after cooldown elapses, the next call probes Trello and on success the breaker closes for everyone", async () => {
    let nowMs = 1_700_000_000_000;
    setCircuitNow(() => nowMs);

    // First call: 429. Subsequent calls during cooldown: short-circuit.
    fetchMock.mockResolvedValueOnce(rateLimited());

    const tracker = new TrelloTracker(TRELLO);

    // Trip.
    await expect(tracker.getComments("card-probe")).rejects.toThrow(/429/);
    expect(getCircuitState()).toBe("open");

    // Concurrent reads during cooldown — all short-circuit.
    fetchMock.mockClear();
    const blocked = await Promise.allSettled(
      Array.from({ length: 5 }, () => tracker.getComments("card-probe")),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      blocked.every(
        (r) => r.status === "rejected" && r.reason instanceof TrelloCircuitOpen,
      ),
    ).toBe(true);

    // Advance past cooldown → half-open on next observation.
    nowMs += 60_000;

    // Probe success closes the breaker.
    fetchMock.mockResolvedValueOnce(jsonOk([]));
    const probeResult = await tracker.getComments("card-probe");
    expect(probeResult).toEqual([]);
    expect(getCircuitState()).toBe("closed");
    expect(infoSpy.mock.calls[0]![0]).toMatch(/TrelloCircuit: closed/);

    // Subsequent concurrent reads all hit Trello (breaker is closed).
    fetchMock.mockImplementation(async () => jsonOk([]));
    fetchMock.mockClear();
    const after = await Promise.all(
      Array.from({ length: 5 }, () => tracker.getComments("card-probe")),
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(after).toHaveLength(5);
  });
});
