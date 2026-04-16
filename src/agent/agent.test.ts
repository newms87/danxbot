import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ThreadMessage, HeartbeatSnapshot, AgentLogEntry, RepoContext } from "../types.js";

// --- Mocks ---

const MOCK_USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("You are a test system prompt."),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config.js", () => ({
  config: {
    anthropic: { apiKey: "test-key" },
    agent: { model: "test-model", maxTurns: 5, maxBudgetUsd: 1.0, maxThinkingTokens: 8000, maxThreadMessages: 20, routerModel: "test-router-model" },
    logsDir: "/test/logs",
  },
  getRepoPath: (name: string) => `/danxbot/repos/${name}`,
}));

vi.mock("./complexity.js", () => ({
  COMPLEXITY_PROFILES: {
    very_low:  { model: "test-fast-model",   maxTurns: 5,  maxBudgetUsd: 0.10, maxThinkingTokens: 2048,  systemPrompt: "fast" },
    low:       { model: "test-fast-model",   maxTurns: 6,  maxBudgetUsd: 0.20, maxThinkingTokens: 4096,  systemPrompt: "fast" },
    medium:    { model: "test-medium-model", maxTurns: 8,  maxBudgetUsd: 0.50, maxThinkingTokens: 8192,  systemPrompt: "full" },
    high:      { model: "test-medium-model", maxTurns: 12, maxBudgetUsd: 1.00, maxThinkingTokens: 8192,  systemPrompt: "full" },
    very_high: { model: "test-large-model",  maxTurns: 18, maxBudgetUsd: 5.00, maxThinkingTokens: 32768, systemPrompt: "full" },
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const MOCK_REPO_CONTEXT: RepoContext = {
  name: "test-repo",
  url: "https://example.com/test.git",
  localPath: "/test/repos/test-repo",
  trello: {
    apiKey: "test-trello-key",
    apiToken: "test-trello-token",
    boardId: "test-board-id",
    reviewListId: "test-review-list-id",
    todoListId: "test-todo-list-id",
    inProgressListId: "test-in-progress-list-id",
    needsHelpListId: "test-needs-help-list-id",
    doneListId: "test-done-list-id",
    cancelledListId: "test-cancelled-list-id",
    actionItemsListId: "test-action-items-list-id",
    bugLabelId: "test-bug-label-id",
    featureLabelId: "test-feature-label-id",
    epicLabelId: "test-epic-label-id",
    needsHelpLabelId: "test-needs-help-label-id",
  },
  slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
  db: { host: "", user: "", password: "", database: "", enabled: false },
  githubToken: "",
};

const { buildConversationMessages, runRouter } = await import("./router.js");
const { buildActivitySummary, generateHeartbeatMessage } = await import("./heartbeat.js");
const { runAgent } = await import("./agent.js");

// --- Helpers ---

function msg(
  text: string,
  isBot: boolean,
  user = isBot ? "danxbot" : "U123",
): ThreadMessage {
  return { user, text, ts: Date.now().toString(), isBot };
}

/** Creates an async iterable from an array of messages */
async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Pure function tests (Phase 1)
// ============================================================

describe("buildConversationMessages", () => {
  it("returns empty array for empty input", () => {
    expect(buildConversationMessages([])).toEqual([]);
  });

  it("converts a single user message", () => {
    const result = buildConversationMessages([msg("hello", false)]);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("handles alternating user/bot messages", () => {
    const result = buildConversationMessages([
      msg("question", false),
      msg("answer", true),
      msg("follow-up", false),
    ]);
    expect(result).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "follow-up" },
    ]);
  });

  it("merges consecutive user messages", () => {
    const result = buildConversationMessages([
      msg("first", false),
      msg("second", false),
    ]);
    expect(result).toEqual([{ role: "user", content: "first\nsecond" }]);
  });

  it("merges consecutive bot messages", () => {
    const result = buildConversationMessages([
      msg("question", false),
      msg("part 1", true),
      msg("part 2", true),
    ]);
    expect(result).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "part 1\npart 2" },
    ]);
  });

  it("removes leading assistant message (thread starting with bot)", () => {
    const result = buildConversationMessages([
      msg("bot intro", true),
      msg("user reply", false),
    ]);
    expect(result).toEqual([{ role: "user", content: "user reply" }]);
  });

  it("handles real-world 8-message thread scenario", () => {
    const thread: ThreadMessage[] = [
      msg("Hey Danxbot, how does campaign filtering work?", false),
      msg("Campaign filtering uses the FilterBuilder macro...", true),
      msg("Can you show me the code?", false),
      msg("Sure, here's the relevant code...", true),
      msg("What about date filters?", false),
      msg("Date filters are handled by...", true),
      msg("And sorting?", false),
      msg("Sorting is configured via...", true),
    ];

    const result = buildConversationMessages(thread);

    expect(result).toHaveLength(8);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    for (let i = 1; i < result.length; i++) {
      expect(result[i].role).not.toBe(result[i - 1].role);
    }
  });
});

// ============================================================
// Router tests (Phase 3)
// ============================================================

describe("runRouter", () => {
  it("passes single message when no thread history", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"quickResponse":"Hi!","needsAgent":false,"reason":"greeting"}',
        },
      ],
    });

    const result = await runRouter("hello");

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("combines user-only thread history into single context message", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"quickResponse":"Looking into it...","needsAgent":true,"reason":"code question"}',
        },
      ],
    });

    const thread = [
      msg("How does auth work?", false),
      msg("Auth uses JWT tokens.", true),
      msg("Can you show me?", false),
    ];

    const result = await runRouter("Can you show me?", thread);

    const callArgs = mockCreate.mock.calls[0][0];
    // Bot messages filtered — user messages combined into single message
    expect(callArgs.messages.length).toBe(1);
    expect(callArgs.messages[0].role).toBe("user");
    expect(callArgs.messages[0].content).toContain("How does auth work?");
    expect(callArgs.messages[0].content).toContain("Can you show me?");
    expect(callArgs.messages[0].content).not.toContain("JWT tokens");
  });

  it("parses JSON response correctly", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"quickResponse":"Hello there!","needsAgent":false,"reason":"simple greeting"}',
        },
      ],
    });

    const result = await runRouter("hi");

    expect(result.quickResponse).toBe("Hello there!");
    expect(result.needsAgent).toBe(false);
    expect(result.reason).toBe("simple greeting");
  });

  it("handles code-fenced JSON response", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '```json\n{"quickResponse":"Sure!","needsAgent":true,"reason":"needs code"}\n```',
        },
      ],
    });

    const result = await runRouter("show me the code");

    expect(result.quickResponse).toBe("Sure!");
    expect(result.needsAgent).toBe(true);
  });

  it("returns error fallback on API failure", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API rate limit"));

    const result = await runRouter("hello");

    expect(result.quickResponse).toBe("I'm having a moment — give me a sec and try again.");
    expect(result.needsAgent).toBe(false);
    expect(result.reason).toBe("router error");
  });

  it("populates usage on successful response", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 50, cache_read_input_tokens: 30 },
      content: [
        {
          type: "text",
          text: '{"quickResponse":"Hi!","needsAgent":false,"reason":"greeting"}',
        },
      ],
    });

    const result = await runRouter("hello");

    expect(result.usage).not.toBeNull();
    expect(result.usage!.source).toBe("router");
    expect(result.usage!.inputTokens).toBe(200);
    expect(result.usage!.outputTokens).toBe(80);
    expect(result.usage!.cacheCreationInputTokens).toBe(50);
    expect(result.usage!.cacheReadInputTokens).toBe(30);
    expect(result.usage!.costUsd).toBeTypeOf("number");
  });

  it("returns null usage on API failure", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"));

    const result = await runRouter("hello");

    expect(result.usage).toBeNull();
  });

  it("returns error fallback when API returns garbled non-JSON text", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: "Sure! I'd be happy to help. Here is some garbled output that is not JSON at all.",
        },
      ],
    });

    const result = await runRouter("hello");

    expect(result.quickResponse).toBe("I'm having a moment — give me a sec and try again.");
    expect(result.needsAgent).toBe(false);
    expect(result.reason).toBe("router error");
  });
});

// ============================================================
// Agent tests (Phase 3)
// ============================================================

describe("runAgent", () => {
  it("prepends thread context to prompt when no sessionId", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "result",
          subtype: "success",
          result: "Here's the answer.",
          total_cost_usd: 0.05,
          num_turns: 2,
          duration_ms: 1000,
          duration_api_ms: 800,
        },
      ]),
    );

    const thread = [
      msg("What is X?", false),
      msg("X is a feature.", true),
      msg("Tell me more about X", false),
    ];

    await runAgent(MOCK_REPO_CONTEXT, "Tell me more about X", null, undefined, undefined, thread);

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.prompt).toContain("[Thread context]");
    expect(callArgs.prompt).toContain("User: What is X?");
    expect(callArgs.prompt).toContain("Bot: X is a feature.");
    expect(callArgs.prompt).toContain("[Current message]");
    expect(callArgs.prompt).toContain("Tell me more about X");
  });

  it("skips thread context when sessionId exists (session resumption)", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-existing" },
        {
          type: "result",
          subtype: "success",
          result: "Continued answer.",
          total_cost_usd: 0.03,
          num_turns: 1,
          duration_ms: 500,
          duration_api_ms: 400,
        },
      ]),
    );

    const thread = [msg("context msg", false), msg("more context", false)];

    await runAgent(MOCK_REPO_CONTEXT, "follow up", "sess-existing", undefined, undefined, thread);

    const callArgs = mockQuery.mock.calls[0][0];
    // When sessionId exists, prompt is just the message text (no thread context)
    expect(callArgs.prompt).toBe("follow up");
    expect(callArgs.options.resume).toBe("sess-existing");
  });

  it("calls onStream callback on text deltas", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-2" },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello " },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "world" },
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "Hello world",
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 200,
          duration_api_ms: 150,
        },
      ]),
    );

    const streamCalls: string[] = [];
    const onStream = (text: string) => streamCalls.push(text);

    await runAgent(MOCK_REPO_CONTEXT, "test", null, onStream);

    expect(streamCalls).toEqual(["Hello ", "Hello world"]);
  });

  it("ignores non-text deltas (thinking, tool input)", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-3" },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "hmm..." },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: "{}" },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Answer" },
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "Answer",
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 100,
          duration_api_ms: 80,
        },
      ]),
    );

    const streamCalls: string[] = [];
    await runAgent(MOCK_REPO_CONTEXT, "test", null, (text) => streamCalls.push(text));

    // Only the text_delta should trigger the callback
    expect(streamCalls).toEqual(["Answer"]);
  });

  it("returns result text, cost, turns, and session ID", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-4" },
        {
          type: "result",
          subtype: "success",
          result: "The answer is 42.",
          total_cost_usd: 0.123,
          num_turns: 3,
          duration_ms: 5000,
          duration_api_ms: 4000,
        },
      ]),
    );

    const result = await runAgent(MOCK_REPO_CONTEXT, "what is the answer?", null);

    expect(result.text).toBe("The answer is 42.");
    expect(result.subscriptionCostUsd).toBe(0.123);
    expect(result.turns).toBe(3);
    expect(result.sessionId).toBe("sess-4");
  });

  it("sets cwd to platform repo path and settingSources to project-only", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-cwd" },
        {
          type: "result",
          subtype: "success",
          result: "Done.",
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 100,
          duration_api_ms: 80,
        },
      ]),
    );

    await runAgent(MOCK_REPO_CONTEXT, "test", null);

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.cwd).toBe("/test/repos/test-repo");
    expect(callArgs.options.settingSources).toEqual(["project"]);
  });

  it("returns error message on failure", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-5" },
        {
          type: "result",
          subtype: "error",
          result: "",
          total_cost_usd: 0.01,
          num_turns: 1,
          errors: ["Budget exceeded", "Max turns reached"],
          duration_ms: 100,
          duration_api_ms: 80,
        },
      ]),
    );

    const result = await runAgent(MOCK_REPO_CONTEXT, "expensive question", null);

    expect(result.text).toContain("error");
    expect(result.text).toContain("Budget exceeded");
    expect(result.text).toContain("Max turns reached");
  });

  it("calls onLogEntry for each message type", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-log" },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "thinking..." }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
        {
          type: "user",
          message: {
            content: [{ tool_use_id: "tu-1", content: "file contents" }],
          },
        },
        {
          type: "tool_progress",
          tool_name: "Read",
          elapsed_time_seconds: 2,
        },
        {
          type: "result",
          subtype: "success",
          result: "Done.",
          total_cost_usd: 0.02,
          num_turns: 1,
          duration_ms: 500,
          duration_api_ms: 400,
        },
      ]),
    );

    const entries: import("../types.js").AgentLogEntry[] = [];
    const onLogEntry = (entry: import("../types.js").AgentLogEntry) =>
      entries.push(entry);

    await runAgent(MOCK_REPO_CONTEXT, "test log", null, undefined, onLogEntry);

    const types = entries.map((e) => e.type);
    expect(types).toEqual(["system", "assistant", "user", "tool_progress", "result"]);
    expect(entries[0].summary).toContain("Session initialized");
    expect(entries[1].summary).toContain("Text: thinking...");
    expect(entries[2].summary).toContain("Tool results");
    expect(entries[3].summary).toContain("Read running");
    expect(entries[4].summary).toContain("success");
  });

  it("includes log entries in returned AgentResponse", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-log2" },
        {
          type: "result",
          subtype: "success",
          result: "OK",
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 100,
          duration_api_ms: 80,
        },
      ]),
    );

    const result = await runAgent(MOCK_REPO_CONTEXT, "test", null);

    expect(result.log).toHaveLength(2);
    expect(result.log[0].type).toBe("system");
    expect(result.log[1].type).toBe("result");
  });
});

// ============================================================
// runAgent with complexity parameter
// ============================================================

describe("runAgent with complexity", () => {
  it("uses very_low profile (Haiku, 1 turn, $0.05)", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "vl-1" },
        {
          type: "result",
          subtype: "success",
          result: "Quick answer.",
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 200,
          duration_api_ms: 150,
        },
      ]),
    );

    await runAgent(MOCK_REPO_CONTEXT, "how many campaigns?", null, undefined, undefined, [], "very_low");

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.model).toBe("test-fast-model");
    expect(callArgs.options.maxTurns).toBe(5);
    expect(callArgs.options.maxBudgetUsd).toBe(0.10);
    expect(callArgs.options.maxThinkingTokens).toBe(2048);
  });

  it("uses low profile (6 turns, $0.20)", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "low-1" },
        {
          type: "result",
          subtype: "success",
          result: "Answer.",
          total_cost_usd: 0.05,
          num_turns: 2,
          duration_ms: 500,
          duration_api_ms: 400,
        },
      ]),
    );

    await runAgent(MOCK_REPO_CONTEXT, "show recent campaigns", null, undefined, undefined, [], "low");

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.model).toBe("test-fast-model");
    expect(callArgs.options.maxTurns).toBe(6);
    expect(callArgs.options.maxBudgetUsd).toBe(0.20);
    expect(callArgs.options.maxThinkingTokens).toBe(4096);
  });

  it("uses medium profile (8 turns, $0.50)", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "med-1" },
        {
          type: "result",
          subtype: "success",
          result: "Answer.",
          total_cost_usd: 0.20,
          num_turns: 4,
          duration_ms: 2000,
          duration_api_ms: 1500,
        },
      ]),
    );

    await runAgent(MOCK_REPO_CONTEXT, "how does filtering work?", null, undefined, undefined, [], "medium");

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.model).toBe("test-medium-model");
    expect(callArgs.options.maxTurns).toBe(8);
    expect(callArgs.options.maxBudgetUsd).toBe(0.50);
    expect(callArgs.options.maxThinkingTokens).toBe(8192);
  });

  it("uses very_high profile (18 turns, $5.00)", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "vh-1" },
        {
          type: "result",
          subtype: "success",
          result: "Deep answer.",
          total_cost_usd: 1.50,
          num_turns: 12,
          duration_ms: 30000,
          duration_api_ms: 25000,
        },
      ]),
    );

    await runAgent(MOCK_REPO_CONTEXT, "explain billing lifecycle", null, undefined, undefined, [], "very_high");

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.model).toBe("test-large-model");
    expect(callArgs.options.maxTurns).toBe(18);
    expect(callArgs.options.maxBudgetUsd).toBe(5.00);
    expect(callArgs.options.maxThinkingTokens).toBe(32768);
  });

  it("uses config defaults when no complexity is provided", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "def-1" },
        {
          type: "result",
          subtype: "success",
          result: "Answer.",
          total_cost_usd: 0.50,
          num_turns: 5,
          duration_ms: 5000,
          duration_api_ms: 4000,
        },
      ]),
    );

    await runAgent(MOCK_REPO_CONTEXT, "test", null);

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.model).toBe("test-model");
    expect(callArgs.options.maxTurns).toBe(5);
    expect(callArgs.options.maxBudgetUsd).toBe(1.0);
    expect(callArgs.options.maxThinkingTokens).toBe(8000);
  });

  it("always persists sessions regardless of complexity", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "persist-1" },
        {
          type: "result",
          subtype: "success",
          result: "Quick answer.",
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 100,
          duration_api_ms: 80,
        },
      ]),
    );

    const result = await runAgent(MOCK_REPO_CONTEXT, "quick question", null, undefined, undefined, [], "very_low");

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.persistSession).toBe(true);
    expect(result.sessionId).toBe("persist-1");
  });

  it("prepends thread context for very_low complexity", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "vl-ctx" },
        {
          type: "result",
          subtype: "success",
          result: "Answer with context.",
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 100,
          duration_api_ms: 80,
        },
      ]),
    );

    const thread = [
      msg("What is X?", false),
      msg("X is a feature.", true),
      msg("Show me more", false),
    ];

    await runAgent(MOCK_REPO_CONTEXT, "Show me more", null, undefined, undefined, thread, "very_low");

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.prompt).toContain("[Thread context]");
    expect(callArgs.prompt).toContain("[Current message]");
  });

  it("throws on SDK error with complexity", async () => {
    mockQuery.mockReturnValueOnce(
      (async function* () {
        throw new Error("Agent crashed");
      })(),
    );

    await expect(
      runAgent(MOCK_REPO_CONTEXT, "broken query", null, undefined, undefined, [], "very_low"),
    ).rejects.toThrow("Agent crashed");
  });
});

// ============================================================
// AgentUsageSummary extraction
// ============================================================

describe("runAgent extracts AgentUsageSummary from SDK result", () => {
  it("populates usage from result with usage and model_usage", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "usage-1" },
        {
          type: "result",
          subtype: "success",
          result: "Done.",
          total_cost_usd: 0.25,
          num_turns: 4,
          duration_ms: 3000,
          duration_api_ms: 2500,
          usage: {
            input_tokens: 5000,
            output_tokens: 1200,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 100,
          },
          modelUsage: {
            "some-model": {
              inputTokens: 5000,
              outputTokens: 1200,
              cacheReadInputTokens: 300,
              cacheCreationInputTokens: 100,
              costUSD: 0.25,
            },
          },
        },
      ]),
    );

    const result = await runAgent(MOCK_REPO_CONTEXT, "test", null);

    expect(result.usage).not.toBeNull();
    expect(result.usage!.totalCostUsd).toBe(0.25);
    expect(result.usage!.durationMs).toBe(3000);
    expect(result.usage!.durationApiMs).toBe(2500);
    expect(result.usage!.numTurns).toBe(4);
    expect(result.usage!.inputTokens).toBe(5000);
    expect(result.usage!.outputTokens).toBe(1200);
    expect(result.usage!.cacheReadInputTokens).toBe(300);
    expect(result.usage!.cacheCreationInputTokens).toBe(100);
    expect(result.usage!.modelUsage["some-model"]).toEqual({
      inputTokens: 5000,
      outputTokens: 1200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 100,
      costUsd: 0.25,
    });
  });

  it("returns null usage when SDK result has no usage field", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "usage-2" },
        {
          type: "result",
          subtype: "success",
          result: "Done.",
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 100,
          duration_api_ms: 80,
        },
      ]),
    );

    const result = await runAgent(MOCK_REPO_CONTEXT, "test", null);

    expect(result.usage).toBeNull();
  });

  it("handles multi-model usage breakdown", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "usage-3" },
        {
          type: "result",
          subtype: "success",
          result: "Done.",
          total_cost_usd: 0.50,
          num_turns: 6,
          duration_ms: 8000,
          duration_api_ms: 7000,
          usage: {
            input_tokens: 10000,
            output_tokens: 3000,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
          modelUsage: {
            "model-a": {
              inputTokens: 8000,
              outputTokens: 2000,
              cacheReadInputTokens: 400,
              cacheCreationInputTokens: 150,
              costUSD: 0.40,
            },
            "model-b": {
              inputTokens: 2000,
              outputTokens: 1000,
              cacheReadInputTokens: 100,
              cacheCreationInputTokens: 50,
              costUSD: 0.10,
            },
          },
        },
      ]),
    );

    const result = await runAgent(MOCK_REPO_CONTEXT, "test", null);

    expect(Object.keys(result.usage!.modelUsage)).toHaveLength(2);
    expect(result.usage!.modelUsage["model-a"].costUsd).toBe(0.40);
    expect(result.usage!.modelUsage["model-b"].costUsd).toBe(0.10);
  });

  it("defaults missing model_usage fields to zero", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "usage-4" },
        {
          type: "result",
          subtype: "success",
          result: "Done.",
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 100,
          duration_api_ms: 80,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
          modelUsage: {
            "some-model": {
              inputTokens: 100,
              outputTokens: 50,
            },
          },
        },
      ]),
    );

    const result = await runAgent(MOCK_REPO_CONTEXT, "test", null);

    const mu = result.usage!.modelUsage["some-model"];
    expect(mu.cacheReadInputTokens).toBe(0);
    expect(mu.cacheCreationInputTokens).toBe(0);
    expect(mu.costUsd).toBe(0);
  });

  it("handles usage with no model_usage (aggregate only)", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "usage-5" },
        {
          type: "result",
          subtype: "success",
          result: "Done.",
          total_cost_usd: 0.05,
          num_turns: 2,
          duration_ms: 500,
          duration_api_ms: 400,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 20,
          },
        },
      ]),
    );

    const result = await runAgent(MOCK_REPO_CONTEXT, "test", null);

    expect(result.usage).not.toBeNull();
    expect(result.usage!.inputTokens).toBe(1000);
    expect(Object.keys(result.usage!.modelUsage)).toHaveLength(0);
  });
});

// ============================================================
// is_error result handling
// ============================================================

describe("runAgent handles is_error on result messages", () => {
  it("throws descriptive error when result has is_error: true followed by process crash", async () => {
    mockQuery.mockReturnValueOnce(
      asyncIter([
        { type: "system", subtype: "init", session_id: "sess-err-1" },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Credit balance is too low",
          total_cost_usd: 0,
          num_turns: 0,
          duration_ms: 100,
          duration_api_ms: 50,
        },
      ]),
    );

    // When is_error is true, the result should be treated as an error
    // even though subtype is "success"
    const result = await runAgent(MOCK_REPO_CONTEXT, "test query", null);
    // The result text should contain the billing error, not a generic fallback
    expect(result.text).toContain("Credit balance is too low");
  });

  it("prefers descriptive result error over generic process crash message", async () => {
    // Simulate: result with is_error: true, then process crashes
    mockQuery.mockReturnValueOnce(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-err-2" };
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Credit balance is too low",
          total_cost_usd: 0,
          num_turns: 0,
          duration_ms: 100,
          duration_api_ms: 50,
        };
        throw new Error("Claude Code process exited with code 1");
      })(),
    );

    await expect(
      runAgent(MOCK_REPO_CONTEXT, "test query", null),
    ).rejects.toThrow("Credit balance is too low");
  });

  it("still throws generic error when no descriptive result error exists", async () => {
    mockQuery.mockReturnValueOnce(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-err-3" };
        throw new Error("Claude Code process exited with code 1");
      })(),
    );

    await expect(
      runAgent(MOCK_REPO_CONTEXT, "test query", null),
    ).rejects.toThrow("Claude Code process exited with code 1");
  });
});

// ============================================================
// buildActivitySummary tests
// ============================================================

describe("buildActivitySummary", () => {
  function logEntry(
    type: string,
    summary: string,
    content?: any[],
  ): AgentLogEntry {
    return {
      timestamp: Date.now(),
      type,
      summary,
      data: content ? { content } : {},
    };
  }

  it("shows new entries since last snapshot", () => {
    const log: AgentLogEntry[] = [
      logEntry("system", "Session initialized"),
      logEntry("assistant", "Tools: Read(/src/index.ts)", [
        { type: "tool_use", name: "Read" },
      ]),
      logEntry("user", "Tool results: tu-1"),
    ];

    const result = buildActivitySummary(log, 1, 20);

    expect(result).toContain("2 new since last update");
    expect(result).toContain("New activity:");
    expect(result).toContain("[assistant]");
    expect(result).toContain("[user]");
  });

  it("reports no new activity when sinceIndex equals log length", () => {
    const log: AgentLogEntry[] = [
      logEntry("system", "Session initialized"),
    ];

    const result = buildActivitySummary(log, 1, 15);

    expect(result).toContain("0 new since last update");
    expect(result).toContain("No new activity since last update");
  });

  it("includes tool call counts across entire log", () => {
    const log: AgentLogEntry[] = [
      logEntry("assistant", "Tools: Read", [
        { type: "tool_use", name: "Read" },
        { type: "tool_use", name: "Read" },
      ]),
      logEntry("assistant", "Tools: Grep", [
        { type: "tool_use", name: "Grep" },
      ]),
    ];

    const result = buildActivitySummary(log, 0, 30);

    expect(result).toContain("Read: 2");
    expect(result).toContain("Grep: 1");
  });

  it("includes elapsed time", () => {
    const result = buildActivitySummary([], 0, 45);
    expect(result).toContain("Elapsed: 45s");
  });
});

// ============================================================
// generateHeartbeatMessage tests
// ============================================================

describe("generateHeartbeatMessage", () => {
  it("returns structured HeartbeatUpdate with emoji, color, text", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":mag:", "color": "#3498db", "text": "Digging through the codebase for answers"}',
        },
      ],
    });

    const result = await generateHeartbeatMessage("Elapsed: 10s\nNo new activity.", []);

    expect(result.update).toEqual({
      emoji: ":mag:",
      color: "#3498db",
      text: "Digging through the codebase for answers",
      stop: false,
    });
    expect(result.usage).not.toBeNull();
  });

  it("builds multi-turn conversation from previous snapshots", async () => {
    const previousSnapshots: HeartbeatSnapshot[] = [
      {
        activitySummary: "Elapsed: 10s\nNew activity: [assistant] Tools: Read",
        update: {
          emoji: ":mag:",
          color: "#3498db",
          text: "Reading some files",
          stop: false,
        },
      },
      {
        activitySummary: "Elapsed: 20s\nNew activity: [assistant] Tools: Grep",
        update: {
          emoji: ":detective:",
          color: "#e67e22",
          text: "Searching for clues",
          stop: false,
        },
      },
    ];

    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":tada:", "color": "#2ecc71", "text": "Found what we needed!"}',
        },
      ],
    });

    await generateHeartbeatMessage("Elapsed: 30s\nNew activity: [assistant] Tools: Bash", previousSnapshots);

    const callArgs = mockCreate.mock.calls[0][0];
    // 2 previous cycles (user + assistant each) + 1 current user = 5 messages
    expect(callArgs.messages).toHaveLength(5);
    expect(callArgs.messages[0].role).toBe("user");
    expect(callArgs.messages[1].role).toBe("assistant");
    expect(callArgs.messages[1].content).toContain(":mag:");
    expect(callArgs.messages[2].role).toBe("user");
    expect(callArgs.messages[3].role).toBe("assistant");
    expect(callArgs.messages[3].content).toContain(":detective:");
    expect(callArgs.messages[4].role).toBe("user");
  });

  it("sends single user message when no previous snapshots", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":hourglass:", "color": "#9b59b6", "text": "Just getting started"}',
        },
      ],
    });

    await generateHeartbeatMessage("Elapsed: 5s\nNo new activity.", []);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0].role).toBe("user");
  });

  it("returns fallback on API error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API down"));

    const result = await generateHeartbeatMessage("Elapsed: 10s", []);

    expect(result.update.emoji).toBe(":hourglass_flowing_sand:");
    expect(result.update.color).toBe("#6c5ce7");
    expect(result.update.text).toBe("Working on it...");
    expect(result.update.stop).toBe(false);
    expect(result.usage).toBeNull();
  });

  it("returns fallback fields when JSON is missing keys", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"text": "Partial response only"}',
        },
      ],
    });

    const result = await generateHeartbeatMessage("Elapsed: 10s", []);

    expect(result.update.emoji).toBe(":hourglass_flowing_sand:");
    expect(result.update.color).toBe("#6c5ce7");
    expect(result.update.text).toBe("Partial response only");
  });

  it("handles code-fenced JSON response", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '```json\n{"emoji": ":rocket:", "color": "#e74c3c", "text": "Blasting off!"}\n```',
        },
      ],
    });

    const result = await generateHeartbeatMessage("Elapsed: 15s", []);

    expect(result.update).toEqual({
      emoji: ":rocket:",
      color: "#e74c3c",
      text: "Blasting off!",
      stop: false,
    });
  });

  it("parses stop: true when orchestrator signals agent is dead", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":skull:", "color": "#e74c3c", "text": "The agent crashed. Try again?", "stop": true}',
        },
      ],
    });

    const result = await generateHeartbeatMessage(
      "Elapsed: 60s\n[error] Process error: Claude Code process exited with code 1",
      [],
    );

    expect(result.update.stop).toBe(true);
    expect(result.update.emoji).toBe(":skull:");
    expect(result.update.text).toContain("crashed");
  });

  it("defaults stop to false when not in response", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":mag:", "color": "#3498db", "text": "Still looking"}',
        },
      ],
    });

    const result = await generateHeartbeatMessage("Elapsed: 10s", []);
    expect(result.update.stop).toBe(false);
  });

  it("returns fallback when API returns empty content array", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [],
    });

    const result = await generateHeartbeatMessage("Elapsed: 10s", []);

    expect(result.update.emoji).toBe(":hourglass_flowing_sand:");
    expect(result.update.color).toBe("#6c5ce7");
    expect(result.update.text).toBe("Working on it...");
    expect(result.update.stop).toBe(false);
    expect(result.usage).toBeNull();
  });
});
