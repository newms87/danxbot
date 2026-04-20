import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, ref as vueRef, nextTick } from "vue";
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

// Helper: build an AgentSnapshot shell for tests.
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

/**
 * Mount a component that calls `useAgents()` inside setup so the
 * composable's `onMounted` / `onBeforeUnmount` hooks fire properly.
 * Exposes the composable return for assertions.
 */
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
  sessionStorage.clear();
  // Clean DOM prompt between tests so no leaked handler survives.
  (globalThis as { prompt?: unknown }).prompt = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
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
    // No further fetches after unmount — timer is cleared.
    expect(mockFetchAgents).toHaveBeenCalledTimes(2);
  });
});

describe("useAgents — optimistic toggle", () => {
  it("updates local state immediately and commits the server response", async () => {
    sessionStorage.setItem("danxbot.dispatchToken", "tok-abc");
    const updated = snap("danxbot", { slack: false });
    updated.counts.total.slack = 99;
    mockPatchToggle.mockResolvedValue(updated);

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    const togglePromise = ret.toggle("danxbot", "slack", false);
    // Optimistic update fires before the PATCH resolves.
    await nextTick();
    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBe(false);

    await togglePromise;
    // After the PATCH resolves, the server payload takes over (notice the
    // count jump to 99, which the optimistic update wouldn't have done).
    expect(ret.agents.value[0].counts.total.slack).toBe(99);
    expect(mockPatchToggle).toHaveBeenCalledWith(
      "danxbot",
      "slack",
      false,
      "tok-abc",
    );
    expect(ret.error.value).toBeNull();

    wrapper.unmount();
  });

  it("rolls back the local override and surfaces an error when PATCH fails", async () => {
    sessionStorage.setItem("danxbot.dispatchToken", "tok-abc");
    const err = Object.assign(new Error("disk full"), {
      status: 500,
      serverMessage: "disk full",
    });
    mockPatchToggle.mockRejectedValue(err);

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    // Original override is null (env default).
    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBeNull();

    await ret.toggle("danxbot", "slack", false);
    await flushPromises();

    // Rolled back to null, error surfaced.
    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBeNull();
    expect(ret.error.value).toBe("disk full");

    wrapper.unmount();
  });

  it("prompts for a token when sessionStorage is empty", async () => {
    // No token in sessionStorage — first PATCH should prompt.
    const promptSpy = vi.fn().mockReturnValue("new-token");
    (globalThis as { prompt: unknown }).prompt = promptSpy;
    mockPatchToggle.mockResolvedValue(snap("danxbot", { dispatchApi: false }));

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    await ret.toggle("danxbot", "dispatchApi", false);
    await flushPromises();

    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("danxbot.dispatchToken")).toBe("new-token");
    expect(mockPatchToggle).toHaveBeenCalledWith(
      "danxbot",
      "dispatchApi",
      false,
      "new-token",
    );

    wrapper.unmount();
  });

  it("clears the token and re-prompts on 401, then succeeds on retry", async () => {
    sessionStorage.setItem("danxbot.dispatchToken", "stale");
    const unauthorized = Object.assign(new Error("Unauthorized"), {
      status: 401,
      serverMessage: "Unauthorized",
    });
    mockPatchToggle
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce(snap("danxbot", { trelloPoller: true }));

    const promptSpy = vi.fn().mockReturnValue("fresh-token");
    (globalThis as { prompt: unknown }).prompt = promptSpy;

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    await ret.toggle("danxbot", "trelloPoller", true);
    await flushPromises();

    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(mockPatchToggle).toHaveBeenCalledTimes(2);
    expect(mockPatchToggle).toHaveBeenLastCalledWith(
      "danxbot",
      "trelloPoller",
      true,
      "fresh-token",
    );
    expect(sessionStorage.getItem("danxbot.dispatchToken")).toBe("fresh-token");
    expect(ret.error.value).toBeNull();

    wrapper.unmount();
  });

  it("rolls back and reports the error when the user cancels the token prompt", async () => {
    const promptSpy = vi.fn().mockReturnValue(null);
    (globalThis as { prompt: unknown }).prompt = promptSpy;

    const { wrapper, ret } = mountWithAgents();
    await flushPromises();

    await ret.toggle("danxbot", "slack", false);
    await flushPromises();

    expect(mockPatchToggle).not.toHaveBeenCalled();
    expect(ret.agents.value[0].settings.overrides.slack.enabled).toBeNull();
    expect(ret.error.value).toContain("no token");

    wrapper.unmount();
  });
});
