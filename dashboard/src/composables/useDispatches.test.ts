import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import type { Ref } from "vue";
import type { Dispatch } from "../types";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockFetchDispatches = vi.fn();
vi.mock("../api", () => ({
  fetchDispatches: (...args: unknown[]) => mockFetchDispatches(...args),
}));

// useStream is mocked with a capturing handle so tests can push events on demand.
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
    connectionState: ref<"connecting" | "connected" | "disconnected">("connected"),
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

let currentStream: StreamMock;
vi.mock("./useStream", async () => {
  const actual = await vi.importActual<typeof import("./useStream")>("./useStream");
  return {
    ...actual,
    useStream: () => currentStream,
  };
});

// Import AFTER mocks.
import { useDispatches, applyDispatchEvent } from "./useDispatches";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeDispatch(id: string, overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id,
    repo: "danxbot",
    trigger: "api",
    triggerMetadata: {},
    status: "running",
    startedAt: 1_700_000_000_000,
    completedAt: null,
    elapsedSeconds: null,
    summary: null,
    error: null,
    runtime: "docker",
    taskPreview: "Task preview",
    taskPrompt: "Task prompt",
    sessionUuid: null,
    jsonlPath: null,
    jsonlHostPath: null,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokensTotal: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    parentJobId: null,
    ...overrides,
  } as Dispatch;
}

// ─── Pure reducer tests ──────────────────────────────────────────────────────

describe("applyDispatchEvent — reducer", () => {
  it("prepends a new dispatch on created (newest first)", () => {
    const state = [makeDispatch("old")];
    const next = applyDispatchEvent(state, {
      type: "created",
      dispatch: makeDispatch("new"),
    });
    expect(next.map((d) => d.id)).toEqual(["new", "old"]);
  });

  it("created is idempotent — a duplicate id is a no-op (same reference)", () => {
    const state = [makeDispatch("j1"), makeDispatch("j2")];
    const next = applyDispatchEvent(state, {
      type: "created",
      dispatch: makeDispatch("j1", { status: "completed" }),
    });
    expect(next).toBe(state); // identical reference — no churn
  });

  it("updated merges fields onto an existing dispatch", () => {
    const state = [makeDispatch("j1", { status: "running" })];
    const next = applyDispatchEvent(state, {
      type: "updated",
      patch: { id: "j1", status: "completed", tokensTotal: 1234 },
    });
    expect(next[0].status).toBe("completed");
    expect(next[0].tokensTotal).toBe(1234);
    // Unchanged fields survive the merge
    expect(next[0].trigger).toBe("api");
  });

  it("updated returns a NEW array (no in-place mutation)", () => {
    const state = [makeDispatch("j1")];
    const next = applyDispatchEvent(state, {
      type: "updated",
      patch: { id: "j1", status: "completed" },
    });
    expect(next).not.toBe(state);
    expect(next[0]).not.toBe(state[0]);
    // Original state is untouched
    expect(state[0].status).toBe("running");
  });

  it("updated for an unknown id is a no-op (same reference) AND logs a warning", () => {
    // Partial patches cannot synthesize a full Dispatch row; drop with a
    // warn so the producer invariant (created-before-updated) is observable.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = [makeDispatch("j1")];
    const next = applyDispatchEvent(state, {
      type: "updated",
      patch: { id: "unknown", status: "completed" },
    });
    expect(next).toBe(state);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/unknown id "unknown"/);
    warn.mockRestore();
  });

  it("preserves order of other dispatches when updating one in the middle", () => {
    const state = [makeDispatch("a"), makeDispatch("b"), makeDispatch("c")];
    const next = applyDispatchEvent(state, {
      type: "updated",
      patch: { id: "b", status: "completed" },
    });
    expect(next.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(next[1].status).toBe("completed");
  });
});

// ─── Composable integration tests ────────────────────────────────────────────
//
// useDispatches uses module-scoped singletons, so each test resets module state
// via vi.resetModules + re-import. Tests check surface behavior only — the
// reducer has its own coverage above.

describe("useDispatches — stream integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    currentStream = makeStreamMock();
    mockFetchDispatches.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function importFresh() {
    const mod = await import("./useDispatches");
    return mod;
  }

  it("contains no setInterval / setTimeout polling (source check)", async () => {
    // Assert the module source never calls timer-based polling. This keeps
    // Phase 4 from silently regressing to a polling implementation.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "useDispatches.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
    expect(source).not.toMatch(/setTimeout\s*\(/);
  });

  it("init() hydrates via REST, then subscribes to created + updated topics", async () => {
    const { useDispatches } = await importFresh();
    mockFetchDispatches.mockResolvedValueOnce([makeDispatch("seed")]);

    const { init, dispatches, destroy } = useDispatches();
    init();
    await flushPromises();

    expect(mockFetchDispatches).toHaveBeenCalledOnce();
    expect(dispatches.value.map((d) => d.id)).toEqual(["seed"]);
    // Two subscriptions: one per topic
    expect(currentStream.handlerCount("dispatch:created")).toBe(1);
    expect(currentStream.handlerCount("dispatch:updated")).toBe(1);

    destroy();
  });

  it("applies stream created events to the local list after hydration", async () => {
    const { useDispatches } = await importFresh();
    mockFetchDispatches.mockResolvedValueOnce([makeDispatch("seed")]);

    const { init, dispatches, destroy } = useDispatches();
    init();
    await flushPromises();

    currentStream.emit("dispatch:created", makeDispatch("live"));

    expect(dispatches.value.map((d) => d.id)).toEqual(["live", "seed"]);

    destroy();
  });

  it("applies stream updated events by merging onto the matching row", async () => {
    const { useDispatches } = await importFresh();
    mockFetchDispatches.mockResolvedValueOnce([
      makeDispatch("j1", { status: "running" }),
    ]);

    const { init, dispatches, destroy } = useDispatches();
    init();
    await flushPromises();

    currentStream.emit("dispatch:updated", {
      id: "j1",
      status: "completed",
      tokensTotal: 42,
    });

    expect(dispatches.value[0].status).toBe("completed");
    expect(dispatches.value[0].tokensTotal).toBe(42);

    destroy();
  });

  it("replays events that arrive during the REST fetch (hydrate-then-patch race)", async () => {
    const { useDispatches } = await importFresh();
    // Control when fetchDispatches resolves so we can inject an event mid-fetch.
    let resolveFetch!: (v: Dispatch[]) => void;
    mockFetchDispatches.mockReturnValueOnce(
      new Promise<Dispatch[]>((r) => { resolveFetch = r; }),
    );

    const { init, dispatches, destroy } = useDispatches();
    init();
    // Subscription is set up synchronously; emit an event while REST is in flight.
    await Promise.resolve();
    currentStream.emit("dispatch:created", makeDispatch("in-flight"));

    resolveFetch([makeDispatch("seed")]);
    await flushPromises();

    // The in-flight event must not be lost — it applies on top of REST.
    expect(dispatches.value.map((d) => d.id)).toEqual(["in-flight", "seed"]);

    destroy();
  });

  it("dedupes a created event whose id is already in the REST response", async () => {
    const { useDispatches } = await importFresh();
    let resolveFetch!: (v: Dispatch[]) => void;
    mockFetchDispatches.mockReturnValueOnce(
      new Promise<Dispatch[]>((r) => { resolveFetch = r; }),
    );

    const { init, dispatches, destroy } = useDispatches();
    init();
    await Promise.resolve();
    currentStream.emit("dispatch:created", makeDispatch("dup"));

    resolveFetch([makeDispatch("dup"), makeDispatch("seed")]);
    await flushPromises();

    // Only one "dup" entry — the stream event dedupes against REST.
    const ids = dispatches.value.map((d) => d.id);
    expect(ids.filter((id) => id === "dup")).toHaveLength(1);

    destroy();
  });

  it("destroy() unwinds subscriptions, disconnects stream, and stops the filter watcher", async () => {
    const { useDispatches } = await importFresh();
    mockFetchDispatches.mockResolvedValue([]);

    const { init, selectedRepo, destroy } = useDispatches();
    init();
    await flushPromises();
    expect(currentStream.handlerCount("dispatch:created")).toBe(1);
    expect(currentStream.handlerCount("dispatch:updated")).toBe(1);
    const fetchCallsBefore = mockFetchDispatches.mock.calls.length;

    destroy();

    // Stream teardown + subscription unwind
    expect(currentStream.disconnect).toHaveBeenCalledOnce();
    expect(currentStream.handlerCount("dispatch:created")).toBe(0);
    expect(currentStream.handlerCount("dispatch:updated")).toBe(0);

    // Filter watcher stopped — mutating a filter ref after destroy must NOT
    // trigger another REST fetch.
    selectedRepo.value = "post-destroy";
    await flushPromises();
    expect(mockFetchDispatches.mock.calls.length).toBe(fetchCallsBefore);
  });

  it("replays updated events that arrive during the REST fetch (race)", async () => {
    const { useDispatches } = await importFresh();
    let resolveFetch!: (v: Dispatch[]) => void;
    mockFetchDispatches.mockReturnValueOnce(
      new Promise<Dispatch[]>((r) => { resolveFetch = r; }),
    );

    const { init, dispatches, destroy } = useDispatches();
    init();
    await Promise.resolve();

    // Emit BOTH a created and a follow-up updated while REST is still pending.
    currentStream.emit("dispatch:created", makeDispatch("j1", { status: "running" }));
    currentStream.emit("dispatch:updated", {
      id: "j1",
      status: "completed",
      tokensTotal: 99,
    });

    resolveFetch([]);
    await flushPromises();

    // The queued update replayed on top of the queued create.
    expect(dispatches.value).toHaveLength(1);
    expect(dispatches.value[0].id).toBe("j1");
    expect(dispatches.value[0].status).toBe("completed");
    expect(dispatches.value[0].tokensTotal).toBe(99);

    destroy();
  });

  it("init() is idempotent — a second call does not re-subscribe or re-hydrate", async () => {
    const { useDispatches } = await importFresh();
    mockFetchDispatches.mockResolvedValue([]);

    const { init, destroy } = useDispatches();
    init();
    await flushPromises();
    const firstFetchCount = mockFetchDispatches.mock.calls.length;
    const firstSubCount = currentStream.subscribe.mock.calls.length;

    init(); // second call — should bail out early
    await flushPromises();

    expect(mockFetchDispatches.mock.calls.length).toBe(firstFetchCount);
    expect(currentStream.subscribe.mock.calls.length).toBe(firstSubCount);
    expect(currentStream.handlerCount("dispatch:created")).toBe(1);
    expect(currentStream.handlerCount("dispatch:updated")).toBe(1);

    destroy();
  });

  it("surfaces fetchDispatches rejection via error ref and clears loading", async () => {
    const { useDispatches } = await importFresh();
    mockFetchDispatches.mockRejectedValueOnce(new Error("network down"));

    const { init, loading, error, destroy } = useDispatches();
    init();
    await flushPromises();

    // Loading must flip back to false even when the fetch rejected — otherwise
    // the spinner hangs indefinitely on a transient network blip.
    expect(loading.value).toBe(false);
    expect(error.value).toBe("network down");

    destroy();
  });

  it("re-hydrates on filter change (REST fetched with new filter)", async () => {
    const { useDispatches } = await importFresh();
    mockFetchDispatches.mockResolvedValue([]);

    const { init, selectedRepo, destroy } = useDispatches();
    init();
    await flushPromises();
    expect(mockFetchDispatches).toHaveBeenCalledTimes(1);

    selectedRepo.value = "platform";
    await flushPromises();

    expect(mockFetchDispatches).toHaveBeenCalledTimes(2);
    const lastArgs = mockFetchDispatches.mock.calls[1][0];
    expect(lastArgs).toMatchObject({ repo: "platform" });

    destroy();
  });

  it("replays events that arrive during the filter-change refetch (re-hydrate race)", async () => {
    // Phase 7 regression guard: when a filter change triggers a re-hydrate,
    // events firing DURING the second fetch must be applied via applyEvent
    // on top of the new snapshot — they must NOT leak into live handlers
    // (which would double-apply against the soon-to-be-overwritten ref).
    const { useDispatches } = await importFresh();

    // First hydrate resolves immediately with a seed row.
    mockFetchDispatches.mockResolvedValueOnce([makeDispatch("seed")]);

    const { init, selectedRepo, dispatches, destroy } = useDispatches();
    init();
    await flushPromises();
    expect(dispatches.value.map((d) => d.id)).toEqual(["seed"]);

    // Second fetch (triggered by filter change) hangs so we can inject an event mid-flight.
    let resolveSecond!: (v: Dispatch[]) => void;
    mockFetchDispatches.mockReturnValueOnce(
      new Promise<Dispatch[]>((r) => {
        resolveSecond = r;
      }),
    );

    selectedRepo.value = "platform";
    await Promise.resolve(); // watcher fires, hydrate begins

    // Event arrives while the second fetch is still in flight.
    currentStream.emit("dispatch:created", makeDispatch("mid-refetch"));

    resolveSecond([makeDispatch("after-filter")]);
    await flushPromises();

    // Both rows present — the in-flight event was applied on top of the
    // new filter's snapshot, not lost in the handoff.
    const ids = dispatches.value.map((d) => d.id).sort();
    expect(ids).toContain("after-filter");
    expect(ids).toContain("mid-refetch");

    destroy();
  });
});
