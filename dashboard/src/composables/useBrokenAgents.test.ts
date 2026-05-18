import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ref } from "vue";
import type { Ref } from "vue";
import { flushPromises } from "@vue/test-utils";

import type { AgentBrokenState, AgentSnapshot } from "../types";

function snapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    name: "danxbot",
    repoName: "danxbot",
    url: "u",
    settings: {
      schema_version: 1,
      meta: { updatedAt: "", updatedBy: "test" },
      overrides: {
        slack: { enabled: null },
        issuePoller: { enabled: null },
        dispatchApi: { enabled: null },
        ideator: { enabled: null },
        autoTriage: { enabled: null },
        trelloSync: { enabled: null },
      },
      display: null,
      agents: {},
      agentDefaults: { prepMode: "combined" },
    } as unknown as AgentSnapshot["settings"],
    counts: {
      total: { total: 0, slack: 0, trello: 0, api: 0 },
      last24h: { total: 0, slack: 0, trello: 0, api: 0 },
      today: { total: 0, slack: 0, trello: 0, api: 0 },
    },
    worker: { reachable: true, lastSeenMs: 1 },
    criticalFailure: null,
    issuePrefix: "DX",
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
    ...over,
  };
}

function agent(over: { broken?: AgentBrokenState | null; count?: number } = {}) {
  return {
    type: "agent" as const,
    bio: "",
    capabilities: ["issue-worker"],
    schedule: {
      tz: "UTC",
      always_on: true,
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    },
    enabled: true,
    broken:
      "broken" in over
        ? over.broken!
        : {
            reason: "Agent dispatch failing — investigation pending",
            suggested_steps: [],
            set_at: "2026-05-14T10:00:00Z",
            evaluator_status: "completed" as const,
            evaluator_dispatch_id: null,
          },
    strikes: {
      count: over.count ?? 3,
      history: [],
    },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-14T10:00:00Z",
  };
}

// ─── deriveBrokenAgents — pure helper (no module reload needed) ──────────────

describe("deriveBrokenAgents — pure helper", () => {
  it("returns [] when no agent on any repo is broken", async () => {
    const { deriveBrokenAgents } = await import("./useBrokenAgents");
    const snaps = [
      snapshot({
        settings: {
          ...snapshot().settings,
          agents: { alice: agent({ broken: null }), bob: agent({ broken: null }) },
        } as unknown as AgentSnapshot["settings"],
      }),
    ];
    expect(deriveBrokenAgents(snaps)).toEqual([]);
  });

  it("flattens broken agents across repos with stable repo+agent order", async () => {
    const { deriveBrokenAgents } = await import("./useBrokenAgents");
    const snaps = [
      snapshot({
        name: "danxbot",
        repoName: "danxbot",
        settings: {
          ...snapshot().settings,
          agents: {
            charlie: agent(),
            alice: agent({ broken: null }),
            bob: agent(),
          },
        } as unknown as AgentSnapshot["settings"],
      }),
      snapshot({
        name: "platform",
        repoName: "platform",
        settings: {
          ...snapshot().settings,
          agents: { eve: agent() },
        } as unknown as AgentSnapshot["settings"],
      }),
    ];
    const out = deriveBrokenAgents(snaps);
    expect(out.map((e) => `${e.repoName}/${e.agentName}`)).toEqual([
      "danxbot/bob",
      "danxbot/charlie",
      "platform/eve",
    ]);
  });

  it("carries broken + strikes through verbatim and stamps unblocking/reRunning=false", async () => {
    const { deriveBrokenAgents } = await import("./useBrokenAgents");
    const snaps = [
      snapshot({
        settings: {
          ...snapshot().settings,
          agents: {
            alice: agent({ count: 3 }),
          },
        } as unknown as AgentSnapshot["settings"],
      }),
    ];
    const out = deriveBrokenAgents(snaps);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      repoName: "danxbot",
      agentName: "alice",
      strikes: { count: 3, history: [] },
      unblocking: false,
      reRunning: false,
    });
    expect(out[0].broken!.reason).toMatch(/investigation pending/);
  });

  it("handles missing agents map (legacy fixture / corrupt settings)", async () => {
    const { deriveBrokenAgents } = await import("./useBrokenAgents");
    const snaps = [
      snapshot({
        settings: {
          ...snapshot().settings,
          agents: undefined as unknown as AgentSnapshot["settings"]["agents"],
        } as unknown as AgentSnapshot["settings"],
      }),
    ];
    expect(deriveBrokenAgents(snaps)).toEqual([]);
  });
});

// ─── DX-687 regression: shared fetch / derived computed ──────────────────────

const mockFetchAgents = vi.fn();
const mockPostAgentUnblock = vi.fn();
const mockPostAgentReRunEvaluator = vi.fn();

vi.mock("../api", () => ({
  fetchAgents: (...args: unknown[]) => mockFetchAgents(...args),
  fetchAgent: vi.fn(),
  patchToggle: vi.fn(),
  clearCriticalFailure: vi.fn(),
  postAgentUnblock: (...args: unknown[]) => mockPostAgentUnblock(...args),
  postAgentReRunEvaluator: (...args: unknown[]) =>
    mockPostAgentReRunEvaluator(...args),
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

function brokenSnap(): AgentSnapshot {
  return snapshot({
    settings: {
      ...snapshot().settings,
      agents: { alice: agent() },
    } as unknown as AgentSnapshot["settings"],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentStream = makeStreamMock();
  vi.resetModules();
});

describe("useBrokenAgents — derived computed over useAgents singleton (DX-687)", () => {
  it("does NOT call fetchAgents on use — relies on useAgents singleton", async () => {
    const { useBrokenAgents } = await import("./useBrokenAgents");
    const { entries } = useBrokenAgents();

    // No init triggered → no fetch.
    await flushPromises();
    expect(mockFetchAgents).not.toHaveBeenCalled();
    expect(entries.value).toEqual([]);
  });

  it("mounting useBrokenAgents + useAgents fires EXACTLY ONE GET /api/agents (regression)", async () => {
    mockFetchAgents.mockResolvedValue([brokenSnap()]);
    const { useAgents } = await import("./useAgents");
    const { useBrokenAgents } = await import("./useBrokenAgents");

    // Banner-shape: read entries before useAgents.init().
    const banner = useBrokenAgents();
    // Settings-shape: useAgents().init() drives the shared fetch.
    useAgents().init();
    await flushPromises();

    expect(mockFetchAgents).toHaveBeenCalledOnce();
    expect(currentStream.handlerCount("agent:updated")).toBe(1);
    expect(banner.entries.value).toHaveLength(1);
    expect(banner.entries.value[0]).toMatchObject({
      repoName: "danxbot",
      agentName: "alice",
    });
  });

  it("re-derives when the shared snapshot updates via agent:updated", async () => {
    mockFetchAgents.mockResolvedValue([
      snapshot({
        settings: {
          ...snapshot().settings,
          agents: { alice: agent({ broken: null }) },
        } as unknown as AgentSnapshot["settings"],
      }),
    ]);
    const { useAgents } = await import("./useAgents");
    const { useBrokenAgents } = await import("./useBrokenAgents");
    const { entries } = useBrokenAgents();
    useAgents().init();
    await flushPromises();
    expect(entries.value).toEqual([]);

    // Server stamps alice broken → SSE event arrives.
    currentStream.emit("agent:updated", brokenSnap());

    expect(entries.value).toHaveLength(1);
    expect(entries.value[0].agentName).toBe("alice");
  });

  it("unblock() tracks the in-flight flag mid-flight and survives re-derivation", async () => {
    mockFetchAgents.mockResolvedValue([brokenSnap()]);
    let resolveUnblock!: () => void;
    mockPostAgentUnblock.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveUnblock = r;
      }),
    );

    const { useAgents } = await import("./useAgents");
    const { useBrokenAgents } = await import("./useBrokenAgents");
    const banner = useBrokenAgents();
    useAgents().init();
    await flushPromises();

    const p = banner.unblock("danxbot", "alice");
    await flushPromises();
    expect(banner.entries.value[0].unblocking).toBe(true);

    // SSE re-emits a broken snapshot (with mutated counts to prove the
    // flag merge survives non-trivial re-derivation, not just an
    // identity-equal emit).
    const churn = brokenSnap();
    churn.counts.total.total = 42;
    currentStream.emit("agent:updated", churn);
    expect(banner.entries.value[0].unblocking).toBe(true);

    resolveUnblock();
    await p;
    // Always cleared in finally — symmetric with reRunEvaluator. Even
    // on success, the SSE-row-removal path is the source of truth; the
    // local spinner just settles.
    expect(banner.entries.value[0].unblocking).toBe(false);
    expect(mockPostAgentUnblock).toHaveBeenCalledWith("danxbot", "alice");
  });

  it("unblock() surfaces error + clears the flag when the POST fails", async () => {
    mockFetchAgents.mockResolvedValue([brokenSnap()]);
    mockPostAgentUnblock.mockRejectedValueOnce(new Error("nope"));

    const { useAgents } = await import("./useAgents");
    const { useBrokenAgents } = await import("./useBrokenAgents");
    const banner = useBrokenAgents();
    useAgents().init();
    await flushPromises();

    await banner.unblock("danxbot", "alice");
    expect(banner.error.value).toMatch(/nope/);
    expect(banner.entries.value[0].unblocking).toBe(false);
  });

  it("reRunEvaluator() posts and resets the flag in the finally block", async () => {
    mockFetchAgents.mockResolvedValue([brokenSnap()]);
    mockPostAgentReRunEvaluator.mockResolvedValueOnce(undefined);

    const { useAgents } = await import("./useAgents");
    const { useBrokenAgents } = await import("./useBrokenAgents");
    const banner = useBrokenAgents();
    useAgents().init();
    await flushPromises();

    await banner.reRunEvaluator("danxbot", "alice");
    expect(mockPostAgentReRunEvaluator).toHaveBeenCalledWith("danxbot", "alice");
    expect(banner.entries.value[0].reRunning).toBe(false);
  });
});

describe("useBrokenAgents — resetBrokenAgentsState", () => {
  it("clears the in-flight flag Map and error so a re-login starts clean", async () => {
    mockFetchAgents.mockResolvedValue([brokenSnap()]);
    mockPostAgentUnblock.mockRejectedValueOnce(new Error("bad"));

    const { useAgents } = await import("./useAgents");
    const { useBrokenAgents, resetBrokenAgentsState } = await import(
      "./useBrokenAgents"
    );
    const banner = useBrokenAgents();
    useAgents().init();
    await flushPromises();
    await banner.unblock("danxbot", "alice");
    expect(banner.error.value).toMatch(/bad/);

    resetBrokenAgentsState();

    expect(banner.error.value).toBeNull();
    // Re-emit the broken snapshot — flags are gone, so the entry's
    // mutation booleans land at false (the derive helper defaults).
    currentStream.emit("agent:updated", brokenSnap());
    expect(banner.entries.value[0].unblocking).toBe(false);
    expect(banner.entries.value[0].reRunning).toBe(false);
  });
});

describe("useBrokenAgents — AC4 stale doc-block removed", () => {
  it("source does NOT mention 'two sockets' (the stale DX-369 comment)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, "useBrokenAgents.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/two sockets/i);
  });
});

// DX-227 no-polling source check — every server-state composable carries
// this per-file lock so a regression "I'll just refresh every 30s here"
// fails the test before it lands. Repo-level sweep in
// `no-poll-imports.test.ts` is the second layer.
describe("useBrokenAgents source — no setInterval, no fetchAgents call", () => {
  it("does NOT call setInterval (server state flows via SSE only)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, "useBrokenAgents.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
  });

  it("does NOT import fetchAgents — derives from useAgents singleton (DX-687)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, "useBrokenAgents.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/\bfetchAgents\b/);
  });
});
