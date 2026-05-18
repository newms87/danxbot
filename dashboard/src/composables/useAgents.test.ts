import { describe, it, expect, beforeEach, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { Ref } from "vue";
import { flushPromises } from "@vue/test-utils";
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

function snap(
  name: string,
  overrides: Partial<
    Record<
      | "slack"
      | "issuePoller"
      | "dispatchApi"
      | "ideator"
      | "autoTriage"
      | "trelloSync",
      boolean | null
    >
  > = {},
): AgentSnapshot {
  return {
    name,
    repoName: name,
    url: `https://github.com/x/${name}.git`,
    settings: {
      overrides: {
        slack: { enabled: overrides.slack ?? null },
        issuePoller: { enabled: overrides.issuePoller ?? null },
        dispatchApi: { enabled: overrides.dispatchApi ?? null },
        ideator: { enabled: overrides.ideator ?? null },
        autoTriage: { enabled: overrides.autoTriage ?? null },
        trelloSync: { enabled: overrides.trelloSync ?? null },
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
    issuePrefix: "ISS",
    githubCredentials: {
      registered: false,
      token_shape_valid: false,
      last_validated_at: null,
      last_validation_error: null,
      token_prefix: "",
      token_suffix: "",
      token_expires_at: null,
      token_user_login: null,
    },
  } as AgentSnapshot;
}

// Module-singleton (DX-687): every test needs a fresh module to reset
// the shared refs / stream singleton. Re-import after `vi.resetModules`.
type UseAgentsMod = typeof import("./useAgents");
let mod: UseAgentsMod;

async function reloadModule(): Promise<UseAgentsMod> {
  vi.resetModules();
  mod = await import("./useAgents");
  return mod;
}

beforeEach(async () => {
  vi.clearAllMocks();
  currentStream = makeStreamMock();
  mockFetchAgents.mockResolvedValue([snap("danxbot"), snap("platform")]);
  await reloadModule();
});

// ─── Pure reducer tests ──────────────────────────────────────────────────────

describe("applyAgentEvent — reducer", () => {
  it("replaces the matching row by name and preserves order", () => {
    const state = [snap("a"), snap("b"), snap("c")];
    const patched = snap("b", { slack: false });
    const next = mod.applyAgentEvent(state, patched);
    expect(next.map((a) => a.name)).toEqual(["a", "b", "c"]);
    expect(next[1].settings.overrides.slack.enabled).toBe(false);
  });

  it("returns a new array and does not mutate the input", () => {
    const state = [snap("a")];
    const next = mod.applyAgentEvent(state, snap("a", { slack: true }));
    expect(next).not.toBe(state);
    expect(next[0]).not.toBe(state[0]);
    expect(state[0].settings.overrides.slack.enabled).toBeNull();
  });

  it("appends + warns when the snapshot's name is not in state (unknown repo)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = [snap("a")];
    const next = mod.applyAgentEvent(state, snap("newcomer"));
    expect(next.map((a) => a.name)).toEqual(["a", "newcomer"]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("isAgentSnapshot — type guard", () => {
  it("rejects non-object inputs", () => {
    expect(mod.isAgentSnapshot(null)).toBe(false);
    expect(mod.isAgentSnapshot(undefined)).toBe(false);
    expect(mod.isAgentSnapshot(42)).toBe(false);
    expect(mod.isAgentSnapshot("x")).toBe(false);
  });

  it("rejects objects missing `name` or with non-string `name`", () => {
    expect(mod.isAgentSnapshot({})).toBe(false);
    expect(mod.isAgentSnapshot({ name: 123, settings: {} })).toBe(false);
  });

  it("rejects objects missing `settings`", () => {
    expect(mod.isAgentSnapshot({ name: "x" })).toBe(false);
    expect(mod.isAgentSnapshot({ name: "x", settings: null })).toBe(false);
  });

  it("accepts objects with string `name` + object `settings`", () => {
    expect(mod.isAgentSnapshot({ name: "x", settings: {} })).toBe(true);
  });
});

// ─── Module-singleton lifecycle ──────────────────────────────────────────────

describe("useAgents — init/destroy singleton", () => {
  it("init() hydrates via REST and subscribes to agent:updated", async () => {
    const ret = mod.useAgents();
    ret.init();
    await flushPromises();

    expect(mockFetchAgents).toHaveBeenCalledOnce();
    expect(ret.agents.value.map((a) => a.name)).toEqual(["danxbot", "platform"]);
    expect(currentStream.handlerCount("agent:updated")).toBe(1);
  });

  it("init() is idempotent — multiple calls share ONE fetch + ONE subscription (DX-687)", async () => {
    const a = mod.useAgents();
    const b = mod.useAgents();
    a.init();
    b.init();
    a.init();
    await flushPromises();

    expect(mockFetchAgents).toHaveBeenCalledOnce();
    expect(currentStream.handlerCount("agent:updated")).toBe(1);
  });

  it("multiple useAgents() callers see the SAME agents ref", async () => {
    const a = mod.useAgents();
    const b = mod.useAgents();
    a.init();
    await flushPromises();

    expect(a.agents).toBe(b.agents);
    expect(b.agents.value.map((x) => x.name)).toEqual(["danxbot", "platform"]);
  });

  it("destroy() unsubscribes and disconnects the stream", async () => {
    const ret = mod.useAgents();
    ret.init();
    await flushPromises();
    expect(currentStream.handlerCount("agent:updated")).toBe(1);

    ret.destroy();

    expect(currentStream.handlerCount("agent:updated")).toBe(0);
    expect(currentStream.disconnect).toHaveBeenCalled();
  });

  it("sets `error` and flips `loading` false when fetch fails", async () => {
    mockFetchAgents.mockRejectedValueOnce(new Error("network down"));
    const ret = mod.useAgents();
    ret.init();
    await flushPromises();

    expect(ret.error.value).toContain("network down");
    expect(ret.loading.value).toBe(false);
    expect(ret.agents.value).toEqual([]);
  });

  it("contains no setInterval / setTimeout polling (source check)", async () => {
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
    const ret = mod.useAgents();
    ret.init();
    await flushPromises();

    const patched = snap("danxbot", { slack: false });
    patched.counts.total.slack = 99;
    currentStream.emit("agent:updated", patched);

    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBe(false);
    expect(ret.agents.value[0].counts.total.slack).toBe(99);
    expect(ret.agents.value.map((a) => a.name)).toEqual(["danxbot", "platform"]);
  });

  it("skips malformed payloads and logs a warning (no half-rendered rows)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ret = mod.useAgents();
    ret.init();
    await flushPromises();

    currentStream.emit("agent:updated", null);
    currentStream.emit("agent:updated", "not an object");
    currentStream.emit("agent:updated", { noName: true });

    expect(ret.agents.value.map((a) => a.name)).toEqual(["danxbot", "platform"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("replays events that arrive during the REST fetch (hydrate race)", async () => {
    let resolveFetch!: (v: AgentSnapshot[]) => void;
    mockFetchAgents.mockReturnValueOnce(
      new Promise<AgentSnapshot[]>((r) => {
        resolveFetch = r;
      }),
    );

    const ret = mod.useAgents();
    ret.init();
    await nextTick();
    currentStream.emit("agent:updated", snap("danxbot", { slack: false }));

    resolveFetch([snap("danxbot"), snap("platform")]);
    await flushPromises();

    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBe(false);
  });
});

describe("useAgents — refresh public API", () => {
  it("re-invokes hydrate and clears any prior error", async () => {
    mockFetchAgents
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([snap("danxbot"), snap("platform")]);

    const ret = mod.useAgents();
    ret.init();
    await flushPromises();
    expect(ret.error.value).toBe("transient");
    expect(ret.agents.value).toEqual([]);

    await ret.refresh();
    expect(ret.error.value).toBeNull();
    expect(ret.agents.value.map((a) => a.name)).toEqual(["danxbot", "platform"]);
  });
});

// ─── Preserved behavior: optimistic toggle + clearCriticalFailure ────────────

describe("useAgents — optimistic toggle", () => {
  it("updates local state immediately and commits the server response", async () => {
    const updated = snap("danxbot", { slack: false });
    updated.counts.total.slack = 99;
    mockPatchToggle.mockResolvedValue(updated);

    const ret = mod.useAgents();
    ret.init();
    await flushPromises();

    const togglePromise = ret.toggle("danxbot", "slack", false);
    await nextTick();
    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBe(false);

    await togglePromise;
    expect(ret.agents.value[0].counts.total.slack).toBe(99);
    expect(mockPatchToggle).toHaveBeenCalledWith("danxbot", "slack", false);
    expect(ret.error.value).toBeNull();
  });

  it("rolls back the local override and surfaces an error when PATCH fails", async () => {
    const err = Object.assign(new Error("disk full"), {
      status: 500,
      serverMessage: "disk full",
    });
    mockPatchToggle.mockRejectedValue(err);

    const ret = mod.useAgents();
    ret.init();
    await flushPromises();

    await ret.toggle("danxbot", "slack", false);
    await flushPromises();

    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBeNull();
    expect(ret.error.value).toBe("disk full");
  });

  it("records an error and does NOT patch when the repo is unknown", async () => {
    const ret = mod.useAgents();
    ret.init();
    await flushPromises();

    await ret.toggle("nonexistent", "slack", false);

    expect(mockPatchToggle).not.toHaveBeenCalled();
    expect(ret.error.value).toContain("Unknown repo");
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

    const ret = mod.useAgents();
    ret.init();
    await flushPromises();

    await ret.clearCriticalFailure("danxbot");

    expect(mockClearCriticalFailure).toHaveBeenCalledWith("danxbot");
    expect(mockFetchAgent).toHaveBeenCalledWith("danxbot");
    expect(ret.agents.value[0].criticalFailure).toBeNull();
    expect(ret.error.value).toBeNull();
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

    const ret = mod.useAgents();
    ret.init();
    await flushPromises();

    await ret.clearCriticalFailure("danxbot");

    expect(ret.error.value).toBe("Worker unreachable");
    expect(mockFetchAgent).not.toHaveBeenCalled();
    expect(ret.agents.value[0].criticalFailure).not.toBeNull();
  });
});
