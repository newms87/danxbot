import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import { flushPromises } from "@vue/test-utils";
import type { Ref } from "vue";

const mockFetchWithAuth = vi.fn();

// Keep real splitEvents (pure parser) — only stub the I/O boundary.
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

describe("createHydrationBuffer — hydrate-then-patch race", () => {
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
      (state, d) => {
        const ev = d as { id: string; status: string };
        return state.map((item) => (item.id === ev.id ? { ...item, status: ev.status } : item));
      },
    );

    // The stale REST state was patched by the queued event
    expect(result[0].status).toBe("completed");
  });

  it("applies multiple queued events in insertion order", async () => {
    const { stream, emit } = mockStreamHandle();

    const buf = createHydrationBuffer<string[]>(stream, "t");
    emit("t", "A");
    emit("t", "B");
    emit("t", "C");

    const result = await buf.hydrate(
      async () => [] as string[],
      (state, d) => [...state, d as string],
    );

    expect(result).toEqual(["A", "B", "C"]);
  });

  it("subscribes to the stream for the given topic immediately", () => {
    const { stream } = mockStreamHandle();
    createHydrationBuffer(stream, "dispatch:created");
    expect(stream.subscribe).toHaveBeenCalledWith(
      "dispatch:created",
      expect.any(Function),
    );
  });

  it("unsubscribes after hydrate() resolves to stop buffering", async () => {
    const { stream } = mockStreamHandle();
    const unsubSpy = vi.fn();
    (stream.subscribe as ReturnType<typeof vi.fn>).mockReturnValue(unsubSpy);

    const buf = createHydrationBuffer<string[]>(stream, "t");
    await buf.hydrate(async () => [], (s, d) => [...s, d as string]);

    expect(unsubSpy).toHaveBeenCalledOnce();
  });

  it("ignores events that arrive after hydrate() has resolved", async () => {
    const { stream, emit } = mockStreamHandle();

    let resolveFetch!: (v: string[]) => void;
    const fetchFn = () => new Promise<string[]>((r) => { resolveFetch = r; });

    const buf = createHydrationBuffer<string[]>(stream, "t");
    const hydratePromise = buf.hydrate(fetchFn, (s, d) => [...s, d as string]);

    emit("t", "before"); // queued
    resolveFetch([]);    // hydrate now resolves, closes the buffer
    const result = await hydratePromise;

    emit("t", "after"); // too late — should be silently dropped
    expect(result).toEqual(["before"]);
  });

  it("throws if hydrate() is called a second time", async () => {
    const { stream } = mockStreamHandle();
    const buf = createHydrationBuffer<string[]>(stream, "t");
    await buf.hydrate(async () => [], (s, d) => [...s, d as string]);

    await expect(
      buf.hydrate(async () => [], (s, d) => [...s, d as string]),
    ).rejects.toThrow("HydrationBuffer already consumed");
  });
});
