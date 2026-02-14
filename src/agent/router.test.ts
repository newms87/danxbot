import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ThreadMessage } from "../types.js";

// --- Mocks (must be before dynamic import) ---

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

vi.mock("../config.js", () => ({
  config: {
    anthropic: { apiKey: "test-key" },
    agent: { maxThreadMessages: 20 },
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

const { buildConversationMessages, runRouter } = await import("./router.js");

// --- Helpers ---

function msg(
  text: string,
  isBot: boolean,
  user = isBot ? "flytebot" : "U123",
): ThreadMessage {
  return { user, text, ts: Date.now().toString(), isBot };
}

function mockRouterResponse(json: Record<string, unknown>) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: "text", text: JSON.stringify(json) }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// buildConversationMessages
// ============================================================

describe("buildConversationMessages", () => {
  it("returns empty array for empty input", () => {
    expect(buildConversationMessages([])).toEqual([]);
  });

  it("converts a single user message", () => {
    const result = buildConversationMessages([msg("hello", false)]);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("converts alternating user/bot messages", () => {
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

  it("merges consecutive same-role user messages with newline", () => {
    const result = buildConversationMessages([
      msg("first", false),
      msg("second", false),
    ]);

    expect(result).toEqual([{ role: "user", content: "first\nsecond" }]);
  });

  it("merges consecutive bot messages with newline", () => {
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

  it("strips leading assistant message", () => {
    const result = buildConversationMessages([
      msg("bot intro", true),
      msg("user reply", false),
    ]);

    expect(result).toEqual([{ role: "user", content: "user reply" }]);
  });

  it("handles long alternating thread without role violations", () => {
    const thread: ThreadMessage[] = [
      msg("q1", false),
      msg("a1", true),
      msg("q2", false),
      msg("a2", true),
      msg("q3", false),
    ];

    const result = buildConversationMessages(thread);

    expect(result).toHaveLength(5);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].role).not.toBe(result[i - 1].role);
    }
  });
});

// ============================================================
// runRouter
// ============================================================

describe("runRouter", () => {
  it("uses single message when no thread history provided", async () => {
    mockRouterResponse({
      quickResponse: "Hi!",
      needsAgent: false,
      reason: "greeting",
    });

    await runRouter("hello");

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("uses single message when thread has only 1 message", async () => {
    mockRouterResponse({
      quickResponse: "Hi!",
      needsAgent: false,
      reason: "greeting",
    });

    await runRouter("hello", [msg("hello", false)]);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("uses multi-turn messages when thread has >1 messages", async () => {
    mockRouterResponse({
      quickResponse: "Looking into it...",
      needsAgent: true,
      reason: "code question",
    });

    const thread = [
      msg("How does auth work?", false),
      msg("Auth uses JWT tokens.", true),
      msg("Can you show me?", false),
    ];

    await runRouter("Can you show me?", thread);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(3);
    expect(callArgs.messages[0].role).toBe("user");
    expect(callArgs.messages[1].role).toBe("assistant");
    expect(callArgs.messages[2].role).toBe("user");
  });

  it("parses successful JSON response into RouterResult", async () => {
    mockRouterResponse({
      quickResponse: "Hello there!",
      needsAgent: false,
      reason: "simple greeting",
    });

    const result = await runRouter("hi");

    expect(result.quickResponse).toBe("Hello there!");
    expect(result.needsAgent).toBe(false);
    expect(result.reason).toBe("simple greeting");
  });

  it("includes request and rawResponse in successful result", async () => {
    mockRouterResponse({
      quickResponse: "Hi!",
      needsAgent: false,
      reason: "greeting",
    });

    const result = await runRouter("hi");

    expect(result.request).toBeDefined();
    expect(result.request).toHaveProperty("model");
    expect(result.request).toHaveProperty("system");
    expect(result.request).toHaveProperty("messages");
    expect(result.rawResponse).toBeDefined();
  });

  it("handles code-fenced JSON response", async () => {
    mockCreate.mockResolvedValueOnce({
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

    expect(result.quickResponse).toBe(
      "I'm having a moment — give me a sec and try again.",
    );
    expect(result.needsAgent).toBe(true);
    expect(result.reason).toBe("router error");
  });

  it("returns error fallback on malformed (non-JSON) response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "This is not JSON at all, just some random text.",
        },
      ],
    });

    const result = await runRouter("hello");

    expect(result.quickResponse).toBe(
      "I'm having a moment — give me a sec and try again.",
    );
    expect(result.needsAgent).toBe(true);
    expect(result.reason).toBe("router error");
  });

  it("coerces missing fields to safe defaults", async () => {
    mockRouterResponse({});

    const result = await runRouter("hi");

    expect(result.quickResponse).toBe("");
    expect(result.needsAgent).toBe(false);
    expect(result.complexity).toBe("simple");
    expect(result.reason).toBe("");
  });

  it("returns complexity from router response", async () => {
    mockRouterResponse({
      quickResponse: "Looking into it...",
      needsAgent: true,
      complexity: "simple",
      reason: "data lookup",
    });

    const result = await runRouter("show me recent campaigns");

    expect(result.complexity).toBe("simple");
  });

  it("returns complex complexity from router response", async () => {
    mockRouterResponse({
      quickResponse: "Let me investigate...",
      needsAgent: true,
      complexity: "complex",
      reason: "multi-step reasoning",
    });

    const result = await runRouter("how does campaign status lifecycle work?");

    expect(result.complexity).toBe("complex");
  });

  it("defaults complexity to simple when not provided", async () => {
    mockRouterResponse({
      quickResponse: "hi",
      needsAgent: false,
      reason: "greeting",
    });

    const result = await runRouter("hi");

    expect(result.complexity).toBe("simple");
  });

  it("defaults complexity to complex on router error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"));

    const result = await runRouter("hello");

    expect(result.complexity).toBe("complex");
  });

  it("only sets needsAgent true when value is strictly true", async () => {
    mockRouterResponse({
      quickResponse: "hi",
      needsAgent: "yes",
      reason: "truthy string",
    });

    const result = await runRouter("hi");

    // "yes" is truthy but not === true, so needsAgent should be false
    expect(result.needsAgent).toBe(false);
  });

  it("passes HAIKU_MODEL to Anthropic API", async () => {
    mockRouterResponse({
      quickResponse: "hi",
      needsAgent: false,
      reason: "test",
    });

    await runRouter("hi");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
  });

  it("sets max_tokens to 256", async () => {
    mockRouterResponse({
      quickResponse: "hi",
      needsAgent: false,
      reason: "test",
    });

    await runRouter("hi");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.max_tokens).toBe(256);
  });

  it("includes system prompt in request", async () => {
    mockRouterResponse({
      quickResponse: "hi",
      needsAgent: false,
      reason: "test",
    });

    await runRouter("hi");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toBeDefined();
    expect(typeof callArgs.system).toBe("string");
    expect(callArgs.system.length).toBeGreaterThan(0);
  });

  it("includes feature list in system prompt", async () => {
    mockRouterResponse({
      quickResponse: "hi",
      needsAgent: false,
      reason: "test",
    });

    await runRouter("hi");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("Data Lookups");
    expect(callArgs.system).toContain("Platform Knowledge");
    expect(callArgs.system).toContain("Database Queries");
  });

  it("includes example questions in system prompt", async () => {
    mockRouterResponse({
      quickResponse: "hi",
      needsAgent: false,
      reason: "test",
    });

    await runRouter("hi");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("How many active campaigns");
    expect(callArgs.system).toContain("Example questions");
  });
});
