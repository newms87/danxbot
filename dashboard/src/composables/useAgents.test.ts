import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import type { AgentSnapshot } from "../types";

// Mock the API layer so we drive fetch/patch behavior from tests.
const mockFetchAgents = vi.fn();
const mockPatchToggle = vi.fn();

vi.mock("../api", () => ({
  fetchAgents: (...args: unknown[]) => mockFetchAgents(...args),
  patchToggle: (...args: unknown[]) => mockPatchToggle(...args),
}));

// Import under test AFTER mock.
import { useAgents } from "./useAgents";

function snap(
  name: string,
  overrides: Partial<Record<"slack" | "trelloPoller" | "dispatchApi", boolean | null>> = {},
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
      meta: { updatedAt: "2026-04-20T00:00:00Z", updatedBy: "dashboard" },
    },
    counts: {
      total: { total: 0, slack: 0, trello: 0, api: 0 },
      last24h: { total: 0, slack: 0, trello: 0, api: 0 },
      today: { total: 0, slack: 0, trello: 0, api: 0 },
    },
    worker: { reachable: true, lastSeenMs: Date.now() },
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
  return { wrapper, get ret() { return exposed.ret!; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchAgents.mockResolvedValue([snap("danxbot"), snap("platform")]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAgents — fetch + refresh", () => {
  it("fetches agents on mount and populates `agents`", async () => {
    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    expect(mockFetchAgents).toHaveBeenCalledOnce();
    expect(ret.agents.value).toHaveLength(2);
    expect(ret.agents.value[0].name).toBe("danxbot");

    wrapper.unmount();
  });

  it("sets `error` when fetch fails without throwing", async () => {
    mockFetchAgents.mockRejectedValueOnce(new Error("network down"));

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    expect(ret.error.value).toContain("network down");
    expect(ret.agents.value).toEqual([]);

    wrapper.unmount();
  });

  it("schedules a 10s refresh timer that tears down on unmount", async () => {
    vi.useFakeTimers();

    const { wrapper } = mountWithAgents();
    await flushPromises();
    expect(mockFetchAgents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(mockFetchAgents).toHaveBeenCalledTimes(2);

    wrapper.unmount();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockFetchAgents).toHaveBeenCalledTimes(2);
  });
});

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
    // No 4th arg — auth is provided by fetchWithAuth inside patchToggle.
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

    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBeNull();

    await ret.toggle("danxbot", "slack", false);
    await flushPromises();

    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBeNull();
    expect(ret.error.value).toBe("disk full");

    wrapper.unmount();
  });

  it("rolls back on 401 (auth:expired handled centrally by fetchWithAuth)", async () => {
    const unauthorized = Object.assign(new Error("Unauthorized"), {
      status: 401,
      serverMessage: "Unauthorized",
    });
    mockPatchToggle.mockRejectedValue(unauthorized);

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    await ret.toggle("danxbot", "trelloPoller", true);
    await flushPromises();

    expect(ret.agents.value[0].settings.overrides.trelloPoller.enabled).toBeNull();
    expect(ret.error.value).toBe("Unauthorized");

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
