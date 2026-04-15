import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mapEntryToEvents,
  truncateToolResultContent,
  createLaravelForwarder,
  deriveEventsUrl,
} from "./laravel-forwarder.js";
import type { AgentLogEntry } from "../types.js";

// --- Fixtures ---

function systemInitEntry(): AgentLogEntry {
  return {
    timestamp: 1000,
    type: "system",
    subtype: "init",
    summary: "Session initialized: claude-sonnet-4-5",
    data: {
      session_id: "sess-123",
      model: "claude-sonnet-4-5-20250929",
      tools: ["Read", "Grep", "Bash"],
      delta_ms: 0,
    },
  };
}

function assistantEntry(): AgentLogEntry {
  return {
    timestamp: 2000,
    type: "assistant",
    summary: "Tools: Read(/path)",
    data: {
      content: [
        { type: "text", text: "I'll read the file." },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Read",
          input: { file_path: "/src/main.ts" },
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
      delta_ms: 1000,
      raw: {},
    },
  };
}

function toolResultEntry(): AgentLogEntry {
  return {
    timestamp: 3000,
    type: "user",
    summary: "Tool results: toolu_01",
    data: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "File contents here...",
          is_error: false,
        },
      ],
      delta_ms: 1000,
      raw: {},
    },
  };
}

// --- Tests ---

describe("deriveEventsUrl", () => {
  it("replaces /status at the end with /events", () => {
    expect(deriveEventsUrl("http://example.com/api/jobs/123/status")).toBe(
      "http://example.com/api/jobs/123/events",
    );
  });

  it("only replaces trailing /status", () => {
    expect(deriveEventsUrl("http://example.com/status/jobs/123/status")).toBe(
      "http://example.com/status/jobs/123/events",
    );
  });

  it("leaves URL unchanged when it does not end with /status", () => {
    const url = "http://example.com/api/jobs/123";
    expect(deriveEventsUrl(url)).toBe(url);
  });
});

describe("truncateToolResultContent", () => {
  it("passes through short content unchanged", () => {
    expect(truncateToolResultContent("short")).toBe("short");
  });

  it("truncates content exceeding 10KB", () => {
    const long = "x".repeat(20_000);
    const result = truncateToolResultContent(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("truncated from 20000 bytes");
  });

  it("JSON-stringifies non-string content", () => {
    const result = truncateToolResultContent({ key: "value" });
    expect(result).toBe('{"key":"value"}');
  });
});

describe("mapEntryToEvents", () => {
  it("maps system init to session_init event", () => {
    const events = mapEntryToEvents(systemInitEntry());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_init");
    expect(events[0].data?.session_id).toBe("sess-123");
    expect(events[0].data?.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("maps assistant text blocks to agent_event events", () => {
    const events = mapEntryToEvents(assistantEntry());
    const textEvents = events.filter((e) => e.type === "agent_event");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].message).toBe("I'll read the file.");
  });

  it("attaches usage to the first agent_event per assistant turn", () => {
    const events = mapEntryToEvents(assistantEntry());
    const textEvents = events.filter((e) => e.type === "agent_event");
    expect(textEvents[0].data?.usage).toEqual({
      input_tokens: 500,
      output_tokens: 100,
    });
  });

  it("does not attach usage to agent_event when entry has no usage", () => {
    const entry = assistantEntry();
    delete (entry.data as Record<string, unknown>).usage;
    const events = mapEntryToEvents(entry);
    const textEvents = events.filter((e) => e.type === "agent_event");
    expect(textEvents[0].data).toBeUndefined();
  });

  it("attaches usage to first tool_call when no text blocks exist", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "Tools: Read",
      data: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/x" },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
        delta_ms: 0,
        raw: {},
      },
    };
    const events = mapEntryToEvents(entry);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].data?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    });
  });

  it("attaches usage only to the first text block in multi-text entries", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "text",
      data: {
        content: [
          { type: "text", text: "First block" },
          { type: "text", text: "Second block" },
        ],
        usage: { input_tokens: 200, output_tokens: 80 },
        delta_ms: 0,
        raw: {},
      },
    };
    const events = mapEntryToEvents(entry);
    const textEvents = events.filter((e) => e.type === "agent_event");
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].data?.usage).toEqual({
      input_tokens: 200,
      output_tokens: 80,
    });
    expect(textEvents[1].data).toBeUndefined();
  });

  it("maps assistant tool_use blocks to tool_call events", () => {
    const events = mapEntryToEvents(assistantEntry());
    const toolEvents = events.filter((e) => e.type === "tool_call");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].message).toBe("Read");
    expect(toolEvents[0].data?.tool_use_id).toBe("toolu_01");
  });

  it("maps user tool_result to tool_result events", () => {
    const events = mapEntryToEvents(toolResultEntry());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_result");
    expect(events[0].data?.tool_use_id).toBe("toolu_01");
    expect(events[0].data?.content).toBe("File contents here...");
  });

  it("forwards full usage object including cache tokens", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "text",
      data: {
        content: [{ type: "text", text: "Hello" }],
        usage: {
          input_tokens: 10,
          output_tokens: 200,
          cache_read_input_tokens: 50000,
          cache_creation_input_tokens: 3000,
          service_tier: "standard",
          speed: "standard",
        },
        delta_ms: 0,
        raw: {},
      },
    };
    const events = mapEntryToEvents(entry);
    const agentEvent = events.find((e) => e.type === "agent_event");
    expect(agentEvent?.data?.usage).toEqual({
      input_tokens: 10,
      output_tokens: 200,
      cache_read_input_tokens: 50000,
      cache_creation_input_tokens: 3000,
      service_tier: "standard",
      speed: "standard",
    });
  });

  it("produces zero events for result entries (not present in JSONL)", () => {
    const entry: AgentLogEntry = {
      timestamp: 4000,
      type: "result",
      subtype: "success",
      summary: "success",
      data: { delta_ms: 0 },
    };
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("returns empty array for unknown entry types", () => {
    const entry: AgentLogEntry = {
      timestamp: 1000,
      type: "unknown",
      summary: "unknown",
      data: { delta_ms: 0 },
    };
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("skips non-init system entries", () => {
    const entry: AgentLogEntry = {
      timestamp: 1000,
      type: "system",
      subtype: "turn_duration",
      summary: "turn",
      data: { delta_ms: 0 },
    };
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("produces multiple events from an assistant with text + tool_use", () => {
    const events = mapEntryToEvents(assistantEntry());
    expect(events).toHaveLength(2); // 1 text + 1 tool_use
  });

  it("maps tool_result with is_error: true", () => {
    const entry: AgentLogEntry = {
      timestamp: 3000,
      type: "user",
      summary: "Tool results: toolu_01",
      data: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01",
            content: "Permission denied",
            is_error: true,
          },
        ],
        delta_ms: 0,
        raw: {},
      },
    };
    const events = mapEntryToEvents(entry);
    expect(events[0].data?.is_error).toBe(true);
  });

  it("produces zero events for user entry with non-tool_result blocks", () => {
    const entry: AgentLogEntry = {
      timestamp: 3000,
      type: "user",
      summary: "text",
      data: { content: [{ type: "text", text: "hello" }], delta_ms: 0 },
    };
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("produces zero events for assistant with empty content", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "",
      data: { content: [], delta_ms: 0, raw: {} },
    };
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("produces zero events for assistant with undefined content", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "",
      data: { delta_ms: 0, raw: {} },
    };
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("skips text block with empty text", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "",
      data: { content: [{ type: "text", text: "" }], delta_ms: 0, raw: {} },
    };
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("skips tool_use block with missing name", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "",
      data: {
        content: [{ type: "tool_use", id: "t1", input: {} }],
        delta_ms: 0,
        raw: {},
      },
    };
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("maps thinking-only assistant entry to thinking event with usage", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "Thinking...",
      data: {
        content: [
          { type: "thinking", thinking: "Let me analyze this problem." },
        ],
        usage: {
          input_tokens: 500,
          output_tokens: 0,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 2000,
        },
        delta_ms: 0,
        raw: {},
      },
    };
    const events = mapEntryToEvents(entry);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("thinking");
    expect(events[0].data?.usage).toEqual({
      input_tokens: 500,
      output_tokens: 0,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 2000,
    });
    expect(events[0].message).toBeUndefined();
  });

  it("does not emit thinking event when text or tool_use blocks exist", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "text",
      data: {
        content: [
          { type: "thinking", thinking: "Hmm..." },
          { type: "text", text: "Here is my answer." },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
        delta_ms: 0,
        raw: {},
      },
    };
    const events = mapEntryToEvents(entry);
    const thinkingEvents = events.filter((e) => e.type === "thinking");
    expect(thinkingEvents).toHaveLength(0);
    const agentEvents = events.filter((e) => e.type === "agent_event");
    expect(agentEvents).toHaveLength(1);
    expect(agentEvents[0].data?.usage).toBeDefined();
  });

  it("does not emit thinking event when there is no usage", () => {
    const entry: AgentLogEntry = {
      timestamp: 2000,
      type: "assistant",
      summary: "Thinking...",
      data: {
        content: [{ type: "thinking", thinking: "Let me think..." }],
        delta_ms: 0,
        raw: {},
      },
    };
    const events = mapEntryToEvents(entry);
    expect(events).toHaveLength(0);
  });
});

describe("createLaravelForwarder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("batches events and flushes on size threshold", async () => {
    const { consumer, flush } = createLaravelForwarder({
      eventsUrl: "https://example.com/events",
      apiToken: "test-token",
      jobId: "job-1",
    });

    // Push 10 assistant entries (each produces 2 events = 20 events total)
    // Should auto-flush at 10
    for (let i = 0; i < 5; i++) {
      consumer(assistantEntry());
    }

    // The first batch of 10 events should have been POSTed
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.events).toHaveLength(10);

    flush();
  });

  it("PUTs session_id to status URL when session_init is seen", () => {
    const { consumer, flush } = createLaravelForwarder({
      eventsUrl: "https://example.com/events",
      apiToken: "test-token",
      jobId: "job-1",
      statusUrl: "https://example.com/status",
    });

    consumer(systemInitEntry());

    // Should have called fetch for the PUT session_id
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/status",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("sess-123"),
      }),
    );
    flush();
  });

  it("flush() sends remaining buffered events", () => {
    const { consumer, flush } = createLaravelForwarder({
      eventsUrl: "https://example.com/events",
      apiToken: "test-token",
      jobId: "job-1",
    });

    consumer(toolResultEntry()); // 1 event — below threshold
    expect(fetch).not.toHaveBeenCalled();

    flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not POST when buffer is empty", () => {
    const { flush } = createLaravelForwarder({
      eventsUrl: "https://example.com/events",
      apiToken: "test-token",
      jobId: "job-1",
    });

    flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("timer-based flush fires after interval", () => {
    vi.useFakeTimers();
    const { consumer } = createLaravelForwarder({
      eventsUrl: "https://example.com/events",
      apiToken: "test-token",
      jobId: "job-1",
    });

    consumer(toolResultEntry()); // 1 event — below threshold
    expect(fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not double-POST when flush is called before timer", () => {
    vi.useFakeTimers();
    const { consumer, flush } = createLaravelForwarder({
      eventsUrl: "https://example.com/events",
      apiToken: "test-token",
      jobId: "job-1",
    });

    consumer(toolResultEntry());
    flush(); // manual flush
    vi.advanceTimersByTime(5_000); // timer should be cleared
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("includes correct auth headers", () => {
    const { consumer, flush } = createLaravelForwarder({
      eventsUrl: "https://example.com/events",
      apiToken: "my-secret-token",
      jobId: "job-1",
    });

    consumer(toolResultEntry());
    flush();

    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/events",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my-secret-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("handles HTTP errors gracefully", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const { consumer, flush } = createLaravelForwarder({
      eventsUrl: "https://example.com/events",
      apiToken: "test-token",
      jobId: "job-1",
    });

    consumer(toolResultEntry());
    expect(() => flush()).not.toThrow();
  });

  it("handles network errors gracefully", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const { consumer, flush } = createLaravelForwarder({
      eventsUrl: "https://example.com/events",
      apiToken: "test-token",
      jobId: "job-1",
    });

    consumer(toolResultEntry());
    expect(() => flush()).not.toThrow();
  });
});
