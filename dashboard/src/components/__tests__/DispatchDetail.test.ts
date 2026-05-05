import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const mockFetchDispatchDetail = vi.fn();
const mockFollowDispatch = vi.fn();

vi.mock("../../api", () => ({
  fetchDispatchDetail: (...args: unknown[]) => mockFetchDispatchDetail(...args),
  followDispatch: (...args: unknown[]) => mockFollowDispatch(...args),
}));

import DispatchDetail from "../DispatchDetail.vue";
import type {
  Dispatch,
  DispatchDetail as DispatchDetailType,
  JsonlBlock,
  ToolUseBlock,
} from "../../types";

function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "dispatch-aaaa-bbbb-cccc-dddd",
    repoName: "danxbot",
    trigger: "api",
    triggerMetadata: {
      endpoint: "/api/launch",
      callerIp: null,
      statusUrl: null,
      initialPrompt: "go",
    },
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    status: "completed",
    startedAt: 1700000000000,
    completedAt: 1700000060000,
    summary: null,
    error: null,
    runtimeMode: "docker",
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    hostPid: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockFetchDispatchDetail.mockReset();
  mockFollowDispatch.mockReset();
  mockFollowDispatch.mockReturnValue(() => {});
});

describe("DispatchDetail", () => {
  it("loads detail on mount and renders the timeline", async () => {
    const timeline: JsonlBlock[] = [
      { type: "user", text: "kick off", timestampMs: 1 },
      { type: "assistant_text", text: "working on it", timestampMs: 2 },
    ];
    const detail: DispatchDetailType = {
      dispatch: makeDispatch(),
      timeline,
      totals: null,
    };
    mockFetchDispatchDetail.mockResolvedValueOnce(detail);

    const w = mount(DispatchDetail, {
      props: { dispatch: makeDispatch() },
    });
    await flushPromises();

    expect(mockFetchDispatchDetail).toHaveBeenCalledWith(
      "dispatch-aaaa-bbbb-cccc-dddd",
    );
    expect(w.text()).toContain("kick off");
    expect(w.text()).toContain("working on it");
  });

  it("does not call followDispatch for completed dispatches", async () => {
    mockFetchDispatchDetail.mockResolvedValueOnce({
      dispatch: makeDispatch({ status: "completed" }),
      timeline: [],
      totals: null,
    });

    mount(DispatchDetail, {
      props: { dispatch: makeDispatch({ status: "completed" }) },
    });
    await flushPromises();
    expect(mockFollowDispatch).not.toHaveBeenCalled();
  });

  it("calls followDispatch for running dispatches and appends streamed blocks", async () => {
    mockFetchDispatchDetail.mockResolvedValueOnce({
      dispatch: makeDispatch({ status: "running", completedAt: null }),
      timeline: [
        { type: "user", text: "initial", timestampMs: 1 },
      ] as JsonlBlock[],
      totals: null,
    });

    let onBlock: ((b: JsonlBlock) => void) | null = null;
    mockFollowDispatch.mockImplementationOnce(
      (_id: string, push: (b: JsonlBlock) => void) => {
        onBlock = push;
        return () => {};
      },
    );

    const w = mount(DispatchDetail, {
      props: { dispatch: makeDispatch({ status: "running", completedAt: null }) },
    });
    await flushPromises();

    expect(mockFollowDispatch).toHaveBeenCalledTimes(1);
    expect(w.text()).toContain("initial");

    // simulate a streamed block arriving
    onBlock!({ type: "assistant_text", text: "live update", timestampMs: 99 });
    await flushPromises();
    expect(w.text()).toContain("live update");
  });

  it("computes top-tools across the timeline including nested sub-agent tool calls", async () => {
    const subagentToolUse: ToolUseBlock = {
      type: "tool_use",
      id: "toolu_child_1",
      name: "Grep",
      input: {},
      timestampMs: 50,
    };

    const parentReadCalls: JsonlBlock[] = Array.from({ length: 3 }).map(
      (_, i) => ({
        type: "tool_use",
        id: `toolu_read_${i}`,
        name: "Read",
        input: {},
        timestampMs: 100 + i,
      }),
    );

    const parentBashCall: ToolUseBlock = {
      type: "tool_use",
      id: "toolu_bash_1",
      name: "Bash",
      input: {},
      timestampMs: 200,
    };

    const parentAgentCall: ToolUseBlock = {
      type: "tool_use",
      id: "toolu_agent_1",
      name: "Agent",
      input: {},
      timestampMs: 300,
      subagent: {
        agentType: "test-reviewer",
        description: "audit",
        sessionId: null,
        blocks: [
          subagentToolUse,
          { ...subagentToolUse, id: "toolu_child_2" },
          // a child Read so it merges into the parent Read total
          {
            type: "tool_use",
            id: "toolu_child_3",
            name: "Read",
            input: {},
            timestampMs: 60,
          },
        ],
        totals: {
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          cacheWrite: 0,
          tokensTotal: 0,
          toolCallCount: 3,
          subagentCount: 0,
        },
      },
    };

    mockFetchDispatchDetail.mockResolvedValueOnce({
      dispatch: makeDispatch(),
      timeline: [...parentReadCalls, parentBashCall, parentAgentCall],
      totals: null,
    });

    const w = mount(DispatchDetail, { props: { dispatch: makeDispatch() } });
    await flushPromises();

    // Top tools panel should contain the aggregated counts.
    // Read = 3 parent + 1 child = 4
    // Agent = 1 (subagent wrapper itself counts as a parent tool_use)
    // Grep = 2 (both child Greps)
    // Bash = 1
    expect(w.html()).toContain("Top tools");
    const text = w.text();
    expect(text).toMatch(/Read\s*4/);
    expect(text).toMatch(/Grep\s*2/);
    expect(text).toMatch(/Bash\s*1/);
    expect(text).toMatch(/Agent\s*1/);
  });

  it("emits close when the backdrop is clicked", async () => {
    mockFetchDispatchDetail.mockResolvedValueOnce({
      dispatch: makeDispatch(),
      timeline: [],
      totals: null,
    });
    const w = mount(DispatchDetail, { props: { dispatch: makeDispatch() } });
    await flushPromises();

    await w.get('[data-test="backdrop"]').trigger("click");
    expect(w.emitted("close")).toBeTruthy();
  });

  it("re-loads detail when the dispatch prop id changes", async () => {
    mockFetchDispatchDetail.mockResolvedValue({
      dispatch: makeDispatch(),
      timeline: [],
      totals: null,
    });

    const w = mount(DispatchDetail, {
      props: { dispatch: makeDispatch({ id: "first" }) },
    });
    await flushPromises();
    expect(mockFetchDispatchDetail).toHaveBeenCalledWith("first");

    await w.setProps({ dispatch: makeDispatch({ id: "second" }) });
    await flushPromises();
    expect(mockFetchDispatchDetail).toHaveBeenCalledWith("second");
  });
});
