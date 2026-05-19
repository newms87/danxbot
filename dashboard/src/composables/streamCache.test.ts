import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref, type Ref } from "vue";
import { flushPromises } from "@vue/test-utils";
import {
  createStreamCache,
  createKeyedStreamCache,
} from "./streamCache";
import type { StreamEvent } from "./useStream";

// ─── Stream mock ─────────────────────────────────────────────────────────────

type Handler = (e: StreamEvent) => void;

interface StreamMock {
  connectionState: Ref<"connecting" | "connected" | "disconnected">;
  subscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit(topic: string, data: unknown): void;
  handlerCount(topic: string): number;
  subscribeCallCount: number;
}

const streamInstances: StreamMock[] = [];

function makeStreamMock(): StreamMock {
  const handlers = new Map<string, Set<Handler>>();
  const mock: StreamMock = {
    connectionState: ref<"connecting" | "connected" | "disconnected">(
      "connected",
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
    get subscribeCallCount() {
      return mock.subscribe.mock.calls.length;
    },
  };
  streamInstances.push(mock);
  return mock;
}

vi.mock("./useStream", async () => {
  const actual =
    await vi.importActual<typeof import("./useStream")>("./useStream");
  return {
    ...actual,
    useStream: () => makeStreamMock(),
  };
});

beforeEach(() => {
  streamInstances.length = 0;
});

// ─── Module-singleton mode ───────────────────────────────────────────────────

describe("createStreamCache (singleton mode)", () => {
  it("hydrates initial state from fetchFn on init", async () => {
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => [1, 2, 3],
      applyOne: (state) => state,
    });
    expect(cache.state.value).toEqual([]);
    cache.init();
    await flushPromises();
    expect(cache.state.value).toEqual([1, 2, 3]);
    expect(cache.loading.value).toBe(false);
    expect(cache.error.value).toBeNull();
  });

  it("applies live SSE events through applyOne after hydrate", async () => {
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => [1],
      applyOne: (state, event) =>
        event.topic === "n:updated" ? [...state, event.data as number] : state,
    });
    cache.init();
    await flushPromises();
    streamInstances[0].emit("n:updated", 2);
    streamInstances[0].emit("n:updated", 3);
    expect(cache.state.value).toEqual([1, 2, 3]);
    cache.destroy();
  });

  it("buffers events arriving mid-hydrate; drains on top of fetched state", async () => {
    let resolveFetch!: (v: number[]) => void;
    let fetchCalled = false;
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: () => {
        fetchCalled = true;
        return new Promise<number[]>((res) => {
          resolveFetch = res;
        });
      },
      applyOne: (state, event) =>
        event.topic === "n:updated" ? [...state, event.data as number] : state,
    });
    cache.init();
    // Wait until the fetch body has actually run (microtasks chain through
    // pendingHydrate before fetchFn is called).
    for (let i = 0; i < 20 && !fetchCalled; i++) await Promise.resolve();
    expect(fetchCalled).toBe(true);
    // Fetch is in flight; emit events that should buffer onto the queue.
    streamInstances[0].emit("n:updated", 99);
    streamInstances[0].emit("n:updated", 100);
    resolveFetch([1, 2, 3]);
    await flushPromises();
    expect(cache.state.value).toEqual([1, 2, 3, 99, 100]);
    cache.destroy();
  });

  it("surfaces fetch errors on error ref without crashing", async () => {
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => {
        throw new Error("boom");
      },
      applyOne: (state) => state,
    });
    cache.init();
    await flushPromises();
    expect(cache.error.value).toBe("boom");
    expect(cache.loading.value).toBe(false);
    cache.destroy();
  });

  it("init is idempotent — second call does not open a second stream", async () => {
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => [],
      applyOne: (state) => state,
    });
    cache.init();
    cache.init();
    cache.init();
    await flushPromises();
    expect(streamInstances).toHaveLength(1);
    cache.destroy();
  });

  it("destroy tears down the stream + buffer", async () => {
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => [],
      applyOne: (state, event) =>
        event.topic === "n:updated" ? [...state, event.data as number] : state,
    });
    cache.init();
    await flushPromises();
    cache.destroy();
    expect(streamInstances[0].disconnect).toHaveBeenCalled();
    expect(streamInstances[0].handlerCount("n:updated")).toBe(0);
  });

  it("destroy after init allows a fresh init to re-open the stream", async () => {
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => [42],
      applyOne: (state) => state,
    });
    cache.init();
    await flushPromises();
    cache.destroy();
    cache.init();
    await flushPromises();
    expect(streamInstances).toHaveLength(2);
    expect(cache.state.value).toEqual([42]);
    cache.destroy();
  });

  it("hydrate is callable manually as a refresh primitive", async () => {
    let n = 0;
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => [++n],
      applyOne: (state) => state,
    });
    cache.init();
    await flushPromises();
    expect(cache.state.value).toEqual([1]);
    await cache.hydrate();
    expect(cache.state.value).toEqual([2]);
    await cache.hydrate();
    expect(cache.state.value).toEqual([3]);
    cache.destroy();
  });

  it("destroy before init is a no-op (does not throw, no stream opened)", () => {
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => [],
      applyOne: (state) => state,
    });
    expect(() => cache.destroy()).not.toThrow();
    expect(streamInstances).toHaveLength(0);
    // Second destroy is also a no-op.
    expect(() => cache.destroy()).not.toThrow();
  });

  it("filter-change re-hydrate: events arriving mid-second-hydrate buffer onto fresh fetch", async () => {
    let resolveSecond!: (v: number[]) => void;
    let fetchCount = 0;
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: () => {
        fetchCount++;
        if (fetchCount === 1) return Promise.resolve([1]);
        return new Promise<number[]>((res) => {
          resolveSecond = res;
        });
      },
      applyOne: (state, event) =>
        event.topic === "n:updated" ? [...state, event.data as number] : state,
    });
    cache.init();
    await flushPromises();
    expect(cache.state.value).toEqual([1]);
    // Second hydrate (simulates a filter change).
    void cache.hydrate();
    // Wait for the second fetch body to actually start.
    for (let i = 0; i < 20 && fetchCount < 2; i++) await Promise.resolve();
    expect(fetchCount).toBe(2);
    // Events arriving while the second hydrate is in flight must queue.
    streamInstances[0].emit("n:updated", 99);
    streamInstances[0].emit("n:updated", 100);
    resolveSecond([10, 20]);
    await flushPromises();
    expect(cache.state.value).toEqual([10, 20, 99, 100]);
    cache.destroy();
  });

  it("concurrent hydrate calls serialize — final state matches second fetch", async () => {
    const fetches: Array<(v: number[]) => void> = [];
    let fetchCount = 0;
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: () => {
        fetchCount++;
        return new Promise<number[]>((res) => fetches.push(res));
      },
      applyOne: (state) => state,
    });
    cache.init();
    // Wait for first fetch to start.
    for (let i = 0; i < 20 && fetchCount < 1; i++) await Promise.resolve();
    void cache.hydrate(); // second call lined up behind the first
    // Resolve first; second's fetch should now start.
    fetches[0]([1, 2]);
    for (let i = 0; i < 20 && fetchCount < 2; i++) await Promise.resolve();
    expect(fetchCount).toBe(2);
    fetches[1]([10, 20]);
    await flushPromises();
    expect(cache.state.value).toEqual([10, 20]);
    cache.destroy();
  });

  it("clears prior error on a successful re-hydrate", async () => {
    let n = 0;
    const cache = createStreamCache<number[]>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => {
        n++;
        if (n === 1) throw new Error("first fail");
        return [42];
      },
      applyOne: (state) => state,
    });
    cache.init();
    await flushPromises();
    expect(cache.error.value).toBe("first fail");
    await cache.hydrate();
    expect(cache.error.value).toBeNull();
    expect(cache.state.value).toEqual([42]);
    cache.destroy();
  });

  it("supports multi-topic subscription via array", async () => {
    const events: string[] = [];
    const cache = createStreamCache<string[]>({
      topic: ["a:updated", "b:updated"],
      initialState: () => [],
      fetchFn: async () => [],
      applyOne: (state, event) => {
        events.push(event.topic);
        return [...state, event.topic];
      },
    });
    cache.init();
    await flushPromises();
    streamInstances[0].emit("a:updated", null);
    streamInstances[0].emit("b:updated", null);
    expect(events).toEqual(["a:updated", "b:updated"]);
    expect(cache.state.value).toEqual(["a:updated", "b:updated"]);
    cache.destroy();
  });
});

// ─── Keyed mode ─────────────────────────────────────────────────────────────

describe("createKeyedStreamCache (per-key refcount mode)", () => {
  function makeFactory() {
    const fetchCalls: string[] = [];
    const factory = createKeyedStreamCache<string[], string>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async (key) => {
        fetchCalls.push(key);
        return [`${key}-row`];
      },
      applyOne: (state, event, key) => {
        const data = event.data as { repoName: string; row: string } | null;
        if (!data || data.repoName !== key) return state;
        return [...state, data.row];
      },
    });
    return { factory, fetchCalls };
  }

  it("first init() per key opens one stream + fires one fetch", async () => {
    const { factory, fetchCalls } = makeFactory();
    const a = factory("repo-a");
    a.init();
    await flushPromises();
    expect(streamInstances).toHaveLength(1);
    expect(fetchCalls).toEqual(["repo-a"]);
    expect(a.state.value).toEqual(["repo-a-row"]);
    a.destroy();
    factory.__resetForTesting();
  });

  it("second facade for SAME key shares state, fires NO extra fetch", async () => {
    const { factory, fetchCalls } = makeFactory();
    const a1 = factory("repo-a");
    a1.init();
    await flushPromises();
    const a2 = factory("repo-a");
    a2.init();
    await flushPromises();
    expect(streamInstances).toHaveLength(1);
    expect(fetchCalls).toEqual(["repo-a"]);
    expect(a1.state).toBe(a2.state);
    a1.destroy();
    a2.destroy();
    factory.__resetForTesting();
  });

  it("different keys get independent streams + fetches + state", async () => {
    const { factory, fetchCalls } = makeFactory();
    const a = factory("repo-a");
    const b = factory("repo-b");
    a.init();
    b.init();
    await flushPromises();
    expect(streamInstances).toHaveLength(2);
    expect(fetchCalls.sort()).toEqual(["repo-a", "repo-b"]);
    expect(a.state.value).toEqual(["repo-a-row"]);
    expect(b.state.value).toEqual(["repo-b-row"]);
    expect(a.state).not.toBe(b.state);
    a.destroy();
    b.destroy();
    factory.__resetForTesting();
  });

  it("refcount: stream tears down only when last facade for key destroys", async () => {
    const { factory } = makeFactory();
    const a1 = factory("repo-a");
    const a2 = factory("repo-a");
    a1.init();
    a2.init();
    await flushPromises();
    expect(streamInstances[0].disconnect).not.toHaveBeenCalled();
    a1.destroy();
    expect(streamInstances[0].disconnect).not.toHaveBeenCalled();
    a2.destroy();
    expect(streamInstances[0].disconnect).toHaveBeenCalled();
    factory.__resetForTesting();
  });

  it("destroy on un-init'd facade is a no-op (does not double-decrement)", async () => {
    const { factory } = makeFactory();
    const a1 = factory("repo-a");
    a1.init();
    await flushPromises();
    const a2 = factory("repo-a"); // never inits
    a2.destroy();
    a2.destroy(); // double-destroy
    expect(streamInstances[0].disconnect).not.toHaveBeenCalled();
    a1.destroy();
    expect(streamInstances[0].disconnect).toHaveBeenCalled();
    factory.__resetForTesting();
  });

  it("double-destroy on attached facade decrements only once", async () => {
    const { factory } = makeFactory();
    const a1 = factory("repo-a");
    const a2 = factory("repo-a");
    a1.init();
    a2.init();
    await flushPromises();
    a1.destroy();
    a1.destroy(); // second destroy on same facade — no-op
    expect(streamInstances[0].disconnect).not.toHaveBeenCalled();
    a2.destroy();
    expect(streamInstances[0].disconnect).toHaveBeenCalled();
    factory.__resetForTesting();
  });

  it("after last destroy, a fresh init() re-opens the key's stream", async () => {
    const { factory, fetchCalls } = makeFactory();
    const a1 = factory("repo-a");
    a1.init();
    await flushPromises();
    a1.destroy();
    const a2 = factory("repo-a");
    a2.init();
    await flushPromises();
    expect(streamInstances).toHaveLength(2);
    expect(fetchCalls).toEqual(["repo-a", "repo-a"]);
    a2.destroy();
    factory.__resetForTesting();
  });

  it("applyOne receives the key so per-key event filtering works", async () => {
    const { factory } = makeFactory();
    const a = factory("repo-a");
    const b = factory("repo-b");
    a.init();
    b.init();
    await flushPromises();
    // Cross-repo event: emitted on repo-b's stream but tagged repo-a —
    // applyOne for repo-b sees key=repo-b and drops it.
    streamInstances[1].emit("n:updated", { repoName: "repo-a", row: "x" });
    expect(b.state.value).toEqual(["repo-b-row"]); // unchanged
    // Same-repo event: applied normally.
    streamInstances[1].emit("n:updated", { repoName: "repo-b", row: "y" });
    expect(b.state.value).toEqual(["repo-b-row", "y"]);
    a.destroy();
    b.destroy();
    factory.__resetForTesting();
  });

  it("__resetForTesting tears down every shared instance + clears the map", async () => {
    const { factory } = makeFactory();
    const a = factory("repo-a");
    const b = factory("repo-b");
    a.init();
    b.init();
    await flushPromises();
    factory.__resetForTesting();
    expect(streamInstances[0].disconnect).toHaveBeenCalled();
    expect(streamInstances[1].disconnect).toHaveBeenCalled();
    // Reuse after reset opens fresh streams.
    const fresh = factory("repo-a");
    fresh.init();
    await flushPromises();
    expect(streamInstances).toHaveLength(3);
    fresh.destroy();
    factory.__resetForTesting();
  });

  it("surfaces fetch errors per-key without crashing other keys", async () => {
    const factory = createKeyedStreamCache<string[], string>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async (key) => {
        if (key === "broken") throw new Error("nope");
        return [key];
      },
      applyOne: (state) => state,
    });
    const broken = factory("broken");
    const ok = factory("ok");
    broken.init();
    ok.init();
    await flushPromises();
    expect(broken.error.value).toBe("nope");
    expect(broken.state.value).toEqual([]);
    expect(ok.error.value).toBeNull();
    expect(ok.state.value).toEqual(["ok"]);
    broken.destroy();
    ok.destroy();
    factory.__resetForTesting();
  });

  it("hydrate is callable manually per-key (refresh primitive)", async () => {
    let n = 0;
    const factory = createKeyedStreamCache<number[], string>({
      topic: "n:updated",
      initialState: () => [],
      fetchFn: async () => [++n],
      applyOne: (state) => state,
    });
    const a = factory("repo-a");
    a.init();
    await flushPromises();
    expect(a.state.value).toEqual([1]);
    await a.hydrate();
    expect(a.state.value).toEqual([2]);
    a.destroy();
    factory.__resetForTesting();
  });
});
