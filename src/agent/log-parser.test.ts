import { describe, it, expect } from "vitest";
import { parseAgentLog, buildRouterEntry, buildParsedAgentLog, mergeHeartbeatSnapshots, buildFullParsedLog } from "./log-parser.js";
import type { AgentLogEntry, TimestampedHeartbeatSnapshot, ComplexityLevel } from "../types.js";

// --- Test fixtures ---

function systemInitEntry(overrides: Partial<AgentLogEntry["data"]> = {}): AgentLogEntry {
  return {
    timestamp: 1000,
    type: "system",
    subtype: "init",
    summary: "Session initialized: claude-sonnet-4-5",
    data: {
      session_id: "sess-123",
      model: "claude-sonnet-4-5-20250929",
      tools: ["Read", "Grep", "Glob", "Bash"],
      delta_ms: 0,
      raw: {},
      ...overrides,
    },
  };
}

function assistantEntry(overrides: Partial<AgentLogEntry["data"]> = {}): AgentLogEntry {
  return {
    timestamp: 2000,
    type: "assistant",
    summary: "Tools: Read(/path/to/file.ts)",
    data: {
      content: [
        {
          type: "thinking",
          thinking: "Let me look at this file to understand the structure.",
          signature: "EroCCkYICxgCKkDn8l90...",
        },
        {
          type: "text",
          text: "I'll read the file to understand the implementation.",
        },
        {
          type: "tool_use",
          id: "toolu_01ABC",
          name: "Read",
          input: { file_path: "/path/to/file.ts" },
        },
      ],
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3000,
      },
      delta_ms: 1000,
      raw: {
        message: {
          model: "claude-sonnet-4-5-20250929",
        },
      },
      ...overrides,
    },
  };
}

function toolResultEntry(overrides: Partial<AgentLogEntry["data"]> = {}): AgentLogEntry {
  return {
    timestamp: 3000,
    type: "user",
    summary: "Tool results: toolu_01ABC",
    data: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01ABC",
          content: "export function hello() { return 'world'; }",
          is_error: false,
        },
      ],
      delta_ms: 500,
      raw: {},
      ...overrides,
    },
  };
}

function toolProgressEntry(): AgentLogEntry {
  return {
    timestamp: 2500,
    type: "tool_progress",
    summary: "Bash running (5s)",
    data: {
      tool_name: "Bash",
      elapsed_time_seconds: 5,
      delta_ms: 200,
      raw: {},
    },
  };
}

function resultEntry(overrides: Partial<AgentLogEntry["data"]> = {}): AgentLogEntry {
  return {
    timestamp: 5000,
    type: "result",
    subtype: "success",
    summary: "success: 3 turns, $0.0150, 4500ms (api: 3000ms)",
    data: {
      subtype: "success",
      result_text: "The answer is 42.",
      total_cost_usd: 0.015,
      num_turns: 3,
      duration_ms: 4500,
      duration_api_ms: 3000,
      is_error: false,
      errors: null,
      delta_ms: 2000,
      raw: {},
      ...overrides,
    },
  };
}

function errorEntry(): AgentLogEntry {
  return {
    timestamp: 4000,
    type: "error",
    summary: "Process error: Agent crashed",
    data: {
      error: "Agent crashed",
      stderr: "Error: something went wrong\n  at foo.ts:10",
      delta_ms: 100,
      raw: null,
    },
  };
}

// --- Tests ---

describe("parseAgentLog", () => {
  it("returns empty array for null/undefined input", () => {
    expect(parseAgentLog(null as unknown as AgentLogEntry[])).toEqual([]);
    expect(parseAgentLog(undefined as unknown as AgentLogEntry[])).toEqual([]);
    expect(parseAgentLog([])).toEqual([]);
  });

  it("parses system:init entries", () => {
    const result = parseAgentLog([systemInitEntry()]);
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.type).toBe("system_init");
    if (entry.type !== "system_init") throw new Error("wrong type");
    expect(entry.sessionId).toBe("sess-123");
    expect(entry.model).toBe("claude-sonnet-4-5-20250929");
    expect(entry.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(entry.timestamp).toBe(1000);
    expect(entry.deltaMs).toBe(0);
  });

  it("parses assistant entries with thinking, text, and tool calls", () => {
    const result = parseAgentLog([assistantEntry()]);
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.type).toBe("assistant");
    if (entry.type !== "assistant") throw new Error("wrong type");
    expect(entry.thinking).toBe("Let me look at this file to understand the structure.");
    expect(entry.text).toBe("I'll read the file to understand the implementation.");
    expect(entry.toolCalls).toHaveLength(1);
    expect(entry.toolCalls[0].id).toBe("toolu_01ABC");
    expect(entry.toolCalls[0].name).toBe("Read");
    expect(entry.toolCalls[0].inputSummary).toBe("/path/to/file.ts");
    expect(entry.model).toBe("claude-sonnet-4-5-20250929");
    expect(entry.usage).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 3000,
      cacheWriteTokens: 200,
    });
    expect(entry.deltaMs).toBe(1000);
  });

  it("handles assistant entries with no thinking block", () => {
    const entry = assistantEntry({
      content: [
        { type: "text", text: "Here is the answer." },
      ],
    });
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "assistant") throw new Error("wrong type");
    expect(parsed.thinking).toBeNull();
    expect(parsed.text).toBe("Here is the answer.");
    expect(parsed.toolCalls).toHaveLength(0);
  });

  it("strips signatures from thinking blocks", () => {
    const result = parseAgentLog([assistantEntry()]);
    const entry = result[0];
    if (entry.type !== "assistant") throw new Error("wrong type");
    // The signature should NOT appear in the parsed output
    expect(entry.thinking).not.toContain("EroCCkYICxgCKkDn8l90");
  });

  it("parses tool result (user) entries", () => {
    const result = parseAgentLog([toolResultEntry()]);
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.type).toBe("tool_result");
    if (entry.type !== "tool_result") throw new Error("wrong type");
    expect(entry.results).toHaveLength(1);
    expect(entry.results[0].toolUseId).toBe("toolu_01ABC");
    expect(entry.results[0].content).toBe("export function hello() { return 'world'; }");
    expect(entry.results[0].isError).toBe(false);
    expect(entry.deltaMs).toBe(500);
  });

  it("truncates long tool result content", () => {
    const longContent = "x".repeat(2000);
    const entry = toolResultEntry({
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: longContent, is_error: false },
      ],
    });
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "tool_result") throw new Error("wrong type");
    expect(parsed.results[0].content.length).toBeLessThanOrEqual(1000);
  });

  it("parses tool_progress entries", () => {
    const result = parseAgentLog([toolProgressEntry()]);
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.type).toBe("tool_progress");
    if (entry.type !== "tool_progress") throw new Error("wrong type");
    expect(entry.toolName).toBe("Bash");
    expect(entry.elapsedSeconds).toBe(5);
    expect(entry.deltaMs).toBe(200);
  });

  it("parses result entries", () => {
    const result = parseAgentLog([resultEntry()]);
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.type).toBe("result");
    if (entry.type !== "result") throw new Error("wrong type");
    expect(entry.subtype).toBe("success");
    expect(entry.resultText).toBe("The answer is 42.");
    expect(entry.totalCostUsd).toBe(0.015);
    expect(entry.numTurns).toBe(3);
    expect(entry.durationMs).toBe(4500);
    expect(entry.durationApiMs).toBe(3000);
    expect(entry.isError).toBe(false);
  });

  it("parses error entries", () => {
    const result = parseAgentLog([errorEntry()]);
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.type).toBe("error");
    if (entry.type !== "error") throw new Error("wrong type");
    expect(entry.message).toBe("Agent crashed");
    expect(entry.stderr).toBe("Error: something went wrong\n  at foo.ts:10");
    expect(entry.deltaMs).toBe(100);
  });

  it("parses a full conversation in order", () => {
    const entries: AgentLogEntry[] = [
      systemInitEntry(),
      assistantEntry(),
      toolResultEntry(),
      toolProgressEntry(),
      assistantEntry({
        content: [{ type: "text", text: "The answer is 42." }],
        usage: { input_tokens: 600, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
        delta_ms: 800,
        raw: { message: { model: "claude-sonnet-4-5-20250929" } },
      }),
      resultEntry(),
    ];
    const result = parseAgentLog(entries);
    expect(result).toHaveLength(6);
    expect(result.map((e) => e.type)).toEqual([
      "system_init",
      "assistant",
      "tool_result",
      "tool_progress",
      "assistant",
      "result",
    ]);
  });

  it("handles missing/malformed data gracefully", () => {
    const malformed: AgentLogEntry = {
      timestamp: 1000,
      type: "assistant",
      summary: "empty",
      data: { delta_ms: 0 },
    };
    const result = parseAgentLog([malformed]);
    expect(result).toHaveLength(1);
    const entry = result[0];
    if (entry.type !== "assistant") throw new Error("wrong type");
    expect(entry.thinking).toBeNull();
    expect(entry.text).toBeNull();
    expect(entry.toolCalls).toHaveLength(0);
    expect(entry.usage).toBeNull();
    expect(entry.model).toBeNull();
  });

  it("handles tool results with array content blocks", () => {
    const entry = toolResultEntry({
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: [
            { type: "text", text: "First chunk." },
            { type: "text", text: "Second chunk." },
          ],
          is_error: false,
        },
      ],
    });
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "tool_result") throw new Error("wrong type");
    expect(parsed.results[0].content).toBe("First chunk.\nSecond chunk.");
  });

  it("skips unknown entry types gracefully", () => {
    const unknown: AgentLogEntry = {
      timestamp: 1000,
      type: "unknown_type",
      summary: "something",
      data: { delta_ms: 0 },
    };
    const result = parseAgentLog([unknown]);
    expect(result).toHaveLength(0);
  });

  it("concatenates multiple text blocks with newlines", () => {
    const entry = assistantEntry({
      content: [
        { type: "text", text: "First paragraph." },
        { type: "text", text: "Second paragraph." },
        { type: "text", text: "Third paragraph." },
      ],
    });
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "assistant") throw new Error("wrong type");
    expect(parsed.text).toBe("First paragraph.\nSecond paragraph.\nThird paragraph.");
  });

  it("returns null usage when usage field is missing", () => {
    const entry = assistantEntry({
      content: [{ type: "text", text: "Hello" }],
      usage: undefined,
    });
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "assistant") throw new Error("wrong type");
    expect(parsed.usage).toBeNull();
  });

  it("returns null model when raw.message is missing", () => {
    const entry = assistantEntry({
      content: [{ type: "text", text: "Hello" }],
      raw: {},
    });
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "assistant") throw new Error("wrong type");
    expect(parsed.model).toBeNull();
  });

  it("handles tool result with isError flag", () => {
    const entry = toolResultEntry({
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: "Permission denied", is_error: true },
      ],
    });
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "tool_result") throw new Error("wrong type");
    expect(parsed.results[0].isError).toBe(true);
    expect(parsed.results[0].content).toBe("Permission denied");
  });

  it("returns null stderr when error has no stderr", () => {
    const entry: AgentLogEntry = {
      timestamp: 1000,
      type: "error",
      summary: "error",
      data: { error: "crash", delta_ms: 0, raw: null },
    };
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "error") throw new Error("wrong type");
    expect(parsed.stderr).toBeNull();
  });

  it("skips entries with null/undefined data", () => {
    const entry = { timestamp: 1000, type: "assistant", summary: "bad" } as AgentLogEntry;
    const result = parseAgentLog([entry]);
    expect(result).toHaveLength(0);
  });

  it("skips system entries with non-init subtype", () => {
    const entry: AgentLogEntry = {
      timestamp: 1000,
      type: "system",
      subtype: "other",
      summary: "something",
      data: { delta_ms: 0 },
    };
    const result = parseAgentLog([entry]);
    expect(result).toHaveLength(0);
  });

  it("includes costUsd on assistant entries with known model and usage", () => {
    const result = parseAgentLog([assistantEntry()]);
    const entry = result[0];
    if (entry.type !== "assistant") throw new Error("wrong type");
    // Model is claude-sonnet-4-5-20250929 with 500 in, 100 out, 200 cache write, 3000 cache read
    expect(entry.costUsd).toBeGreaterThan(0);
    expect(typeof entry.costUsd).toBe("number");
  });

  it("sets costUsd to 0 when model is unknown", () => {
    const entry = assistantEntry({
      raw: { message: { model: "unknown-model" } },
    });
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "assistant") throw new Error("wrong type");
    expect(parsed.costUsd).toBe(0);
  });

  it("sets costUsd to 0 when usage or model is missing", () => {
    const entry = assistantEntry({
      content: [{ type: "text", text: "Hello" }],
      usage: undefined,
      raw: {},
    });
    const result = parseAgentLog([entry]);
    const parsed = result[0];
    if (parsed.type !== "assistant") throw new Error("wrong type");
    expect(parsed.costUsd).toBe(0);
  });
});

describe("buildRouterEntry", () => {
  it("builds a ParsedRouter from router fields", () => {
    const result = buildRouterEntry({
      routerResponse: "Looking into it!",
      routerNeedsAgent: true,
      routerComplexity: "medium",
      routerRequest: null,
      routerRawResponse: {
        usage: { input_tokens: 500, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 300 },
        content: [{ type: "text", text: '{"quickResponse":"Looking into it!","needsAgent":true,"complexity":"medium","reason":"Needs codebase exploration"}' }],
      },
      routerResponseAt: 1000,
      apiCalls: [{
        source: "router" as const,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 500,
        outputTokens: 80,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 300,
        costUsd: 0.00074,
        timestamp: 1000,
      }],
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");
    expect(result.type).toBe("router");
    expect(result.quickResponse).toBe("Looking into it!");
    expect(result.needsAgent).toBe(true);
    expect(result.complexity).toBe("medium");
    expect(result.costUsd).toBeCloseTo(0.00074, 5);
  });

  it("extracts reason from router raw response content", () => {
    const result = buildRouterEntry({
      routerResponse: "Hi!",
      routerNeedsAgent: false,
      routerComplexity: "very_low",
      routerRequest: null,
      routerRawResponse: {
        content: [{ type: "text", text: '{"quickResponse":"Hi!","needsAgent":false,"complexity":"very_low","reason":"Simple greeting"}' }],
      },
      routerResponseAt: 1000,
      apiCalls: null,
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");
    expect(result.reason).toBe("Simple greeting");
  });

  it("returns null when routerResponse is missing", () => {
    const result = buildRouterEntry({
      routerResponse: null,
      routerNeedsAgent: null,
      routerComplexity: null,
      routerRequest: null,
      routerRawResponse: null,
      routerResponseAt: null,
      apiCalls: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when routerResponseAt is missing", () => {
    const result = buildRouterEntry({
      routerResponse: "Hello",
      routerNeedsAgent: false,
      routerComplexity: "very_low",
      routerRequest: null,
      routerRawResponse: null,
      routerResponseAt: null,
      apiCalls: null,
    });
    expect(result).toBeNull();
  });

  it("handles missing apiCalls gracefully", () => {
    const result = buildRouterEntry({
      routerResponse: "Looking into it!",
      routerNeedsAgent: true,
      routerComplexity: "high",
      routerRequest: null,
      routerRawResponse: {},
      routerResponseAt: 2000,
      apiCalls: null,
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");
    expect(result.costUsd).toBe(0);
    expect(result.usage).toBeNull();
  });

  it("handles malformed JSON in raw response content", () => {
    const result = buildRouterEntry({
      routerResponse: "Hello!",
      routerNeedsAgent: false,
      routerComplexity: "very_low",
      routerRequest: null,
      routerRawResponse: {
        content: [{ type: "text", text: "not valid json {{{" }],
      },
      routerResponseAt: 1000,
      apiCalls: null,
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");
    expect(result.reason).toBe("");
  });

  it("handles raw response with no text blocks", () => {
    const result = buildRouterEntry({
      routerResponse: "Hello!",
      routerNeedsAgent: false,
      routerComplexity: "very_low",
      routerRequest: null,
      routerRawResponse: {
        content: [{ type: "image", source: {} }],
      },
      routerResponseAt: 1000,
      apiCalls: null,
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");
    expect(result.reason).toBe("");
  });

  it("defaults needsAgent to false and complexity to very_low when null", () => {
    const result = buildRouterEntry({
      routerResponse: "Hi!",
      routerNeedsAgent: null,
      routerComplexity: null,
      routerRequest: null,
      routerRawResponse: null,
      routerResponseAt: 1000,
      apiCalls: null,
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");
    expect(result.needsAgent).toBe(false);
    expect(result.complexity).toBe("very_low");
  });

  it("maps usage tokens correctly from ApiCallUsage", () => {
    const result = buildRouterEntry({
      routerResponse: "Looking into it!",
      routerNeedsAgent: true,
      routerComplexity: "medium",
      routerRequest: null,
      routerRawResponse: {},
      routerResponseAt: 1000,
      apiCalls: [{
        source: "router" as const,
        model: "claude-haiku-4-5-20251001",
        inputTokens: 500,
        outputTokens: 80,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 300,
        costUsd: 0.001,
        timestamp: 1000,
      }],
    });
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");
    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 80,
      cacheWriteTokens: 100,
      cacheReadTokens: 300,
    });
  });
});

describe("buildParsedAgentLog", () => {
  it("returns null for null/undefined agentLog", () => {
    expect(buildParsedAgentLog(null, {
      routerResponse: "Hi",
      routerNeedsAgent: false,
      routerComplexity: "very_low",
      routerRequest: null,
      routerRawResponse: null,
      routerResponseAt: 1000,
      apiCalls: null,
    })).toBeNull();
  });

  it("prepends router entry when router data is available", () => {
    const agentLog: AgentLogEntry[] = [systemInitEntry()];
    const result = buildParsedAgentLog(agentLog, {
      routerResponse: "Looking into it!",
      routerNeedsAgent: true,
      routerComplexity: "medium",
      routerRequest: null,
      routerRawResponse: {},
      routerResponseAt: 1000,
      apiCalls: null,
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].type).toBe("router");
    expect(result![1].type).toBe("system_init");
  });

  it("does not prepend router entry when router data is missing", () => {
    const agentLog: AgentLogEntry[] = [systemInitEntry()];
    const result = buildParsedAgentLog(agentLog, {
      routerResponse: null,
      routerNeedsAgent: null,
      routerComplexity: null,
      routerRequest: null,
      routerRawResponse: null,
      routerResponseAt: null,
      apiCalls: null,
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].type).toBe("system_init");
  });
});

describe("mergeHeartbeatSnapshots", () => {
  const snapshot = (ts: number, text: string): TimestampedHeartbeatSnapshot => ({
    timestamp: ts,
    activitySummary: `summary at ${ts}`,
    update: { emoji: ":mag:", color: "#3498db", text, stop: false },
  });

  it("returns original entries when snapshots is empty", () => {
    const entries = parseAgentLog([systemInitEntry(), assistantEntry()]);
    const result = mergeHeartbeatSnapshots(entries, []);
    expect(result).toEqual(entries);
  });

  it("returns original entries when snapshots is null", () => {
    const entries = parseAgentLog([systemInitEntry()]);
    const result = mergeHeartbeatSnapshots(entries, null);
    expect(result).toEqual(entries);
  });

  it("inserts heartbeat entries chronologically between agent entries", () => {
    const entries = parseAgentLog([
      { ...systemInitEntry(), timestamp: 1000 },
      { ...assistantEntry(), timestamp: 3000 },
      { ...resultEntry(), timestamp: 5000 },
    ]);
    const snapshots = [snapshot(2000, "Searching..."), snapshot(4000, "Still working...")];
    const result = mergeHeartbeatSnapshots(entries, snapshots);

    expect(result).toHaveLength(5);
    expect(result.map(e => e.type)).toEqual([
      "system_init",
      "heartbeat",
      "assistant",
      "heartbeat",
      "result",
    ]);
  });

  it("produces ParsedHeartbeat entries with correct fields", () => {
    const entries = parseAgentLog([systemInitEntry()]);
    const snapshots = [snapshot(2000, "Looking around...")];
    const result = mergeHeartbeatSnapshots(entries, snapshots);

    const hb = result.find(e => e.type === "heartbeat");
    expect(hb).toBeDefined();
    if (hb?.type !== "heartbeat") throw new Error("wrong type");
    expect(hb.timestamp).toBe(2000);
    expect(hb.emoji).toBe(":mag:");
    expect(hb.color).toBe("#3498db");
    expect(hb.text).toBe("Looking around...");
    expect(hb.activitySummary).toBe("summary at 2000");
  });

  it("appends heartbeats after all entries when timestamps are later", () => {
    const entries = parseAgentLog([{ ...systemInitEntry(), timestamp: 1000 }]);
    const snapshots = [snapshot(5000, "Late heartbeat")];
    const result = mergeHeartbeatSnapshots(entries, snapshots);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("system_init");
    expect(result[1].type).toBe("heartbeat");
  });
});

describe("buildFullParsedLog", () => {
  const snapshot = (ts: number, text: string): TimestampedHeartbeatSnapshot => ({
    timestamp: ts,
    activitySummary: `summary at ${ts}`,
    update: { emoji: ":mag:", color: "#3498db", text, stop: false },
  });

  const routerInput = {
    routerResponse: null,
    routerNeedsAgent: null,
    routerComplexity: null as ComplexityLevel | null,
    routerRequest: null,
    routerRawResponse: null,
    routerResponseAt: null,
    apiCalls: null,
  };

  it("returns null when agentLog is null", () => {
    expect(buildFullParsedLog(null, routerInput, null)).toBeNull();
  });

  it("merges heartbeat snapshots into parsed log", () => {
    const agentLog: AgentLogEntry[] = [
      { ...systemInitEntry(), timestamp: 1000 },
      { ...assistantEntry(), timestamp: 3000 },
    ];
    const snapshots = [snapshot(2000, "Working...")];
    const result = buildFullParsedLog(agentLog, routerInput, snapshots);

    expect(result).not.toBeNull();
    expect(result!.map(e => e.type)).toEqual(["system_init", "heartbeat", "assistant"]);
  });

  it("works with null heartbeat snapshots", () => {
    const agentLog: AgentLogEntry[] = [systemInitEntry()];
    const result = buildFullParsedLog(agentLog, routerInput, null);

    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
    expect(result![0].type).toBe("system_init");
  });
});
