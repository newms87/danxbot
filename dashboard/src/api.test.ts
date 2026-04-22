import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";
import type { Ref } from "vue";
import { useAuth } from "./composables/useAuth";

// ─── useStream mock harness ──────────────────────────────────────────────────
// Matches the capturing-handle pattern established in useAgents.test.ts so
// tests can inspect subscription lifecycle AND push events on demand.

type Handler = (e: { topic: string; data: unknown }) => void;
type StreamMock = {
  connectionState: Ref<"connecting" | "connected" | "disconnected">;
  subscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit(topic: string, data: unknown): void;
  handlerCount(topic: string): number;
};

function makeStreamMock(): StreamMock {
  const handlers = new Map<string, Set<Handler>>();
  return {
    connectionState: ref<"connecting" | "connected" | "disconnected">(
      "disconnected",
    ),
    subscribe: vi.fn().mockImplementation((topic: string, h: Handler) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
    disconnect: vi.fn(),
    emit(topic, data) {
      handlers.get(topic)?.forEach((h) => h({ topic, data }));
    },
    handlerCount(topic) {
      return handlers.get(topic)?.size ?? 0;
    },
  };
}

// Each test gets a fresh stream instance so connectionState transitions don't
// leak between tests.
let currentStream: StreamMock;
vi.mock("./composables/useStream", async () => {
  const actual =
    await vi.importActual<typeof import("./composables/useStream")>(
      "./composables/useStream",
    );
  return {
    ...actual,
    useStream: () => currentStream,
  };
});

// Import AFTER the mock so api.ts picks up the stubbed useStream.
import { fetchWithAuth, followDispatch } from "./api";

const TOKEN_KEY = "danxbot.authToken";

function seedToken(raw: string | null): void {
  if (raw) sessionStorage.setItem(TOKEN_KEY, raw);
  else sessionStorage.removeItem(TOKEN_KEY);
  const auth = useAuth();
  (auth.token as { value: string | null }).value = raw;
}

beforeEach(() => {
  sessionStorage.clear();
  seedToken(null);
  currentStream = makeStreamMock();
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("fetchWithAuth", () => {
  it("injects the bearer header on every request when a token exists", async () => {
    seedToken("tok-abc");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchWithAuth("/api/agents");

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-abc");
  });

  it("omits the bearer header when no token is present", async () => {
    seedToken(null);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    await fetchWithAuth("/api/repos");

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Authorization")).toBeNull();
  });

  it("dispatches a single `auth:expired` window event on 401", async () => {
    seedToken("rotated");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      }),
    );

    const events: CustomEvent[] = [];
    const listener = (e: Event) => {
      events.push(e as CustomEvent);
    };
    window.addEventListener("auth:expired", listener);

    try {
      await fetchWithAuth("/api/agents");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("auth:expired");
    } finally {
      window.removeEventListener("auth:expired", listener);
    }
  });

  it("does NOT dispatch auth:expired on non-401 failures", async () => {
    seedToken("tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Internal" }), { status: 500 }),
    );

    const fired = vi.fn();
    window.addEventListener("auth:expired", fired);

    try {
      await fetchWithAuth("/api/repos");
      expect(fired).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("auth:expired", fired);
    }
  });

  it("preserves caller-supplied headers and merges the bearer in", async () => {
    seedToken("tok-abc");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );

    await fetchWithAuth("/api/agents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Custom": "yes" },
    });

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-abc");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Custom")).toBe("yes");
  });
});

describe("followDispatch", () => {
  it("subscribes to dispatch:jsonl:<id> on the multiplexed stream", () => {
    followDispatch("abc-123", () => {}, () => {});

    expect(currentStream.subscribe).toHaveBeenCalledOnce();
    const [topic] = currentStream.subscribe.mock.calls[0];
    expect(topic).toBe("dispatch:jsonl:abc-123");
    expect(currentStream.handlerCount("dispatch:jsonl:abc-123")).toBe(1);
  });

  it("iterates the JsonlBlock[] payload and emits each parsed entry via onBlock", () => {
    const blocks: unknown[] = [];
    followDispatch(
      "abc",
      (b) => blocks.push(b),
      () => {},
    );

    currentStream.emit("dispatch:jsonl:abc", [{ id: 1 }, { id: 2 }]);
    currentStream.emit("dispatch:jsonl:abc", [{ id: 3 }]);

    expect(blocks).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("skips malformed payloads and logs a warning (not an array)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onBlock = vi.fn();

    followDispatch("abc", onBlock, () => {});
    currentStream.emit("dispatch:jsonl:abc", { wrong: "shape" });
    currentStream.emit("dispatch:jsonl:abc", null);

    expect(onBlock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("calls onError once when the stream transitions back to disconnected", async () => {
    const onError = vi.fn();
    followDispatch("abc", () => {}, onError);

    // Simulate a real useStream lifecycle: initial connect, then natural end.
    currentStream.connectionState.value = "connecting";
    await Promise.resolve();
    currentStream.connectionState.value = "connected";
    await Promise.resolve();
    currentStream.connectionState.value = "disconnected";
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);

    // Subsequent reconnect cycles must not re-fire onError.
    currentStream.connectionState.value = "connecting";
    await Promise.resolve();
    currentStream.connectionState.value = "disconnected";
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onError on the initial disconnected→connecting transition", async () => {
    const onError = vi.fn();
    followDispatch("abc", () => {}, onError);

    // Only disconnected→connecting, never leaves connecting. onError stays cold.
    currentStream.connectionState.value = "connecting";
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });

  it("returns a teardown that unsubscribes and disconnects this stream instance only", () => {
    const stop = followDispatch("abc", () => {}, () => {});

    expect(currentStream.handlerCount("dispatch:jsonl:abc")).toBe(1);
    expect(currentStream.disconnect).not.toHaveBeenCalled();

    stop();

    expect(currentStream.handlerCount("dispatch:jsonl:abc")).toBe(0);
    expect(currentStream.disconnect).toHaveBeenCalledTimes(1);
  });

  it("no longer hits the deleted /api/dispatches/:id/follow route", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    followDispatch("abc-123", () => {}, () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
