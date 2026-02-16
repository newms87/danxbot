import { describe, it, expect } from "vitest";
import { computePerfStats } from "./perf-stats.js";
import type { MessageEvent } from "./events.js";
import type { AgentLogEntry } from "../types.js";

function makeEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    id: "t1-m1",
    threadTs: "t1",
    messageTs: "m1",
    channelId: "C1",
    user: "U1",
    userName: null,
    text: "hello",
    receivedAt: 1000,
    routerResponseAt: null,
    routerResponse: null,
    routerNeedsAgent: null,
    routerComplexity: null,
    agentResponseAt: null,
    agentResponse: null,
    subscriptionCostUsd: null,
    agentTurns: null,
    apiCalls: null,
    apiCostUsd: null,
    agentUsage: null,
    status: "complete",
    error: null,
    routerRequest: null,
    routerRawResponse: null,
    agentConfig: null,
    agentLog: null,
    parsedAgentLog: null,
    agentRetried: false,
    sqlQueriesProcessed: null,
    feedback: null,
    responseTs: null,
    ...overrides,
  };
}

function makeResultEntry(duration_ms: number, duration_api_ms: number): AgentLogEntry {
  return {
    timestamp: Date.now(),
    type: "result",
    summary: "done",
    data: { duration_ms, duration_api_ms },
  };
}

function makeToolUseEntry(name: string): AgentLogEntry {
  return {
    timestamp: Date.now(),
    type: "assistant",
    summary: "tool use",
    data: { content: [{ type: "tool_use", name }] },
  };
}

describe("computePerfStats", () => {
  it("returns empty stats when agentLog is null", () => {
    const ev = makeEvent({ agentLog: null });
    const stats = computePerfStats(ev);
    expect(stats.wallTimeMs).toBe(0);
    expect(stats.apiTimeMs).toBe(0);
    expect(stats.totalToolCalls).toBe(0);
  });

  it("returns empty stats when agentLog is empty", () => {
    const ev = makeEvent({ agentLog: [] });
    const stats = computePerfStats(ev);
    expect(stats.wallTimeMs).toBe(0);
    expect(stats.apiTimeMs).toBe(0);
  });

  it("computes wallTimeMs from listener timestamps (agentResponseAt - routerResponseAt)", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 18800,
      agentLog: [makeResultEntry(13100, 23200)],
    });
    const stats = computePerfStats(ev);
    // Wall time should be 18800 - 2000 = 16800ms, NOT the SDK's 13100ms
    expect(stats.wallTimeMs).toBe(16800);
  });

  it("falls back to receivedAt when routerResponseAt is null", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: null,
      agentResponseAt: 18000,
      agentLog: [makeResultEntry(13100, 23200)],
    });
    const stats = computePerfStats(ev);
    // Wall time should be 18000 - 1000 = 17000ms
    expect(stats.wallTimeMs).toBe(17000);
  });

  it("returns wallTimeMs 0 when agentResponseAt is null", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: null,
      agentLog: [makeResultEntry(13100, 23200)],
    });
    const stats = computePerfStats(ev);
    expect(stats.wallTimeMs).toBe(0);
  });

  it("reads apiTimeMs from SDK result entry", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 18800,
      agentLog: [makeResultEntry(13100, 23200)],
    });
    const stats = computePerfStats(ev);
    expect(stats.apiTimeMs).toBe(23200);
  });

  it("handles apiTimeMs > wallTimeMs gracefully (no negative tool time)", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 15000, // wall = 13000
      agentLog: [makeResultEntry(13100, 23200)], // api = 23200 > wall 13000
    });
    const stats = computePerfStats(ev);
    // toolTimeMs should be clamped to 0, not negative
    expect(stats.toolTimeMs).toBe(0);
  });

  it("computes toolTimeMs as wallTimeMs - apiTimeMs when positive", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 22000, // wall = 20000
      agentLog: [makeResultEntry(20000, 8000)], // api = 8000
    });
    const stats = computePerfStats(ev);
    expect(stats.toolTimeMs).toBe(12000); // 20000 - 8000
  });

  it("counts tool calls from assistant entries", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 5000,
      agentLog: [
        makeToolUseEntry("Bash"),
        makeToolUseEntry("Read"),
        makeToolUseEntry("Bash"),
        makeResultEntry(3000, 1000),
      ],
    });
    const stats = computePerfStats(ev);
    expect(stats.totalToolCalls).toBe(3);
    expect(stats.toolBreakdown).toEqual({ Bash: 2, Read: 1 });
  });

  it("tracks longestTool from tool_progress entries", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 10000,
      agentLog: [
        {
          timestamp: Date.now(),
          type: "tool_progress",
          summary: "Bash running (3s)",
          data: { tool_name: "Bash", elapsed_time_seconds: 3 },
        },
        {
          timestamp: Date.now(),
          type: "tool_progress",
          summary: "Read running (7s)",
          data: { tool_name: "Read", elapsed_time_seconds: 7 },
        },
        {
          timestamp: Date.now(),
          type: "tool_progress",
          summary: "Bash running (2s)",
          data: { tool_name: "Bash", elapsed_time_seconds: 2 },
        },
        makeResultEntry(8000, 5000),
      ],
    });
    const stats = computePerfStats(ev);
    expect(stats.longestTool).toEqual({ name: "Read", seconds: 7 });
  });

  it("returns apiTimeMs 0 when no result entry in log", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 5000,
      agentLog: [makeToolUseEntry("Bash")],
    });
    const stats = computePerfStats(ev);
    expect(stats.apiTimeMs).toBe(0);
  });

  it("keys tool_use with missing name as unknown", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 5000,
      agentLog: [
        {
          timestamp: Date.now(),
          type: "assistant",
          summary: "tool use",
          data: { content: [{ type: "tool_use" }] },
        },
        makeResultEntry(3000, 1000),
      ],
    });
    const stats = computePerfStats(ev);
    expect(stats.totalToolCalls).toBe(1);
    expect(stats.toolBreakdown).toEqual({ unknown: 1 });
  });

  it("counts multiple tool_use blocks in a single assistant entry", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 5000,
      agentLog: [
        {
          timestamp: Date.now(),
          type: "assistant",
          summary: "tools",
          data: {
            content: [
              { type: "tool_use", name: "Bash" },
              { type: "tool_use", name: "Read" },
              { type: "text", text: "some output" },
            ],
          },
        },
        makeResultEntry(3000, 1000),
      ],
    });
    const stats = computePerfStats(ev);
    expect(stats.totalToolCalls).toBe(2);
    expect(stats.toolBreakdown).toEqual({ Bash: 1, Read: 1 });
  });

  it("returns toolTimeMs 0 when wallTimeMs equals apiTimeMs", () => {
    const ev = makeEvent({
      receivedAt: 1000,
      routerResponseAt: 2000,
      agentResponseAt: 7000, // wall = 5000
      agentLog: [makeResultEntry(5000, 5000)], // api = 5000 = wall
    });
    const stats = computePerfStats(ev);
    expect(stats.toolTimeMs).toBe(0);
  });
});
