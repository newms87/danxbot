import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAuth } from "./composables/useAuth";
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
  /**
   * Build a fake streaming Response whose body yields the supplied SSE
   * chunks in order, then closes. Used to drive followDispatch without
   * real HTTP.
   */
  function streamingResponse(chunks: string[]): Response {
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("sends Authorization via headers (no `?token=` query leak)", async () => {
    seedToken("tok-abc");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(streamingResponse([]));

    followDispatch("abc-123", () => {}, () => {});
    // Let the async IIFE inside followDispatch reach the fetch call.
    await new Promise((r) => setTimeout(r, 0));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/dispatches/abc-123/follow");
    expect(String(url)).not.toContain("?token=");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-abc");
    expect(headers.get("Accept")).toBe("text/event-stream");
  });

  it("emits each parsed JSONL entry via onBlock", async () => {
    seedToken("tok");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      streamingResponse([
        `data: ${JSON.stringify({ id: 1 })}\n\n`,
        `data: ${JSON.stringify({ id: 2 })}\n\n`,
      ]),
    );

    const blocks: unknown[] = [];
    const errored = vi.fn();
    followDispatch(
      "abc",
      (b) => blocks.push(b),
      errored,
    );

    // Wait for the stream to complete and onError (stream end) to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(blocks).toEqual([{ id: 1 }, { id: 2 }]);
    expect(errored).toHaveBeenCalledTimes(1); // Natural end of stream.
  });

  it("returns a teardown that aborts the inflight fetch", async () => {
    seedToken("tok");
    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url: RequestInfo | URL, init?: RequestInit) => {
        receivedSignal = init?.signal as AbortSignal | undefined;
        // Return a pending promise until aborted.
        return new Promise<Response>((_, reject) => {
          receivedSignal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as { name: string }).name = "AbortError";
            reject(err);
          });
        });
      },
    );

    const stop = followDispatch("abc", () => {}, () => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(receivedSignal?.aborted).toBe(false);
    stop();
    expect(receivedSignal?.aborted).toBe(true);
  });
});
