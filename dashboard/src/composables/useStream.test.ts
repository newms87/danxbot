import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import { flushPromises } from "@vue/test-utils";
import type { Ref } from "vue";

const mockFetchWithAuth = vi.fn();

// Stub fetchWithAuth (the I/O boundary). splitEvents used to be a shared
// export on `../api` and was kept real via importActual; it now lives
// privately inside useStream.ts so nothing extra needs preserving here.
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  };
});

import { useStream, createHydrationBuffer } from "./useStream";
import type { StreamEvent, ConnectionState, UseStreamReturn } from "./useStream";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function sseFrame(topic: string, data: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify({ topic, data })}\n\n`);
}

type ReaderChunk = Uint8Array | "done";

function fakeReader(chunks: ReaderChunk[]) {
  let i = 0;
  return {
    read: vi.fn().mockImplementation(async () => {
      const c = chunks[i++];
      if (c === "done" || c === undefined) return { value: undefined, done: true };
      return { value: c, done: false };
    }),
  };
}

function okStream(reader: ReturnType<typeof fakeReader>): Response {
  return { ok: true, body: { getReader: () => reader } } as unknown as Response;
}

function hangingReader() {
  return { read: vi.fn().mockReturnValue(new Promise<never>(() => {})) };
}

function hangForever(): Promise<Response> {
  return new Promise<Response>(() => {});
}

/**
 * A reader you can push chunks into one at a time. Each push() resolves the
 * outstanding read() call so the loop processes exactly one chunk before
 * blocking again — giving the test full control over when events arrive.
 */
function controllableReader() {
  type Resolve = (r: { value: Uint8Array | undefined; done: boolean }) => void;
  let pending: Resolve | null = null;
  const reader = {
    read: vi.fn().mockImplementation(
      () =>
        new Promise<{ value: Uint8Array | undefined; done: boolean }>((r) => {
          pending = r;
        }),
    ),
  };
  return {
    reader,
    push(chunk: Uint8Array) {
      const r = pending;
      pending = null;
      r?.({ value: chunk, done: false });
    },
    close() {
      const r = pending;
      pending = null;
      r?.({ value: undefined, done: true });
    },
  };
}

/** Minimal mock UseStreamReturn for isolated hydration-buffer tests. */
function mockStreamHandle() {
  const capturedHandlers = new Map<string, Array<(e: StreamEvent) => void>>();

  const stream: UseStreamReturn = {
    connectionState: ref<ConnectionState>("connected") as Ref<ConnectionState>,
    subscribe: vi.fn().mockImplementation(
      (topic: string, handler: (e: StreamEvent) => void) => {
        if (!capturedHandlers.has(topic)) capturedHandlers.set(topic, []);
        capturedHandlers.get(topic)!.push(handler);
        return () => {
          const hs = capturedHandlers.get(topic);
          if (hs) capturedHandlers.set(topic, hs.filter((h) => h !== handler));
        };
      },
    ),
    disconnect: vi.fn(),
  };

  function emit(topic: string, data: unknown) {
    capturedHandlers.get(topic)?.forEach((h) => h({ topic, data }));
  }

  return { stream, emit };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0); // no jitter → deterministic delays
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── subscribe + event dispatch ──────────────────────────────────────────────

describe("useStream — subscribe + dispatch", () => {
  it("opens /api/stream with the subscribed topic", async () => {
    mockFetchWithAuth.mockResolvedValue(okStream(fakeReader(["done"])));

    const { subscribe, disconnect } = useStream();
    subscribe("dispatch:created", () => {});
    await flushPromises();

    expect(mockFetchWithAuth).toHaveBeenCalledOnce();
    const url = (mockFetchWithAuth.mock.calls[0] as [string])[0];
    expect(url).toMatch(/\/api\/stream\?topics=/);
    expect(url).toContain(encodeURIComponent("dispatch:created"));

    disconnect();
  });

  it("includes all synchronously-subscribed topics in the connection URL", async () => {
    mockFetchWithAuth.mockResolvedValue(okStream(fakeReader(["done"])));

    const { subscribe, disconnect } = useStream();
    subscribe("dispatch:created", () => {});
    subscribe("dispatch:updated", () => {});
    await flushPromises();

    const url = (mockFetchWithAuth.mock.calls[0] as [string])[0];
    expect(url).toContain(encodeURIComponent("dispatch:created"));
    expect(url).toContain(encodeURIComponent("dispatch:updated"));

    disconnect();
  });

  it("calls the handler when a matching event arrives", async () => {
    const handler = vi.fn();
    mockFetchWithAuth.mockResolvedValue(
      okStream(fakeReader([sseFrame("dispatch:created", { id: "j1" }), "done"])),
    );

    const { subscribe, disconnect } = useStream();
    subscribe("dispatch:created", handler);
    await flushPromises();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      topic: "dispatch:created",
      data: { id: "j1" },
    });

    disconnect();
  });

  it("routes events to the correct handler — wrong-topic events are ignored", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    mockFetchWithAuth.mockResolvedValue(
      okStream(
        fakeReader([
          sseFrame("dispatch:created", { id: "a" }),
          sseFrame("dispatch:updated", { id: "b" }),
          "done",
        ]),
      ),
    );

    const { subscribe, disconnect } = useStream();
    subscribe("dispatch:created", h1);
    subscribe("dispatch:updated", h2);
    await flushPromises();

    expect(h1).toHaveBeenCalledOnce();
    expect((h1.mock.calls[0][0] as StreamEvent).data).toMatchObject({ id: "a" });
    expect(h2).toHaveBeenCalledOnce();
    expect((h2.mock.calls[0][0] as StreamEvent).data).toMatchObject({ id: "b" });

    disconnect();
  });

  it("stops calling the handler after unsubscribe (mid-stream)", async () => {
    const handler = vi.fn();
    const ctrl = controllableReader();
    mockFetchWithAuth.mockResolvedValue(okStream(ctrl.reader as ReturnType<typeof fakeReader>));

    const { subscribe, disconnect } = useStream();
    const unsub = subscribe("t", handler);
    await flushPromises(); // connect → fetch resolves → first read() queued

    ctrl.push(sseFrame("t", 1)); // deliver event 1
    await flushPromises();        // event 1 processed, second read() queued

    expect(handler).toHaveBeenCalledTimes(1);
    unsub(); // remove handler while stream is still open

    ctrl.push(sseFrame("t", 2)); // deliver event 2
    await flushPromises();        // event 2 processed — handler already gone

    expect(handler).toHaveBeenCalledTimes(1); // still only once

    disconnect();
  });

  it("does not reconnect after all handlers have unsubscribed", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(okStream(fakeReader(["done"])))
      .mockReturnValue(hangForever());

    const { subscribe, disconnect } = useStream();
    const unsub = subscribe("dispatch:created", () => {});
    await flushPromises(); // connect → stream ends → 1s reconnect scheduled

    unsub(); // remove all handlers → topic gone from map

    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();

    // Timer fired but connect() found no topics → returned early
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    disconnect();
  });
});

// ─── connectionState ─────────────────────────────────────────────────────────

describe("useStream — connectionState", () => {
  it("starts as disconnected before any subscribe", () => {
    const { connectionState } = useStream();
    expect(connectionState.value).toBe("disconnected");
  });

  it("becomes connected once the fetch resolves with a valid body", async () => {
    mockFetchWithAuth.mockResolvedValue(okStream(hangingReader() as ReturnType<typeof fakeReader>));

    const { connectionState, subscribe, disconnect } = useStream();
    subscribe("dispatch:created", () => {});
    await flushPromises(); // fetch resolves → reader.read hangs → state stays "connected"

    expect(connectionState.value).toBe("connected");

    disconnect();
  });

  it("returns to disconnected after the stream ends", async () => {
    mockFetchWithAuth.mockResolvedValue(okStream(fakeReader(["done"])));

    const { connectionState, subscribe, disconnect } = useStream();
    subscribe("dispatch:created", () => {});
    await flushPromises();

    expect(connectionState.value).toBe("disconnected");

    disconnect();
  });
});

// ─── reconnect backoff ───────────────────────────────────────────────────────

describe("useStream — reconnect backoff", () => {
  it("reconnects after stream ends (1 s base, no jitter)", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(okStream(fakeReader(["done"])))
      .mockReturnValue(hangForever());

    const { subscribe, disconnect } = useStream();
    subscribe("dispatch:created", () => {});
    await flushPromises(); // connect 1 → done → 1s timer

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);

    disconnect();
  });

  it("doubles backoff on each consecutive disconnect (1s → 2s → 4s)", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(okStream(fakeReader(["done"])))
      .mockResolvedValueOnce(okStream(fakeReader(["done"])))
      .mockResolvedValueOnce(okStream(fakeReader(["done"])))
      .mockReturnValue(hangForever());

    const { subscribe, disconnect } = useStream();
    subscribe("dispatch:created", () => {});
    await flushPromises(); // connect 1 → done → 1s timer

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises(); // connect 2 → done → 2s timer

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises(); // connect 3 → done → 4s timer

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(3);

    // 4s timer: not yet fired at 3999ms
    await vi.advanceTimersByTimeAsync(3_999);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1); // exactly 4s
    await flushPromises(); // connect 4 (hangs)

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(4);

    disconnect();
  });

  it("caps backoff at 30 000 ms", async () => {
    // 1→2→4→8→16→30 (capped) over six disconnects
    let callCount = 0;
    mockFetchWithAuth.mockImplementation(async () => {
      callCount++;
      return okStream(fakeReader(["done"]));
    });

    const { subscribe, disconnect } = useStream();
    subscribe("dispatch:created", () => {});

    // Drive 7 reconnects using 35s advances (always enough for any delay ≤ 30s)
    for (let i = 0; i < 7; i++) {
      await flushPromises();
      await vi.advanceTimersByTimeAsync(35_000);
    }
    await flushPromises();

    expect(callCount).toBeGreaterThanOrEqual(7);

    // Next timer should be at 30s max — fire it and confirm another connect
    const before = callCount;
    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    expect(callCount).toBeGreaterThan(before);

    disconnect();
  });

  it("disconnect() cancels a pending reconnect timer", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(okStream(fakeReader(["done"])))
      .mockReturnValue(hangForever());

    const { subscribe, disconnect } = useStream();
    subscribe("dispatch:created", () => {});
    await flushPromises(); // connect 1 → done → 1s timer

    disconnect();

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("stays connected indefinitely on a stable server (no spurious reconnects)", async () => {
    // After two failures backoff reaches 2s; a long-lived connection should
    // not trigger any additional reconnect while the reader is hanging.
    mockFetchWithAuth
      .mockResolvedValueOnce(okStream(fakeReader(["done"]))) // fail 1 → 1s timer
      .mockResolvedValueOnce(okStream(fakeReader(["done"]))) // fail 2 → 2s timer
      .mockResolvedValueOnce(okStream(hangingReader() as ReturnType<typeof fakeReader>)) // stable
      .mockReturnValue(hangForever());

    const { connectionState, subscribe, disconnect } = useStream();
    subscribe("dispatch:created", () => {});
    await flushPromises(); // connect 1 → done

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises(); // connect 2 → done

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises(); // connect 3 → hangs

    expect(connectionState.value).toBe("connected");
    // No additional connect calls while the reader hangs
    const callCountAtStable = mockFetchWithAuth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    expect(mockFetchWithAuth.mock.calls.length).toBe(callCountAtStable);

    disconnect();
  });
});

// ─── connect() error paths ───────────────────────────────────────────────────

describe("useStream — connect() error paths", () => {
  it("schedules reconnect when fetch resolves with ok: false", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce({ ok: false, body: null } as unknown as Response)
      .mockReturnValue(hangForever());

    const { connectionState, subscribe, disconnect } = useStream();
    subscribe("t", () => {});
    await flushPromises(); // connect 1 → ok: false → 1s timer

    expect(connectionState.value).toBe("disconnected");
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);

    disconnect();
  });

  it("schedules reconnect when fetch resolves with ok: true but body: null", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce({ ok: true, body: null } as unknown as Response)
      .mockReturnValue(hangForever());

    const { subscribe, disconnect } = useStream();
    subscribe("t", () => {});
    await flushPromises();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);

    disconnect();
  });

  it("schedules reconnect on a non-AbortError network exception", async () => {
    mockFetchWithAuth
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValue(hangForever());

    const { subscribe, disconnect } = useStream();
    subscribe("t", () => {});
    await flushPromises();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);

    disconnect();
  });

  it("does NOT reconnect when fetch is aborted via disconnect()", async () => {
    mockFetchWithAuth.mockReturnValue(hangForever());

    const { subscribe, disconnect } = useStream();
    subscribe("t", () => {});
    await flushPromises(); // fetch in-flight

    disconnect(); // aborts the fetch → AbortError in catch

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1); // no reconnect
  });

  it("swallows malformed JSON mid-stream and continues delivering valid events", async () => {
    const enc2 = new TextEncoder();
    const malformed = enc2.encode("data: {not json}\n\n");
    const handler = vi.fn();
    mockFetchWithAuth.mockResolvedValue(
      okStream(fakeReader([malformed, sseFrame("t", { id: "ok" }), "done"])),
    );

    const { subscribe, disconnect } = useStream();
    subscribe("t", handler);
    await flushPromises();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as StreamEvent).data).toMatchObject({ id: "ok" });

    disconnect();
  });
});

// ─── createHydrationBuffer ───────────────────────────────────────────────────
//
// New API (single buffer, continuous subscription):
//   - hydrate(fetchFn, applyEvent) — REST fetch + queue drain on top of state.
//     applyEvent receives the full StreamEvent so multi-topic buffers can
//     discriminate by topic. Re-callable for filter-change patterns.
//   - onLiveEvent(handler) — receive events AFTER hydrate resolves. May be
//     called before OR after hydrate; events that arrive in the gap between
//     hydrate-resolved and first onLiveEvent registration are queued and
//     drained on registration so nothing is silently lost.
//   - close() — tear down all underlying subscriptions.
//
// The same SSE subscription stays open across the buffered→live boundary,
// so there is never an unsubscribe gap (the bug Phase 4 hand-rolled around
// in `useDispatches.ts`). Phase 7 deletes that workaround.

describe("createHydrationBuffer — hydrate (REST + queue drain)", () => {
  it("applies events that arrived before the REST fetch resolved", async () => {
    const { stream, emit } = mockStreamHandle();

    const buf = createHydrationBuffer<Array<{ id: string; status: string }>>(
      stream,
      "dispatch:updated",
    );

    // Event arrives BEFORE the REST fetch resolves
    emit("dispatch:updated", { id: "j1", status: "completed" });

    const result = await buf.hydrate(
      async () => [{ id: "j1", status: "running" }],
      (state, ev) => {
        const data = ev.data as { id: string; status: string };
        return state.map((item) =>
          item.id === data.id ? { ...item, status: data.status } : item,
        );
      },
    );

    // The stale REST state was patched by the queued event
    expect(result[0].status).toBe("completed");

    buf.close();
  });

  it("applies multiple queued events in insertion order", async () => {
    const { stream, emit } = mockStreamHandle();

    const buf = createHydrationBuffer<string[]>(stream, "t");
    emit("t", "A");
    emit("t", "B");
    emit("t", "C");

    const result = await buf.hydrate(
      async () => [] as string[],
      (state, ev) => [...state, ev.data as string],
    );

    expect(result).toEqual(["A", "B", "C"]);

    buf.close();
  });

  it("subscribes to the stream for the given topic immediately", () => {
    const { stream } = mockStreamHandle();
    const buf = createHydrationBuffer(stream, "dispatch:created");
    expect(stream.subscribe).toHaveBeenCalledWith(
      "dispatch:created",
      expect.any(Function),
    );
    buf.close();
  });

  it("subscribes to every topic when given an array (multi-topic buffer)", () => {
    const { stream } = mockStreamHandle();
    const buf = createHydrationBuffer(stream, [
      "dispatch:created",
      "dispatch:updated",
    ]);
    expect(stream.subscribe).toHaveBeenCalledTimes(2);
    expect(stream.subscribe).toHaveBeenCalledWith(
      "dispatch:created",
      expect.any(Function),
    );
    expect(stream.subscribe).toHaveBeenCalledWith(
      "dispatch:updated",
      expect.any(Function),
    );
    buf.close();
  });

  it("queues events from every subscribed topic and replays them in order", async () => {
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, ["a", "b"]);

    emit("a", "a1");
    emit("b", "b1");
    emit("a", "a2");

    const result = await buf.hydrate(
      async () => [],
      (state, ev) => [...state, `${ev.topic}:${ev.data}`],
    );

    expect(result).toEqual(["a:a1", "b:b1", "a:a2"]);

    buf.close();
  });

  it("delivers post-hydrate events to a handler registered BEFORE hydrate", async () => {
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");

    const seen: string[] = [];
    buf.onLiveEvent((event) => seen.push(event.data as string));

    await buf.hydrate(
      async () => [],
      (state, ev) => [...state, ev.data as string],
    );

    // Pre-hydrate events would have been replayed via applyEvent — handlers
    // registered before hydrate must NOT also receive them (they are already
    // in state). Only events emitted AFTER hydrate flow to live handlers.
    emit("t", "after");

    expect(seen).toEqual(["after"]);

    buf.close();
  });

  it("does NOT replay queue events to live handlers registered before hydrate", async () => {
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");

    const seen: string[] = [];
    buf.onLiveEvent((event) => seen.push(event.data as string));

    // Pre-hydrate events
    emit("t", "buffered-1");
    emit("t", "buffered-2");

    const result = await buf.hydrate(
      async () => [],
      (state, ev) => [...state, ev.data as string],
    );

    // applyEvent saw the queued events — they're in the returned state.
    expect(result).toEqual(["buffered-1", "buffered-2"]);
    // Live handler did NOT see them — they were drained via applyEvent only,
    // not double-delivered to the live handler.
    expect(seen).toEqual([]);

    buf.close();
  });
});

describe("createHydrationBuffer — onLiveEvent (post-hydrate handoff)", () => {
  it("THE RACE: delivers events arriving between hydrate-resolved and first onLiveEvent registration", async () => {
    // This is the exact scenario the card's "How to verify" calls out.
    // The old one-shot helper unsubscribed inside hydrate; events fired in
    // the microtask gap before the caller called subscribe(...) again were
    // silently lost. The new helper keeps the SAME subscription open and
    // queues post-hydrate events until the first onLiveEvent registration
    // drains them — zero loss.
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");

    let resolveFetch!: (v: string[]) => void;
    const fetchFn = () => new Promise<string[]>((r) => (resolveFetch = r));
    const hydratePromise = buf.hydrate(fetchFn, (s, ev) => [
      ...s,
      ev.data as string,
    ]);
    // Hydrate now chains onto pendingHydrate via an IIFE; let the microtask
    // resume past the initial `await prev` so fetchFn runs and resolveFetch
    // is bound before we call it.
    await flushPromises();
    resolveFetch([]);
    await hydratePromise; // hydrate resolved, phase = live, no live handlers

    // Event lands in the gap — handler not yet registered.
    emit("t", "in-the-gap");

    const seen: string[] = [];
    buf.onLiveEvent((event) => seen.push(event.data as string));

    // The gap event was queued and drained on registration — not lost.
    expect(seen).toEqual(["in-the-gap"]);

    // Future events flow normally to the registered handler.
    emit("t", "after");
    expect(seen).toEqual(["in-the-gap", "after"]);

    buf.close();
  });

  it("delivers post-hydrate events to multiple registered handlers in order", async () => {
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");

    await buf.hydrate(async () => [], (s, ev) => [...s, ev.data as string]);

    const seenA: string[] = [];
    const seenB: string[] = [];
    buf.onLiveEvent((event) => seenA.push(event.data as string));
    buf.onLiveEvent((event) => seenB.push(event.data as string));

    emit("t", "live-1");
    emit("t", "live-2");

    expect(seenA).toEqual(["live-1", "live-2"]);
    expect(seenB).toEqual(["live-1", "live-2"]);

    buf.close();
  });

  it("returns an unsubscribe function that stops further deliveries to that handler", async () => {
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");
    await buf.hydrate(async () => [], (s, ev) => [...s, ev.data as string]);

    const seen: string[] = [];
    const unsub = buf.onLiveEvent((event) => seen.push(event.data as string));
    emit("t", "first");
    unsub();
    emit("t", "second");

    expect(seen).toEqual(["first"]);

    buf.close();
  });

  it("only the first post-hydrate handler receives gap-queued events; later handlers receive only future events", async () => {
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");
    await buf.hydrate(async () => [], (s, ev) => [...s, ev.data as string]);

    // Gap events queued before any handler registers.
    emit("t", "gap-1");
    emit("t", "gap-2");

    const seenA: string[] = [];
    buf.onLiveEvent((event) => seenA.push(event.data as string));

    const seenB: string[] = [];
    buf.onLiveEvent((event) => seenB.push(event.data as string));

    emit("t", "after");

    // First handler drained the queue; second only sees post-registration events.
    expect(seenA).toEqual(["gap-1", "gap-2", "after"]);
    expect(seenB).toEqual(["after"]);

    buf.close();
  });
});

describe("createHydrationBuffer — re-hydrate (filter-change pattern)", () => {
  it("supports a second hydrate call to refetch under a new filter without dropping events", async () => {
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");

    const seen: string[] = [];
    buf.onLiveEvent((event) => seen.push(event.data as string));

    await buf.hydrate(async () => ["initial"], (s, ev) => [
      ...s,
      ev.data as string,
    ]);
    emit("t", "live-1");

    // Second hydrate (filter change). Events that fire DURING the second
    // fetch should be applied via applyEvent on top of the new snapshot,
    // not delivered to live handlers (since the caller will overwrite the
    // ref with the returned state anyway).
    let resolveSecond!: (v: string[]) => void;
    const secondFetch = () => new Promise<string[]>((r) => (resolveSecond = r));
    const secondPromise = buf.hydrate(secondFetch, (s, ev) => [
      ...s,
      `mid:${ev.data}`,
    ]);
    await flushPromises(); // let chained IIFE reach `await fetchFn`
    emit("t", "during-refetch"); // should queue, not deliver to handler
    resolveSecond(["after-refilter"]);
    const result = await secondPromise;

    // Queued mid-refetch event applied via the second applyEvent.
    expect(result).toEqual(["after-refilter", "mid:during-refetch"]);
    // Live handler saw live-1 only — NOT during-refetch (consumed by hydrate).
    expect(seen).toEqual(["live-1"]);

    // Future events go to live handler again.
    emit("t", "live-2");
    expect(seen).toEqual(["live-1", "live-2"]);

    buf.close();
  });

  it("serializes concurrent hydrate calls — second waits for first to finish", async () => {
    // Filter-change watcher can fire `void hydrate()` faster than the prior
    // fetch resolves. Without serialization the older fetch's queue-drain
    // would race the newer one, possibly applying events to the wrong
    // snapshot. With serialization, the second hydrate's body waits for
    // the first to fully complete before flipping phase=buffering and
    // starting its own fetch — both promises resolve to their own
    // snapshot, no events double-apply.
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");

    const seen: string[] = [];
    buf.onLiveEvent((event) => seen.push(event.data as string));

    let resolve1!: (v: string[]) => void;
    let resolve2!: (v: string[]) => void;
    const fetch1 = () => new Promise<string[]>((r) => (resolve1 = r));
    const fetch2 = () => new Promise<string[]>((r) => (resolve2 = r));

    const p1 = buf.hydrate(fetch1, (s, ev) => [...s, ev.data as string]);
    // Second call BEFORE first resolves — must serialize.
    const p2 = buf.hydrate(fetch2, (s, ev) => [...s, ev.data as string]);

    // Let the chained IIFEs reach their fetchFn awaits.
    await flushPromises();

    emit("t", "during-1"); // queues against first hydrate's fetch

    resolve1(["snap-1"]);
    expect(await p1).toEqual(["snap-1", "during-1"]);

    // p2's body now runs: re-flips phase=buffering, awaits fetch2.
    await flushPromises();

    emit("t", "between"); // queued during second's buffering phase

    resolve2(["snap-2"]);
    expect(await p2).toEqual(["snap-2", "between"]);

    // Live handler did not double-receive any of the queued events.
    expect(seen).toEqual([]);

    // After both hydrates finish, future events flow to live handler.
    emit("t", "live-after");
    expect(seen).toEqual(["live-after"]);

    buf.close();
  });

  it("rejects further hydrate calls after close()", async () => {
    const { stream } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");
    buf.close();
    await expect(
      buf.hydrate(async () => [], (s, ev) => [...s, ev.data as string]),
    ).rejects.toThrow(/closed/i);
  });

  it("close() called DURING in-flight hydrate() — no live deliveries, no throw", async () => {
    // Teardown race: route change unmounts the consumer mid-fetch. The in-flight
    // hydrate must not deliver queued events to live handlers post-close, and
    // must not throw escaping the await boundary. Covers the `phase === "closed"`
    // early-return inside hydrate after the await.
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");

    const seen: string[] = [];
    buf.onLiveEvent((event) => seen.push(event.data as string));

    let resolveFetch!: (v: string[]) => void;
    const fetchFn = () => new Promise<string[]>((r) => (resolveFetch = r));
    const hydratePromise = buf.hydrate(fetchFn, (s, ev) => [
      ...s,
      ev.data as string,
    ]);
    await flushPromises(); // let chained IIFE reach `await fetchFn`

    emit("t", "during-fetch"); // buffered
    buf.close(); // teardown mid-hydrate
    resolveFetch(["snapshot"]); // resolves AFTER close

    const result = await hydratePromise;
    // Snapshot returned (caller will discard it on unmount), but the queued
    // event MUST NOT fire any live handler.
    expect(result).toEqual(["snapshot"]);
    expect(seen).toEqual([]);

    // Future emits after close are also dropped.
    emit("t", "post-close");
    expect(seen).toEqual([]);
  });
});

describe("createHydrationBuffer — close()", () => {
  it("unsubscribes every topic", () => {
    const { stream } = mockStreamHandle();
    const unsubA = vi.fn();
    const unsubB = vi.fn();
    let call = 0;
    (stream.subscribe as ReturnType<typeof vi.fn>).mockImplementation(() =>
      ++call === 1 ? unsubA : unsubB,
    );

    const buf = createHydrationBuffer<string[]>(stream, ["a", "b"]);
    buf.close();

    expect(unsubA).toHaveBeenCalledOnce();
    expect(unsubB).toHaveBeenCalledOnce();
  });

  it("is idempotent — second close() does not double-unsubscribe", () => {
    const { stream } = mockStreamHandle();
    const unsubSpy = vi.fn();
    (stream.subscribe as ReturnType<typeof vi.fn>).mockReturnValue(unsubSpy);

    const buf = createHydrationBuffer<string[]>(stream, "t");
    buf.close();
    buf.close();

    expect(unsubSpy).toHaveBeenCalledOnce();
  });

  it("stops delivering events to live handlers after close()", async () => {
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");
    await buf.hydrate(async () => [], (s, ev) => [...s, ev.data as string]);

    const seen: string[] = [];
    buf.onLiveEvent((event) => seen.push(event.data as string));
    emit("t", "before-close");
    buf.close();
    emit("t", "after-close");

    expect(seen).toEqual(["before-close"]);
  });

  it("onLiveEvent registered AFTER close() returns a no-op unsub and never fires", () => {
    const { stream, emit } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");
    buf.close();

    const seen: string[] = [];
    const unsub = buf.onLiveEvent((event) => seen.push(event.data as string));
    // Underlying subscription is gone, so emit is a no-op anyway, but the
    // contract is: even if it weren't, a post-close handler must not fire.
    emit("t", "should-not-arrive");
    expect(seen).toEqual([]);

    // Returned unsub is callable without throwing.
    expect(() => unsub()).not.toThrow();
  });
});
