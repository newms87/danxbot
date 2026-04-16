import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("./session-log-watcher.js", () => {
  return {
    SessionLogWatcher: class {
      onEntry = vi.fn();
      start = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn();
    },
  };
});

import {
  deriveEventsUrl,
  truncateToolResultContent,
  putSessionId,
  mapEntryToEvents,
  createLaravelForwarder,
  startEventForwarding,
} from "./laravel-forwarder.js";
import type { AgentLogEntry } from "../types.js";

// --- Helpers ---

function makeEntry(overrides: Partial<AgentLogEntry> = {}): AgentLogEntry {
  return {
    type: "assistant",
    timestamp: 1700000000000,
    summary: "test",
    data: {},
    ...overrides,
  };
}

function makeAssistantEntry(content: Record<string, unknown>[]): AgentLogEntry {
  return makeEntry({
    type: "assistant",
    data: { content, delta_ms: 0 },
  });
}

function makeToolResultEntry(results: Record<string, unknown>[]): AgentLogEntry {
  return makeEntry({
    type: "user",
    data: { content: results, delta_ms: 0 },
  });
}

function makeSystemInitEntry(sessionId: string): AgentLogEntry {
  return makeEntry({
    type: "system",
    subtype: "init",
    data: { session_id: sessionId, model: "claude-sonnet-4-5", tools: [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── deriveEventsUrl ───────────────────────────────────────────────────────

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

// ─── truncateToolResultContent ─────────────────────────────────────────────

describe("truncateToolResultContent", () => {
  it("returns content unchanged when under 10KB", () => {
    const small = "x".repeat(100);
    expect(truncateToolResultContent(small)).toBe(small);
  });

  it("truncates content over 10KB with marker", () => {
    const large = "x".repeat(11_000);
    const result = truncateToolResultContent(large);
    expect(result.length).toBeLessThan(large.length);
    expect(result).toContain("…[truncated]");
  });

  it("allows exactly 10KB without truncation", () => {
    const exact = "x".repeat(10 * 1024);
    expect(truncateToolResultContent(exact)).toBe(exact);
  });
});

// ─── putSessionId ─────────────────────────────────────────────────────────

describe("putSessionId", () => {
  it("PUTs session ID to status endpoint", async () => {
    await putSessionId("http://example.com/api/jobs/1/status", "tok-123", "ses-abc");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://example.com/api/jobs/1/status",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer tok-123",
        }),
        body: JSON.stringify({ danxbot_session_id: "ses-abc" }),
      }),
    );
  });

  it("does not throw when fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    await expect(
      putSessionId("http://example.com/status", "tok", "ses"),
    ).resolves.toBeUndefined();
  });
});

// ─── mapEntryToEvents ─────────────────────────────────────────────────────

describe("mapEntryToEvents", () => {
  it("maps system/init to session_init event", () => {
    const entry = makeSystemInitEntry("ses-abc");
    const events = mapEntryToEvents(entry);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session_init",
      session_id: "ses-abc",
      timestamp: entry.timestamp,
    });
  });

  it("maps assistant text block to agent_event", () => {
    const entry = makeAssistantEntry([
      { type: "text", text: "Analyzing the issue..." },
    ]);
    const events = mapEntryToEvents(entry);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_event",
      message: "Analyzing the issue...",
    });
  });

  it("maps assistant tool_use block to tool_call", () => {
    const entry = makeAssistantEntry([
      {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { file_path: "/src/index.ts" },
      },
    ]);
    const events = mapEntryToEvents(entry);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_call",
      tool_name: "Read",
      tool_input: { file_path: "/src/index.ts" },
      tool_use_id: "t1",
    });
  });

  it("maps multiple content blocks to multiple events", () => {
    const entry = makeAssistantEntry([
      { type: "text", text: "Let me read the file." },
      { type: "tool_use", id: "t1", name: "Read", input: {} },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
    ]);
    const events = mapEntryToEvents(entry);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("agent_event");
    expect(events[1].type).toBe("tool_call");
    expect(events[2].type).toBe("tool_call");
  });

  it("skips thinking blocks (no events produced)", () => {
    const entry = makeAssistantEntry([
      { type: "thinking", thinking: "Hmm..." },
    ]);
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("maps user/tool_result to tool_result event", () => {
    const entry = makeToolResultEntry([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "File contents here",
        is_error: false,
      },
    ]);
    const events = mapEntryToEvents(entry);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
      message: "File contents here",
      is_error: false,
    });
  });

  it("truncates tool result content that exceeds 10KB", () => {
    const large = "x".repeat(11_000);
    const entry = makeToolResultEntry([
      { type: "tool_result", tool_use_id: "t1", content: large },
    ]);
    const events = mapEntryToEvents(entry);
    expect(events[0].message).toContain("…[truncated]");
  });

  it("returns empty array for result entries", () => {
    const entry = makeEntry({ type: "result", data: { result_text: "Done" } });
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("returns empty array for assistant with no content", () => {
    const entry = makeAssistantEntry([]);
    expect(mapEntryToEvents(entry)).toHaveLength(0);
  });

  it("maps multiple tool_result blocks to multiple events", () => {
    const entry = makeToolResultEntry([
      { type: "tool_result", tool_use_id: "t1", content: "ok1" },
      { type: "tool_result", tool_use_id: "t2", content: "ok2" },
    ]);
    const events = mapEntryToEvents(entry);
    expect(events).toHaveLength(2);
    expect(events[0].tool_use_id).toBe("t1");
    expect(events[1].tool_use_id).toBe("t2");
  });
});

// ─── createLaravelForwarder ────────────────────────────────────────────────

describe("createLaravelForwarder", () => {
  const STATUS_URL = "http://example.com/api/jobs/1/status";
  const EVENTS_URL = "http://example.com/api/jobs/1/events";
  const API_TOKEN = "tok-secret";

  it("sends batch after timeout when fewer than BATCH_SIZE events", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(makeAssistantEntry([{ type: "text", text: "Hello" }]));

    expect(mockFetch).not.toHaveBeenCalledWith(EVENTS_URL, expect.anything());

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockFetch).toHaveBeenCalledWith(
      EVENTS_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("agent_event"),
      }),
    );
  });

  it("sends batch immediately when BATCH_SIZE events are accumulated", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    for (let i = 0; i < 10; i++) {
      consume(makeAssistantEntry([{ type: "text", text: `msg ${i}` }]));
    }

    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalledWith(
      EVENTS_URL,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("flush() sends remaining events immediately", async () => {
    const { consume, flush } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(makeAssistantEntry([{ type: "text", text: "Event 1" }]));
    consume(makeAssistantEntry([{ type: "text", text: "Event 2" }]));

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).not.toHaveBeenCalled();

    flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalled();
  });

  it("calls putSessionId on system/init entry", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);
    consume(makeSystemInitEntry("ses-xyz"));

    await vi.advanceTimersByTimeAsync(0);

    const putCall = mockFetch.mock.calls.find(
      (c) => c[0] === STATUS_URL && (c[1] as RequestInit).method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse(putCall![1].body as string)).toMatchObject({
      danxbot_session_id: "ses-xyz",
    });
  });

  it("skips entries that produce no events (e.g. result)", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);
    consume(makeEntry({ type: "result", data: { result_text: "done" } }));

    await vi.advanceTimersByTimeAsync(5_000);

    const postCall = mockFetch.mock.calls.find(
      (c) => c[0] === EVENTS_URL,
    );
    expect(postCall).toBeUndefined();
  });

  it("does not throw when fetch fails (best-effort)", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(makeAssistantEntry([{ type: "text", text: "Hello" }]));
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it("resets timer when batch fills and sends", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    for (let i = 0; i < 10; i++) {
      consume(makeAssistantEntry([{ type: "text", text: `msg ${i}` }]));
    }
    await vi.advanceTimersByTimeAsync(0);
    mockFetch.mockClear();

    consume(makeAssistantEntry([{ type: "text", text: "after batch" }]));
    expect(mockFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockFetch).toHaveBeenCalledWith(EVENTS_URL, expect.anything());
  });
});

// ─── startEventForwarding ─────────────────────────────────────────────────

describe("startEventForwarding", () => {
  it("creates a watcher and starts it", () => {
    const handle = startEventForwarding({
      dir: "/some/session/dir",
      dispatchId: "job-abc",
      statusUrl: "http://example.com/status",
      apiToken: "tok",
    });

    expect(handle.watcher).toBeDefined();
    expect(handle.flush).toBeInstanceOf(Function);
    expect(handle.watcher.start).toHaveBeenCalled();
  });

  it("registers forwarder consumer on the watcher", () => {
    const handle = startEventForwarding({
      dir: "/dir",
      dispatchId: "job-1",
      statusUrl: "http://example.com/status",
      apiToken: "tok",
    });

    expect(handle.watcher.onEntry).toHaveBeenCalled();
  });
});
