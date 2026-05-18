import { describe, expect, it, vi, beforeEach } from "vitest";
import { ref, defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import type { AgentRuntimeState } from "../types";

const mockFetchAgentRuntimeState = vi.fn();

vi.mock("../api", () => ({
  fetchAgentRuntimeState: (...args: unknown[]) =>
    mockFetchAgentRuntimeState(...args),
}));

type StreamHandler = (event: { topic: string; data: unknown }) => void;
const streamHandlers: Map<string, Set<StreamHandler>> = new Map();
const mockDisconnect = vi.fn();

function makeMockStream() {
  return {
    subscribe: (topic: string, handler: StreamHandler) => {
      const set = streamHandlers.get(topic) ?? new Set();
      set.add(handler);
      streamHandlers.set(topic, set);
      return () => set.delete(handler);
    },
    disconnect: mockDisconnect,
  };
}

vi.mock("./useStream", () => ({
  useStream: () => makeMockStream(),
}));

import { useAgentRuntimeState } from "./useAgentRuntimeState";

function emit(topic: string, data: unknown): void {
  const set = streamHandlers.get(topic);
  if (!set) return;
  for (const h of set) h({ topic, data });
}

const STATE: AgentRuntimeState = {
  critical_failure: {
    timestamp: "2026-05-18T12:00:00Z",
    source: "agent",
    dispatchId: "d-1",
    reason: "MCP tools missing",
  },
  sync_state: null,
  runtime_settings: null,
};

describe("useAgentRuntimeState", () => {
  beforeEach(() => {
    mockFetchAgentRuntimeState.mockReset();
    streamHandlers.clear();
    mockDisconnect.mockReset();
  });

  it("fetches on mount and exposes the runtime-state payload", async () => {
    mockFetchAgentRuntimeState.mockResolvedValue(STATE);

    const Host = defineComponent({
      setup() {
        const composable = useAgentRuntimeState("danxbot");
        return { composable };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(Host);
    await nextTick();
    await nextTick();

    expect(mockFetchAgentRuntimeState).toHaveBeenCalledWith("danxbot");
    expect(wrapper.vm.composable.state.value).toEqual(STATE);
    expect(wrapper.vm.composable.error.value).toBeNull();
  });

  it("re-fetches when the repoName ref changes", async () => {
    mockFetchAgentRuntimeState.mockResolvedValue(STATE);
    const repoName = ref("danxbot");

    const Host = defineComponent({
      setup() {
        const composable = useAgentRuntimeState(repoName);
        return { composable };
      },
      render() {
        return h("div");
      },
    });

    mount(Host);
    await nextTick();
    await nextTick();
    expect(mockFetchAgentRuntimeState).toHaveBeenCalledTimes(1);

    repoName.value = "platform";
    await nextTick();
    await nextTick();
    expect(mockFetchAgentRuntimeState).toHaveBeenCalledTimes(2);
    expect(mockFetchAgentRuntimeState).toHaveBeenLastCalledWith("platform");
  });

  it("nulls state on fetch error (lets the parent's fallback path render)", async () => {
    mockFetchAgentRuntimeState.mockRejectedValue(new Error("network down"));

    const Host = defineComponent({
      setup() {
        const composable = useAgentRuntimeState("danxbot");
        return { composable };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(Host);
    await nextTick();
    await nextTick();

    expect(wrapper.vm.composable.state.value).toBeNull();
    expect(wrapper.vm.composable.error.value).toBe("network down");
  });

  it("refreshes on `agent:updated` SSE for the matching repo only", async () => {
    mockFetchAgentRuntimeState.mockResolvedValue(STATE);

    const Host = defineComponent({
      setup() {
        const composable = useAgentRuntimeState("danxbot");
        return { composable };
      },
      render() {
        return h("div");
      },
    });

    mount(Host);
    await nextTick();
    await nextTick();
    expect(mockFetchAgentRuntimeState).toHaveBeenCalledTimes(1);

    // Other repo — ignored.
    emit("agent:updated", { name: "platform" });
    await nextTick();
    expect(mockFetchAgentRuntimeState).toHaveBeenCalledTimes(1);

    // Matching repo — re-fetches.
    emit("agent:updated", { name: "danxbot" });
    await nextTick();
    expect(mockFetchAgentRuntimeState).toHaveBeenCalledTimes(2);
  });

  it("refreshes on `repo-root-sync:error` / `repo-root-sync:clear` for the matching repo", async () => {
    mockFetchAgentRuntimeState.mockResolvedValue(STATE);

    const Host = defineComponent({
      setup() {
        const composable = useAgentRuntimeState("danxbot");
        return { composable };
      },
      render() {
        return h("div");
      },
    });

    mount(Host);
    await nextTick();
    await nextTick();
    expect(mockFetchAgentRuntimeState).toHaveBeenCalledTimes(1);

    emit("repo-root-sync:error", { repoName: "danxbot", error: {} });
    await nextTick();
    expect(mockFetchAgentRuntimeState).toHaveBeenCalledTimes(2);

    emit("repo-root-sync:clear", { repoName: "danxbot" });
    await nextTick();
    expect(mockFetchAgentRuntimeState).toHaveBeenCalledTimes(3);
  });

  it("unsubscribes + disconnects on unmount (no stream leak)", async () => {
    mockFetchAgentRuntimeState.mockResolvedValue(STATE);

    const Host = defineComponent({
      setup() {
        const composable = useAgentRuntimeState("danxbot");
        return { composable };
      },
      render() {
        return h("div");
      },
    });

    const wrapper = mount(Host);
    await nextTick();
    await nextTick();

    wrapper.unmount();
    expect(mockDisconnect).toHaveBeenCalled();

    // Post-unmount events MUST NOT trigger refresh.
    mockFetchAgentRuntimeState.mockClear();
    emit("agent:updated", { name: "danxbot" });
    await nextTick();
    expect(mockFetchAgentRuntimeState).not.toHaveBeenCalled();
  });
});
