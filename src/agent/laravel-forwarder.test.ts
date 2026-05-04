import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Mocks ---

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

interface MockWatcher {
  options: Record<string, unknown>;
  onEntry: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

vi.mock("./session-log-watcher.js", () => {
  return {
    SessionLogWatcher: class {
      options: Record<string, unknown>;
      onEntry = vi.fn();
      start = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn();
      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
    },
  };
});

import {
  deriveEventsUrl,
  deriveQueuePath,
  drainQueue,
  postEventsWithRetry,
  replayQueueOnBoot,
  truncateToolResultContent,
  mapEntryToEvents,
  createLaravelForwarder,
  startEventForwarding,
  type EventPayload,
} from "./laravel-forwarder.js";
import { EventQueue } from "./event-queue.js";
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

function makeAssistantEntry(
  content: Record<string, unknown>[],
  usage?: Record<string, number>,
): AgentLogEntry {
  return makeEntry({
    type: "assistant",
    data: { content, usage, delta_ms: 0 },
  });
}

function makeToolResultEntry(results: Record<string, unknown>[]): AgentLogEntry {
  return makeEntry({
    type: "user",
    data: { content: results, delta_ms: 0 },
  });
}

function makeSystemInitEntry(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): AgentLogEntry {
  return makeEntry({
    type: "system",
    subtype: "init",
    data: {
      session_id: sessionId,
      model: "claude-sonnet-4-5",
      tools: ["Read", "Bash"],
      ...overrides,
    },
  });
}

const SAMPLE_USAGE = {
  input_tokens: 100,
  cache_read_input_tokens: 500,
  cache_creation_input_tokens: 50,
  output_tokens: 200,
};

const ALLOWED_TYPES = new Set([
  "session_init",
  "agent_event",
  "thinking",
  "tool_call",
  "tool_result",
]);

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
    expect(result).toMatch(/truncated/);
  });

  it("allows exactly 10KB without truncation", () => {
    const exact = "x".repeat(10 * 1024);
    expect(truncateToolResultContent(exact)).toBe(exact);
  });

  it("JSON-stringifies non-string content before truncation", () => {
    const obj = { a: 1, b: "x".repeat(11_000) };
    const result = truncateToolResultContent(obj);
    expect(result).toMatch(/truncated/);
  });
});

// ─── mapEntryToEvents — nested payload shape ───────────────────────────────

describe("mapEntryToEvents", () => {
  describe("EventPayload shape", () => {
    it("emits only {type, message?, data?} — no top-level flat fields", () => {
      const entry = makeAssistantEntry([
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
      ]);
      const events = mapEntryToEvents(entry);
      expect(events).toHaveLength(1);

      for (const key of Object.keys(events[0])) {
        expect(["type", "message", "data"]).toContain(key);
      }
      expect(events[0]).not.toHaveProperty("timestamp");
      expect(events[0]).not.toHaveProperty("tool_name");
      expect(events[0]).not.toHaveProperty("tool_input");
      expect(events[0]).not.toHaveProperty("tool_use_id");
      expect(events[0]).not.toHaveProperty("is_error");
      expect(events[0]).not.toHaveProperty("session_id");
    });

    it("every emitted type is in the gpt-manager whitelist", () => {
      const entries: AgentLogEntry[] = [
        makeSystemInitEntry("ses-1"),
        makeAssistantEntry(
          [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "t", name: "Read", input: {} },
          ],
          SAMPLE_USAGE,
        ),
        makeAssistantEntry([], SAMPLE_USAGE),
        makeToolResultEntry([
          { type: "tool_result", tool_use_id: "t", content: "ok" },
        ]),
      ];
      const allEvents = entries.flatMap(mapEntryToEvents);
      expect(allEvents.length).toBeGreaterThan(0);
      for (const event of allEvents) {
        expect(ALLOWED_TYPES.has(event.type)).toBe(true);
      }
    });
  });

  describe("system/init", () => {
    it("maps to session_init with data: { session_id, model, agents }", () => {
      const entry = makeSystemInitEntry("ses-abc");
      const events = mapEntryToEvents(entry);
      expect(events).toEqual([
        {
          type: "session_init",
          data: {
            session_id: "ses-abc",
            model: "claude-sonnet-4-5",
            agents: ["Read", "Bash"],
          },
        },
      ]);
    });

    it("does not emit session_init for non-init system entries", () => {
      const entry = makeEntry({
        type: "system",
        subtype: "turn_duration",
        data: { durationMs: 123 },
      });
      expect(mapEntryToEvents(entry)).toHaveLength(0);
    });
  });

  describe("assistant text blocks", () => {
    it("maps text block to agent_event with message but no data when no usage", () => {
      const entry = makeAssistantEntry([
        { type: "text", text: "Hello world" },
      ]);
      expect(mapEntryToEvents(entry)).toEqual([
        { type: "agent_event", message: "Hello world" },
      ]);
    });

    it("attaches usage exclusively to the first agent_event.data.usage", () => {
      const entry = makeAssistantEntry(
        [
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
        SAMPLE_USAGE,
      );
      const events = mapEntryToEvents(entry);
      expect(events).toEqual([
        {
          type: "agent_event",
          message: "First",
          data: { usage: SAMPLE_USAGE },
        },
        { type: "agent_event", message: "Second" },
      ]);
    });

    it("skips empty-string text blocks; usage cascades to thinking fallback", () => {
      const entry = makeAssistantEntry(
        [{ type: "text", text: "" }],
        SAMPLE_USAGE,
      );
      expect(mapEntryToEvents(entry)).toEqual([
        { type: "thinking", data: { usage: SAMPLE_USAGE } },
      ]);
    });
  });

  describe("assistant tool_use blocks", () => {
    it("maps tool_use to tool_call with nested data and no flat fields", () => {
      const entry = makeAssistantEntry([
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "/src/index.ts" },
        },
      ]);
      expect(mapEntryToEvents(entry)).toEqual([
        {
          type: "tool_call",
          message: "Read",
          data: {
            tool: "Read",
            tool_use_id: "t1",
            input: { file_path: "/src/index.ts" },
          },
        },
      ]);
    });

    it("attaches usage to first tool_call without clobbering other data fields", () => {
      const entry = makeAssistantEntry(
        [
          { type: "tool_use", id: "t1", name: "Read", input: { x: 1 } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
        SAMPLE_USAGE,
      );
      const events = mapEntryToEvents(entry);
      expect(events).toEqual([
        {
          type: "tool_call",
          message: "Read",
          data: {
            tool: "Read",
            tool_use_id: "t1",
            input: { x: 1 },
            usage: SAMPLE_USAGE,
          },
        },
        {
          type: "tool_call",
          message: "Bash",
          data: {
            tool: "Bash",
            tool_use_id: "t2",
            input: { command: "ls" },
          },
        },
      ]);
    });

    it("prefers text over tool_call for usage attachment", () => {
      const entry = makeAssistantEntry(
        [
          { type: "text", text: "Let me read the file." },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
        SAMPLE_USAGE,
      );
      const events = mapEntryToEvents(entry);
      expect(events[0]).toEqual({
        type: "agent_event",
        message: "Let me read the file.",
        data: { usage: SAMPLE_USAGE },
      });
      expect(events[1].data).toEqual({
        tool: "Read",
        tool_use_id: "t1",
        input: {},
      });
    });

    it("skips tool_use blocks with missing name; usage cascades to thinking", () => {
      const entry = makeAssistantEntry(
        [{ type: "tool_use", id: "t1", input: {} }],
        SAMPLE_USAGE,
      );
      expect(mapEntryToEvents(entry)).toEqual([
        { type: "thinking", data: { usage: SAMPLE_USAGE } },
      ]);
    });
  });

  describe("assistant thinking-only (usage with no text/tool_use)", () => {
    it("emits a dedicated thinking event with data.usage", () => {
      const entry = makeAssistantEntry([], SAMPLE_USAGE);
      expect(mapEntryToEvents(entry)).toEqual([
        { type: "thinking", data: { usage: SAMPLE_USAGE } },
      ]);
    });

    it("emits thinking event when content only has non-text/non-tool blocks + usage", () => {
      const entry = makeAssistantEntry(
        [{ type: "thinking", thinking: "internal" }],
        SAMPLE_USAGE,
      );
      expect(mapEntryToEvents(entry)).toEqual([
        { type: "thinking", data: { usage: SAMPLE_USAGE } },
      ]);
    });

    it("emits nothing when no usage and no emittable blocks", () => {
      expect(
        mapEntryToEvents(
          makeAssistantEntry(
            [{ type: "thinking", thinking: "internal" }],
            undefined,
          ),
        ),
      ).toHaveLength(0);
    });

    it("emits nothing when content is empty and no usage", () => {
      expect(mapEntryToEvents(makeAssistantEntry([]))).toHaveLength(0);
    });
  });

  describe("user tool_result blocks", () => {
    it("maps tool_result to { type: tool_result, data: { tool_use_id, content, is_error } }", () => {
      const entry = makeToolResultEntry([
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "File contents here",
          is_error: false,
        },
      ]);
      expect(mapEntryToEvents(entry)).toEqual([
        {
          type: "tool_result",
          data: {
            tool_use_id: "t1",
            content: "File contents here",
            is_error: false,
          },
        },
      ]);
    });

    it("truncates large tool_result content", () => {
      const large = "x".repeat(11_000);
      const entry = makeToolResultEntry([
        { type: "tool_result", tool_use_id: "t1", content: large },
      ]);
      const events = mapEntryToEvents(entry);
      expect(events[0].data?.content).toMatch(/truncated/);
    });

    it("defaults is_error to false when field is omitted", () => {
      const entry = makeToolResultEntry([
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
      ]);
      expect(mapEntryToEvents(entry)[0].data?.is_error).toBe(false);
    });

    it("maps multiple tool_result blocks to multiple events", () => {
      const entry = makeToolResultEntry([
        { type: "tool_result", tool_use_id: "t1", content: "ok1" },
        { type: "tool_result", tool_use_id: "t2", content: "ok2", is_error: true },
      ]);
      const events = mapEntryToEvents(entry);
      expect(events).toHaveLength(2);
      expect(events[0].data).toEqual({
        tool_use_id: "t1",
        content: "ok1",
        is_error: false,
      });
      expect(events[1].data).toEqual({
        tool_use_id: "t2",
        content: "ok2",
        is_error: true,
      });
    });

    it("skips non-tool_result blocks in user content", () => {
      const entry = makeToolResultEntry([
        { type: "something_else", content: "ignored" },
      ]);
      expect(mapEntryToEvents(entry)).toHaveLength(0);
    });
  });

  describe("result entries", () => {
    it("returns empty array", () => {
      const entry = makeEntry({ type: "result", data: { result_text: "Done" } });
      expect(mapEntryToEvents(entry)).toHaveLength(0);
    });
  });
});

// ─── createLaravelForwarder — batching + PUT side-effect ───────────────────

const STATUS_URL = "http://example.com/api/jobs/1/status";
const EVENTS_URL = "http://example.com/api/jobs/1/events";
const API_TOKEN = "tok-secret";

type FetchCall = [string, RequestInit];

function postCalls(): FetchCall[] {
  return mockFetch.mock.calls.filter(
    (c: unknown[]) =>
      c[0] === EVENTS_URL && (c[1] as RequestInit).method === "POST",
  ) as FetchCall[];
}

function putCalls(): FetchCall[] {
  return mockFetch.mock.calls.filter(
    (c: unknown[]) =>
      c[0] === STATUS_URL && (c[1] as RequestInit).method === "PUT",
  ) as FetchCall[];
}

function decodeBatch(call: FetchCall): EventPayload[] {
  return (JSON.parse(call[1].body as string) as { events: EventPayload[] }).events;
}

describe("createLaravelForwarder", () => {
  it("POSTs batch body { events: [...] } with nested shape", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(
      makeAssistantEntry([{ type: "text", text: "Hello" }], SAMPLE_USAGE),
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(postCalls()).toHaveLength(1);
    expect(decodeBatch(postCalls()[0])).toEqual([
      {
        type: "agent_event",
        message: "Hello",
        data: { usage: SAMPLE_USAGE },
      },
    ]);
  });

  it("sends batch after timeout when fewer than BATCH_SIZE events", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(makeAssistantEntry([{ type: "text", text: "Hello" }]));
    expect(postCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(postCalls()).toHaveLength(1);
  });

  it("sends batch immediately when BATCH_SIZE events are accumulated", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    for (let i = 0; i < 10; i++) {
      consume(makeAssistantEntry([{ type: "text", text: `msg ${i}` }]));
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(postCalls()).toHaveLength(1);
    expect(decodeBatch(postCalls()[0])).toHaveLength(10);
  });

  it("clears the flush timer when BATCH_SIZE triggers a send (no duplicate POST)", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    // Schedule a timer with a few events first.
    for (let i = 0; i < 3; i++) {
      consume(makeAssistantEntry([{ type: "text", text: `early ${i}` }]));
    }
    // Fill the batch to trigger immediate send + timer clear.
    for (let i = 0; i < 7; i++) {
      consume(makeAssistantEntry([{ type: "text", text: `fill ${i}` }]));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(postCalls()).toHaveLength(1);

    // Advance past the original timer — no extra empty POST should fire.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(postCalls()).toHaveLength(1);
  });

  it("splits at BATCH_SIZE when a single entry emits more than BATCH_SIZE events", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    const content = Array.from({ length: 11 }, (_, i) => ({
      type: "text",
      text: `block ${i}`,
    }));
    consume(makeAssistantEntry(content));
    await vi.advanceTimersByTimeAsync(0);

    expect(postCalls()).toHaveLength(1);
    expect(decodeBatch(postCalls()[0])).toHaveLength(11);
  });

  it("flush() sends remaining events immediately", async () => {
    const { consume, flush } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(makeAssistantEntry([{ type: "text", text: "Event 1" }]));
    consume(makeAssistantEntry([{ type: "text", text: "Event 2" }]));
    expect(postCalls()).toHaveLength(0);

    flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(postCalls()).toHaveLength(1);
    expect(decodeBatch(postCalls()[0])).toHaveLength(2);
  });

  it("flush() is a no-op when no events are buffered", async () => {
    const { flush } = createLaravelForwarder(STATUS_URL, API_TOKEN);
    flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(postCalls()).toHaveLength(0);
  });

  it("PUTs danxbot_session_id to status endpoint on system/init", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);
    consume(makeSystemInitEntry("ses-xyz"));
    await vi.advanceTimersByTimeAsync(0);

    expect(putCalls()).toHaveLength(1);
    const [[, init]] = putCalls();
    expect(JSON.parse(init.body as string)).toEqual({
      danxbot_session_id: "ses-xyz",
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_TOKEN}`,
    );
  });

  it("does not PUT when system/init is missing session_id", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);
    consume(
      makeEntry({
        type: "system",
        subtype: "init",
        data: { model: "x", tools: [] },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(putCalls()).toHaveLength(0);
  });

  it("continues forwarding events when the session_id PUT fails", async () => {
    let putCount = 0;
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        putCount++;
        return Promise.reject(new Error("put failed"));
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);
    consume(makeSystemInitEntry("ses-xyz"));
    consume(makeAssistantEntry([{ type: "text", text: "Hello" }]));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(putCount).toBe(1);
    expect(postCalls()).toHaveLength(1);
  });

  it("session_init entry is also forwarded as an event in the batch", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);
    consume(makeSystemInitEntry("ses-xyz"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(postCalls()).toHaveLength(1);
    expect(decodeBatch(postCalls()[0])).toEqual([
      {
        type: "session_init",
        data: {
          session_id: "ses-xyz",
          model: "claude-sonnet-4-5",
          agents: ["Read", "Bash"],
        },
      },
    ]);
  });

  it("skips entries that produce no events (e.g. result)", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);
    consume(makeEntry({ type: "result", data: { result_text: "done" } }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(postCalls()).toHaveLength(0);
  });

  it("does not throw when POST fetch fails and still attempts the POST", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(makeAssistantEntry([{ type: "text", text: "Hello" }]));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(postCalls()).toHaveLength(1);
  });
});

// ─── startEventForwarding ─────────────────────────────────────────────────

describe("startEventForwarding", () => {
  it("constructs the SessionLogWatcher with the provided options", () => {
    const handle = startEventForwarding({
      dir: "/some/session/dir",
      dispatchId: "job-abc",
      statusUrl: STATUS_URL,
      apiToken: API_TOKEN,
      pollIntervalMs: 250,
    });

    const watcher = handle.watcher as unknown as MockWatcher;
    expect(watcher.options).toEqual({
      cwd: "/some/session/dir",
      sessionDir: "/some/session/dir",
      dispatchId: "job-abc",
      pollIntervalMs: 250,
    });
    expect(watcher.start).toHaveBeenCalled();
  });

  it("registers a consumer that forwards entries through the Laravel POST", async () => {
    const handle = startEventForwarding({
      dir: "/dir",
      dispatchId: "job-1",
      statusUrl: STATUS_URL,
      apiToken: API_TOKEN,
    });

    const watcher = handle.watcher as unknown as MockWatcher;
    expect(watcher.onEntry).toHaveBeenCalledTimes(1);
    const consumer = watcher.onEntry.mock.calls[0][0] as (
      entry: AgentLogEntry,
    ) => void;

    consumer(makeAssistantEntry([{ type: "text", text: "via watcher" }]));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(postCalls()).toHaveLength(1);
    expect(decodeBatch(postCalls()[0])).toEqual([
      { type: "agent_event", message: "via watcher" },
    ]);
  });
});

// ─── Sub-agent lineage propagation (Phase 2) ────────────────────────────

describe("createLaravelForwarder — sub-agent lineage", () => {
  const LINEAGE = {
    subagent_id: "agent-abc",
    parent_session_id: "sess-parent-xyz",
    agent_type: "Explore",
  };

  function makeSubagentAssistantEntry(
    content: Record<string, unknown>[],
    usage?: Record<string, number>,
  ): AgentLogEntry {
    return makeEntry({
      type: "assistant",
      data: { content, usage, delta_ms: 0, ...LINEAGE },
    });
  }

  it("adds lineage fields to every event emitted from a sub-agent entry", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(
      makeSubagentAssistantEntry(
        [
          { type: "text", text: "Sub speaking" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
        SAMPLE_USAGE,
      ),
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(postCalls()).toHaveLength(1);
    const events = decodeBatch(postCalls()[0]);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.data).toMatchObject(LINEAGE);
    }
    // The first event (agent_event) still carries usage alongside lineage.
    expect(events[0].data).toMatchObject({ ...LINEAGE, usage: SAMPLE_USAGE });
  });

  it("adds lineage fields to the fallback thinking event", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(makeSubagentAssistantEntry([], SAMPLE_USAGE));
    await vi.advanceTimersByTimeAsync(5_000);

    const events = decodeBatch(postCalls()[0]);
    expect(events).toEqual([
      {
        type: "thinking",
        data: { usage: SAMPLE_USAGE, ...LINEAGE },
      },
    ]);
  });

  it("does not add lineage fields to events from parent entries", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    // Entry has NO lineage fields.
    consume(makeAssistantEntry([{ type: "text", text: "Parent" }]));
    await vi.advanceTimersByTimeAsync(5_000);

    const events = decodeBatch(postCalls()[0]);
    expect(events).toEqual([{ type: "agent_event", message: "Parent" }]);
    expect(events[0].data).toBeUndefined();
  });

  it("propagates lineage through tool_result sub-agent events", async () => {
    const { consume } = createLaravelForwarder(STATUS_URL, API_TOKEN);

    consume(
      makeEntry({
        type: "user",
        data: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "sub-tool-1",
              content: "sub result",
            },
          ],
          delta_ms: 0,
          ...LINEAGE,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);

    const events = decodeBatch(postCalls()[0]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_result");
    expect(events[0].data).toMatchObject({
      tool_use_id: "sub-tool-1",
      content: "sub result",
      is_error: false,
      ...LINEAGE,
    });
  });
});

// ─── Phase 3: postEventsWithRetry ───────────────────────────────────────

describe("postEventsWithRetry", () => {
  const URL = "http://example.com/api/jobs/1/events";
  const EVENTS: EventPayload[] = [{ type: "agent_event", message: "hi" }];
  const DELAYS = [10, 20]; // small delays for fast tests — 2 retry attempts

  it("returns 'ok' on first-try 2xx", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const promise = postEventsWithRetry(URL, EVENTS, API_TOKEN, DELAYS);
    await vi.advanceTimersByTimeAsync(0);
    expect(await promise).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx with exponential backoff then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const promise = postEventsWithRetry(URL, EVENTS, API_TOKEN, DELAYS);

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DELAYS[0]);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(DELAYS[1]);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    expect(await promise).toBe("ok");
  });

  it("retries on thrown network errors", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const promise = postEventsWithRetry(URL, EVENTS, API_TOKEN, DELAYS);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    expect(await promise).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns 'client-error' immediately on 4xx (no retry)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });
    const promise = postEventsWithRetry(URL, EVENTS, API_TOKEN, DELAYS);
    await vi.advanceTimersByTimeAsync(0);

    expect(await promise).toBe("client-error");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns 'retry-later' after exhausting all retries", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const promise = postEventsWithRetry(URL, EVENTS, API_TOKEN, DELAYS);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DELAYS[0]);
    await vi.advanceTimersByTimeAsync(DELAYS[1]);

    expect(await promise).toBe("retry-later");
    expect(mockFetch).toHaveBeenCalledTimes(1 + DELAYS.length);
  });

  it("POSTs {events: [...]} with Authorization header", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const promise = postEventsWithRetry(URL, EVENTS, API_TOKEN, DELAYS);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const [[fetchUrl, init]] = mockFetch.mock.calls;
    expect(fetchUrl).toBe(URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      `Bearer ${API_TOKEN}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({ events: EVENTS });
  });
});

// ─── Phase 3: drainQueue ───────────────────────────────────────────────

describe("drainQueue", () => {
  let queueDir: string;
  const DELAYS = [5]; // 1 retry for fast tests

  beforeEach(() => {
    vi.useRealTimers();
    queueDir = mkdtempSync(join(tmpdir(), "drain-queue-test-"));
  });
  afterEach(() => {
    rmSync(queueDir, { recursive: true, force: true });
    vi.useFakeTimers();
  });

  it("delivers all queued batches and clears the queue when every attempt succeeds", async () => {
    const queue = new EventQueue(join(queueDir, "d.jsonl"));
    await queue.enqueue([{ type: "agent_event", message: "a" }]);
    await queue.enqueue([{ type: "agent_event", message: "b" }]);

    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    await drainQueue(queue, "http://example.com/events", API_TOKEN, DELAYS);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(await queue.hasPending()).toBe(false);
  });

  it("retains failed-and-subsequent batches when a middle send gives up", async () => {
    const queue = new EventQueue(join(queueDir, "d.jsonl"));
    await queue.enqueue([{ type: "agent_event", message: "first" }]);
    await queue.enqueue([{ type: "agent_event", message: "stuck" }]);
    await queue.enqueue([{ type: "agent_event", message: "after" }]);

    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 }) // first
      .mockResolvedValue({ ok: false, status: 503 }); // subsequent all fail

    await drainQueue(queue, "http://example.com/events", API_TOKEN, DELAYS);

    const remaining = await queue.peekAll();
    expect(remaining).toEqual([
      [{ type: "agent_event", message: "stuck" }],
      [{ type: "agent_event", message: "after" }],
    ]);
  });

  it("drops 4xx-rejected batches without retaining them", async () => {
    const queue = new EventQueue(join(queueDir, "d.jsonl"));
    await queue.enqueue([{ type: "agent_event", message: "bad" }]);
    await queue.enqueue([{ type: "agent_event", message: "good" }]);

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await drainQueue(queue, "http://example.com/events", API_TOKEN, DELAYS);

    expect(await queue.hasPending()).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("no-ops when the queue is empty", async () => {
    const queue = new EventQueue(join(queueDir, "empty.jsonl"));
    await drainQueue(
      queue,
      "http://example.com/events",
      API_TOKEN,
      DELAYS,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── Phase 3: createLaravelForwarder + EventQueue integration ──────────

describe("createLaravelForwarder with EventQueue (write-ahead + retry)", () => {
  let queueDir: string;
  const DELAYS = [5];
  const DISPATCH_ID = "dispatch-queued";

  // Real timers for this block: we mix fake timers with real fs I/O, and
  // libuv-backed fs callbacks don't resolve under fake timers. Use `flush()`
  // directly instead of advancing the batch timeout.
  beforeEach(() => {
    vi.useRealTimers();
    queueDir = mkdtempSync(join(tmpdir(), "fwd-queue-test-"));
  });
  afterEach(() => {
    rmSync(queueDir, { recursive: true, force: true });
    vi.useFakeTimers();
  });

  function makeForwarder() {
    const queue = new EventQueue(deriveQueuePath(queueDir, DISPATCH_ID));
    return {
      queue,
      ...createLaravelForwarder(STATUS_URL, API_TOKEN, {
        queue,
        retryDelaysMs: DELAYS,
      }),
    };
  }

  it("delivers successfully and leaves the queue empty on 2xx", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const { queue, consume, flush } = makeForwarder();

    consume(makeAssistantEntry([{ type: "text", text: "Hello" }]));
    await flush();

    expect(postCalls()).toHaveLength(1);
    expect(await queue.hasPending()).toBe(false);
  });

  it("persists the batch in the on-disk queue after exhausting retries on 5xx", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const { queue, consume, flush } = makeForwarder();

    consume(makeAssistantEntry([{ type: "text", text: "Stuck" }]));
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1 + DELAYS.length);
    expect(await queue.hasPending()).toBe(true);
    const pending = await queue.peekAll();
    expect(pending).toEqual([[{ type: "agent_event", message: "Stuck" }]]);
  });

  it("drains previously-stuck queue batches BEFORE sending new events", async () => {
    const { queue, consume, flush } = makeForwarder();
    await queue.enqueue([{ type: "agent_event", message: "old" }]);

    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    consume(makeAssistantEntry([{ type: "text", text: "new" }]));
    await flush();

    expect(postCalls()).toHaveLength(2);
    expect(decodeBatch(postCalls()[0])).toEqual([
      { type: "agent_event", message: "old" },
    ]);
    expect(decodeBatch(postCalls()[1])).toEqual([
      { type: "agent_event", message: "new" },
    ]);
    expect(await queue.hasPending()).toBe(false);
  });

  it("does NOT retry or requeue 4xx client errors", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });
    const { queue, consume, flush } = makeForwarder();

    consume(makeAssistantEntry([{ type: "text", text: "bad shape" }]));
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await queue.hasPending()).toBe(false);
  });

  // Regression guard for Trello 69f7844004a63103a75b2bd5: when the queue's
  // containing directory is removed mid-flush (test teardown via mkdtemp
  // + rmSync, or production log rotation), `EventQueue.enqueue` ENOENTs
  // out of `appendFile`. Previously this rejection bubbled out of the
  // fire-and-forget `void drainAndSend()` calls in `consume()` /
  // `scheduleFlush()` and out of the `void forwarderFlush?.()` call in
  // `launcher.ts#runCleanup`, surfacing as an "Unhandled Rejection" in
  // vitest output. The forwarder's contract is best-effort delivery; a
  // missing queue dir means events are lost, not that the process should
  // crash.
  it("flush() resolves (does not reject) when the queue directory is removed mid-run", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const { consume, flush } = makeForwarder();

    consume(makeAssistantEntry([{ type: "text", text: "before-removal" }]));
    rmSync(queueDir, { recursive: true, force: true });

    await expect(flush()).resolves.toBeUndefined();
  });

  it("BATCH_SIZE-triggered drain does not produce an unhandled rejection when the queue dir is gone", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const { consume } = makeForwarder();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      // Filter to ONLY this test's queueDir so any cross-file vitest
      // worker rejection (a different test's leak) doesn't false-fail
      // the assertion below. The unhandled rejection we're guarding
      // against has the queueDir embedded in the ENOENT path.
      const message = String((reason as Error)?.message ?? reason);
      if (message.includes(queueDir)) unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      rmSync(queueDir, { recursive: true, force: true });
      // BATCH_SIZE = 10 in laravel-forwarder; fill the batch to fire the
      // implicit `void drainAndSend()` path inside consume().
      for (let i = 0; i < 10; i++) {
        consume(makeAssistantEntry([{ type: "text", text: `evt ${i}` }]));
      }
      // Yield long enough for the awaited appendFile + retry chain to
      // settle. Two macrotask hops covers the libuv fs callback + any
      // microtask drain.
      await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  // Ensures the swallow-with-log.warn contract in `drainAndSend` doesn't
  // silently rot to a bare `catch {}`. Without an assertion that
  // log.warn actually fires, a future agent could "simplify" the catch
  // and lose the operator's only signal that disk-write failures are
  // happening (ENOSPC, EROFS in production log-rotation scenarios).
  it("logs a warn when a drain failure is swallowed (no silent catch rot)", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const { consume, flush } = makeForwarder();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    consume(makeAssistantEntry([{ type: "text", text: "lost" }]));
    rmSync(queueDir, { recursive: true, force: true });

    await flush();

    const warnLines = errorSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => typeof line === "string" && line.includes('"level":"warn"'))
      .filter((line) => line.includes("laravel-forwarder"))
      .filter((line) => line.includes("Drain failed"));
    expect(warnLines.length).toBeGreaterThanOrEqual(1);
    expect(warnLines[0]).toContain("ENOENT");
    errorSpy.mockRestore();
  });
});

// ─── Phase 3: replayQueueOnBoot ────────────────────────────────────────

describe("replayQueueOnBoot", () => {
  let queueDir: string;
  const DELAYS = [5];

  beforeEach(() => {
    vi.useRealTimers();
    queueDir = mkdtempSync(join(tmpdir(), "replay-test-"));
  });
  afterEach(() => {
    rmSync(queueDir, { recursive: true, force: true });
    vi.useFakeTimers();
  });

  it("flushes pending events for a dispatch on boot and clears the file", async () => {
    const queue = new EventQueue(deriveQueuePath(queueDir, "d-boot"));
    await queue.enqueue([{ type: "agent_event", message: "survived" }]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await replayQueueOnBoot(
      "d-boot",
      queueDir,
      STATUS_URL,
      API_TOKEN,
      DELAYS,
    );

    expect(postCalls()).toHaveLength(1);
    expect(await queue.hasPending()).toBe(false);
  });

  it("is a no-op when the dispatch has no pending queue file", async () => {
    await replayQueueOnBoot(
      "never-had-a-queue",
      queueDir,
      STATUS_URL,
      API_TOKEN,
      DELAYS,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
