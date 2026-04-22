import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import type { Ref } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import type { AgentSnapshot } from "../types";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockFetchAgents = vi.fn();
const mockFetchAgent = vi.fn();
const mockPatchToggle = vi.fn();
const mockClearCriticalFailure = vi.fn();

vi.mock("../api", () => ({
  fetchAgents: (...args: unknown[]) => mockFetchAgents(...args),
  fetchAgent: (...args: unknown[]) => mockFetchAgent(...args),
  patchToggle: (...args: unknown[]) => mockPatchToggle(...args),
  clearCriticalFailure: (...args: unknown[]) =>
    mockClearCriticalFailure(...args),
}));

// useStream is mocked with a capturing handle so tests can push events on
// demand AND inspect subscription lifecycle.
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
  };
}

let currentStream: StreamMock;
vi.mock("./useStream", async () => {
  const actual =
    await vi.importActual<typeof import("./useStream")>("./useStream");
  return {
    ...actual,
    useStream: () => currentStream,
  };
});

// Import AFTER mocks.
import { useAgents, applyAgentEvent, isAgentSnapshot } from "./useAgents";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function snap(
  name: string,
  overrides: Partial<
    Record<"slack" | "trelloPoller" | "dispatchApi", boolean | null>
  > = {},
): AgentSnapshot {
  return {
    name,
    url: `https://github.com/x/${name}.git`,
    settings: {
      overrides: {
        slack: { enabled: overrides.slack ?? null },
        trelloPoller: { enabled: overrides.trelloPoller ?? null },
        dispatchApi: { enabled: overrides.dispatchApi ?? null },
      },
      display: {},
      meta: { updatedAt: "2026-04-20T00:00:00Z", updatedBy: "dashboard:test" },
    },
    counts: {
      total: { total: 0, slack: 0, trello: 0, api: 0 },
      last24h: { total: 0, slack: 0, trello: 0, api: 0 },
      today: { total: 0, slack: 0, trello: 0, api: 0 },
    },
    worker: { reachable: true, lastSeenMs: Date.now() },
    criticalFailure: null,
  } as AgentSnapshot;
}

function mountWithAgents() {
  const exposed = { ret: null as ReturnType<typeof useAgents> | null };
  const Host = defineComponent({
    setup() {
      exposed.ret = useAgents();
      return () => h("div");
    },
  });
  const wrapper = mount(Host);
  return {
    wrapper,
    get ret() {
      return exposed.ret!;
    },
  };
}

/**
 * Simulate a visibility change — happy-dom ships a visibilityState setter
 * via Object.defineProperty. We flip + dispatch the event the browser would.
 */
function setVisibility(state: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.clearAllMocks();
  currentStream = makeStreamMock();
  mockFetchAgents.mockResolvedValue([snap("danxbot"), snap("platform")]);
  setVisibility("visible");
});

afterEach(() => {
  setVisibility("visible");
});

// ─── Pure reducer tests ──────────────────────────────────────────────────────

describe("applyAgentEvent — reducer", () => {
  it("replaces the matching row by name and preserves order", () => {
    const state = [snap("a"), snap("b"), snap("c")];
    const patched = snap("b", { slack: false });
    const next = applyAgentEvent(state, patched);
    expect(next.map((a) => a.name)).toEqual(["a", "b", "c"]);
    expect(next[1].settings.overrides.slack.enabled).toBe(false);
  });

  it("returns a new array and does not mutate the input", () => {
    const state = [snap("a")];
    const next = applyAgentEvent(state, snap("a", { slack: true }));
    expect(next).not.toBe(state);
    expect(next[0]).not.toBe(state[0]);
    expect(state[0].settings.overrides.slack.enabled).toBeNull();
  });

  it("appends + warns when the snapshot's name is not in state (unknown repo)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = [snap("a")];
    const next = applyAgentEvent(state, snap("newcomer"));
    expect(next.map((a) => a.name)).toEqual(["a", "newcomer"]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("isAgentSnapshot — type guard", () => {
  it("rejects non-object inputs", () => {
    expect(isAgentSnapshot(null)).toBe(false);
    expect(isAgentSnapshot(undefined)).toBe(false);
    expect(isAgentSnapshot(42)).toBe(false);
    expect(isAgentSnapshot("x")).toBe(false);
  });

  it("rejects objects missing `name` or with non-string `name`", () => {
    expect(isAgentSnapshot({})).toBe(false);
    expect(isAgentSnapshot({ name: 123, settings: {} })).toBe(false);
  });

  it("rejects objects missing `settings`", () => {
    expect(isAgentSnapshot({ name: "x" })).toBe(false);
    expect(isAgentSnapshot({ name: "x", settings: null })).toBe(false);
  });

  it("accepts objects with string `name` + object `settings`", () => {
    expect(isAgentSnapshot({ name: "x", settings: {} })).toBe(true);
  });
});

// ─── Composable integration tests ────────────────────────────────────────────

describe("useAgents — fetch + refresh", () => {
  it("hydrates via REST on mount and subscribes to agent:updated", async () => {
    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    expect(mockFetchAgents).toHaveBeenCalledOnce();
    expect(ret.agents.value.map((a) => a.name)).toEqual(["danxbot", "platform"]);
    expect(currentStream.handlerCount("agent:updated")).toBe(1);

    wrapper.unmount();
  });

  it("sets `error` and flips `loading` false when fetch fails", async () => {
    mockFetchAgents.mockRejectedValueOnce(new Error("network down"));

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    expect(ret.error.value).toContain("network down");
    expect(ret.loading.value).toBe(false);
    expect(ret.agents.value).toEqual([]);

    wrapper.unmount();
  });

  it("contains no setInterval / setTimeout polling (source check)", async () => {
    // Source-grep guard: the whole point of Phase 5 is to replace the 10s
    // polling with a stream subscription. A future edit that reintroduces
    // a timer silently regresses the epic — this test catches that.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "useAgents.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
    expect(source).not.toMatch(/setTimeout\s*\(/);
  });
});

describe("useAgents — stream events", () => {
  it("merges a live agent:updated snapshot by name", async () => {
    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    const patched = snap("danxbot", { slack: false });
    patched.counts.total.slack = 99;
    currentStream.emit("agent:updated", patched);

    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBe(false);
    expect(ret.agents.value[0].counts.total.slack).toBe(99);
    // Row position unchanged.
    expect(ret.agents.value.map((a) => a.name)).toEqual(["danxbot", "platform"]);

    wrapper.unmount();
  });

  it("skips malformed payloads and logs a warning (no half-rendered rows)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    currentStream.emit("agent:updated", null);
    currentStream.emit("agent:updated", "not an object");
    currentStream.emit("agent:updated", { noName: true });

    // State unchanged by any of the three malformed events.
    expect(ret.agents.value.map((a) => a.name)).toEqual(["danxbot", "platform"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    wrapper.unmount();
  });

  it("replays events that arrive during the REST fetch (hydrate race)", async () => {
    // Delay the fetch so we can inject a stream event mid-flight.
    let resolveFetch!: (v: AgentSnapshot[]) => void;
    mockFetchAgents.mockReturnValueOnce(
      new Promise<AgentSnapshot[]>((r) => {
        resolveFetch = r;
      }),
    );

    const { wrapper, ret } = mountWithAgents();
    // Subscription wired synchronously in onMounted — emit before fetch resolves.
    await nextTick();
    currentStream.emit("agent:updated", snap("danxbot", { slack: false }));

    resolveFetch([snap("danxbot"), snap("platform")]);
    await flushPromises();

    // The in-flight stream event must apply on top of REST, not be lost.
    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBe(false);

    wrapper.unmount();
  });
});

describe("useAgents — refresh public API", () => {
  it("re-invokes hydrate and clears any prior error", async () => {
    mockFetchAgents
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([snap("danxbot"), snap("platform")]);

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();
    expect(ret.error.value).toBe("transient");
    expect(ret.agents.value).toEqual([]);

    await ret.refresh();
    expect(ret.error.value).toBeNull();
    expect(ret.agents.value.map((a) => a.name)).toEqual(["danxbot", "platform"]);

    wrapper.unmount();
  });
});

describe("useAgents — visibility-pause", () => {
  it("disconnects the stream when the tab is hidden", async () => {
    const { wrapper } = mountWithAgents();
    await flushPromises();
    expect(currentStream.handlerCount("agent:updated")).toBe(1);

    setVisibility("hidden");
    await nextTick();

    expect(currentStream.disconnect).toHaveBeenCalled();
    expect(currentStream.handlerCount("agent:updated")).toBe(0);

    wrapper.unmount();
  });

  it("is idempotent — visible->visible does not double-subscribe", async () => {
    const { wrapper } = mountWithAgents();
    await flushPromises();
    expect(currentStream.handlerCount("agent:updated")).toBe(1);
    const subCallsBefore = currentStream.subscribe.mock.calls.length;

    setVisibility("visible");
    setVisibility("visible");
    await flushPromises();

    // Still exactly one handler — the `if (unsubUpdated) return` guard holds.
    expect(currentStream.handlerCount("agent:updated")).toBe(1);
    expect(currentStream.subscribe.mock.calls.length).toBe(subCallsBefore);

    wrapper.unmount();
  });

  it("re-subscribes and re-hydrates when the tab becomes visible again", async () => {
    const { wrapper } = mountWithAgents();
    await flushPromises();
    const fetchesBefore = mockFetchAgents.mock.calls.length;

    setVisibility("hidden");
    await nextTick();
    expect(currentStream.handlerCount("agent:updated")).toBe(0);

    setVisibility("visible");
    await flushPromises();

    expect(currentStream.handlerCount("agent:updated")).toBe(1);
    expect(mockFetchAgents.mock.calls.length).toBe(fetchesBefore + 1);

    wrapper.unmount();
  });
});

describe("useAgents — teardown", () => {
  it("unmount unsubscribes, disconnects stream, removes visibility listener", async () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { wrapper } = mountWithAgents();
    await flushPromises();
    expect(currentStream.handlerCount("agent:updated")).toBe(1);

    wrapper.unmount();

    expect(currentStream.handlerCount("agent:updated")).toBe(0);
    expect(currentStream.disconnect).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    removeSpy.mockRestore();

    // After unmount, a spurious event must not cause a re-hydrate.
    const fetchesAfter = mockFetchAgents.mock.calls.length;
    setVisibility("hidden");
    setVisibility("visible");
    await flushPromises();
    expect(mockFetchAgents.mock.calls.length).toBe(fetchesAfter);
  });
});

// ─── Preserved behavior: optimistic toggle + clearCriticalFailure ────────────

describe("useAgents — optimistic toggle", () => {
  it("updates local state immediately and commits the server response", async () => {
    const updated = snap("danxbot", { slack: false });
    updated.counts.total.slack = 99;
    mockPatchToggle.mockResolvedValue(updated);

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    const togglePromise = ret.toggle("danxbot", "slack", false);
    await nextTick();
    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBe(false);

    await togglePromise;
    expect(ret.agents.value[0].counts.total.slack).toBe(99);
    expect(mockPatchToggle).toHaveBeenCalledWith("danxbot", "slack", false);
    expect(ret.error.value).toBeNull();

    wrapper.unmount();
  });

  it("rolls back the local override and surfaces an error when PATCH fails", async () => {
    const err = Object.assign(new Error("disk full"), {
      status: 500,
      serverMessage: "disk full",
    });
    mockPatchToggle.mockRejectedValue(err);

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    await ret.toggle("danxbot", "slack", false);
    await flushPromises();

    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBeNull();
    expect(ret.error.value).toBe("disk full");

    wrapper.unmount();
  });

  it("records an error and does NOT patch when the repo is unknown", async () => {
    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    await ret.toggle("nonexistent", "slack", false);

    expect(mockPatchToggle).not.toHaveBeenCalled();
    expect(ret.error.value).toContain("Unknown repo");

    wrapper.unmount();
  });
});

describe("useAgents — clearCriticalFailure", () => {
  it("calls the clear API, fetches the fresh snapshot, and swaps it in", async () => {
    const flaggedSnap = snap("danxbot");
    (flaggedSnap as { criticalFailure: unknown }).criticalFailure = {
      timestamp: "2026-04-21T00:00:00Z",
      source: "agent",
      dispatchId: "d-1",
      reason: "MCP unavailable",
    };
    mockFetchAgents.mockResolvedValue([flaggedSnap, snap("platform")]);
    mockClearCriticalFailure.mockResolvedValue({ cleared: true });
    mockFetchAgent.mockResolvedValue(snap("danxbot"));

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    await ret.clearCriticalFailure("danxbot");

    expect(mockClearCriticalFailure).toHaveBeenCalledWith("danxbot");
    expect(mockFetchAgent).toHaveBeenCalledWith("danxbot");
    expect(ret.agents.value[0].criticalFailure).toBeNull();
    expect(ret.error.value).toBeNull();

    wrapper.unmount();
  });

  it("surfaces an error and leaves the agents list untouched when DELETE fails", async () => {
    const flaggedSnap = snap("danxbot");
    (flaggedSnap as { criticalFailure: unknown }).criticalFailure = {
      timestamp: "2026-04-21T00:00:00Z",
      source: "agent",
      dispatchId: "d-1",
      reason: "MCP unavailable",
    };
    mockFetchAgents.mockResolvedValue([flaggedSnap]);
    mockClearCriticalFailure.mockRejectedValue(
      Object.assign(new Error("502 upstream"), {
        status: 502,
        serverMessage: "Worker unreachable",
      }),
    );

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    await ret.clearCriticalFailure("danxbot");

    expect(ret.error.value).toBe("Worker unreachable");
    expect(mockFetchAgent).not.toHaveBeenCalled();
    expect(ret.agents.value[0].criticalFailure).not.toBeNull();

    wrapper.unmount();
  });
});
