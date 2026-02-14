import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeConfig,
  makeSlackMessage,
  makeSlackThreadReply,
  makeThreadState,
  makeRouterResult,
  makeAgentResponse,
} from "../__tests__/helpers/fixtures.js";
import { createMockWebClient } from "../__tests__/helpers/slack-mock.js";

// --- Mocks (top-level, before dynamic import) ---

const mockConfig = makeConfig();

vi.mock("../config.js", () => ({
  config: mockConfig,
}));

const mockSplitMessage = vi.fn().mockImplementation((text: string) => [text]);

vi.mock("./formatter.js", () => ({
  markdownToSlackMrkdwn: (text: string) => text,
  splitMessage: (...args: unknown[]) => mockSplitMessage(...args),
}));

const mockSwapReaction = vi.fn();
const mockPostErrorAttachment = vi.fn();

vi.mock("./helpers.js", () => ({
  swapReaction: mockSwapReaction,
  postErrorAttachment: mockPostErrorAttachment,
  buildHeartbeatAttachment: vi.fn().mockReturnValue([]),
}));

vi.mock("./heartbeat-manager.js", () => {
  return {
    HeartbeatManager: class MockHeartbeatManager {
      start() {}
      stop() {}
      onStream() {}
      onLogEntry() {}
      latestHeartbeat = { emoji: ":hourglass:", color: "#6c5ce7", text: "Working...", stop: false };
    },
  };
});

const mockRunRouter = vi.fn();
const mockRunAgent = vi.fn();

vi.mock("../agent/agent.js", () => ({
  runRouter: mockRunRouter,
  runAgent: mockRunAgent,
}));

const mockCreateEvent = vi.fn().mockReturnValue({ id: "test-id" });
const mockUpdateEvent = vi.fn();
const mockFindEventByResponseTs = vi.fn();

vi.mock("../dashboard/events.js", () => ({
  createEvent: mockCreateEvent,
  updateEvent: mockUpdateEvent,
  findEventByResponseTs: mockFindEventByResponseTs,
}));

const mockGetOrCreateThread = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockUpdateSessionId = vi.fn();
const mockClearSessionId = vi.fn().mockImplementation((t: { sessionId: string | null }) => {
  t.sessionId = null;
});
const mockIsBotParticipant = vi.fn();

const mockIsRateLimited = vi.fn().mockReturnValue(false);
const mockRecordAgentRun = vi.fn();

vi.mock("./rate-limiter.js", () => ({
  isRateLimited: (...args: unknown[]) => mockIsRateLimited(...args),
  recordAgentRun: (...args: unknown[]) => mockRecordAgentRun(...args),
}));

vi.mock("./user-cache.js", () => ({
  resolveUserName: vi.fn().mockResolvedValue("Test User"),
}));

vi.mock("../threads.js", () => ({
  getOrCreateThread: mockGetOrCreateThread,
  addMessageToThread: mockAddMessageToThread,
  updateSessionId: mockUpdateSessionId,
  clearSessionId: mockClearSessionId,
  isBotParticipant: mockIsBotParticipant,
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockNotifyError = vi.fn().mockResolvedValue(undefined);

vi.mock("../errors/trello-notifier.js", () => ({
  notifyError: (...args: unknown[]) => mockNotifyError(...args),
}));

// Mock @slack/bolt — App must be a real class so `new App()` works
let capturedMessageHandler: Function;
const capturedEventHandlers: Record<string, Function> = {};

vi.mock("@slack/bolt", () => {
  return {
    App: class MockApp {
      client = {
        auth: {
          test: vi.fn().mockResolvedValue({ user_id: "BOT_USER_ID" }),
        },
      };
      message(handler: Function) {
        capturedMessageHandler = handler;
      }
      event(eventName: string, handler: Function) {
        capturedEventHandlers[eventName] = handler;
      }
      async start() {}
    },
  };
});

// Dynamic import after mocks
const { startSlackListener, stopSlackListener, getInFlightPlaceholders, resetListenerState } = await import("./listener.js");

// --- Test setup ---

let handler: (args: { message: Record<string, unknown>; client: ReturnType<typeof createMockWebClient> }) => Promise<void>;
let client: ReturnType<typeof createMockWebClient>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockIsRateLimited.mockReturnValue(false);

  // Reset listener state (shutdown flag and in-flight tracking)
  resetListenerState();

  // Re-register handler each test (startSlackListener calls app.message(handler))
  await startSlackListener();
  handler = capturedMessageHandler as typeof handler;
  client = createMockWebClient();

  // Default: thread setup returns a basic thread state
  mockGetOrCreateThread.mockResolvedValue(makeThreadState());
});

// ============================================================
// Filter tests
// ============================================================

describe("message filters", () => {
  it("ignores messages with a subtype", async () => {
    const message = makeSlackMessage({ subtype: "channel_join" });
    await handler({ message, client });

    expect(mockRunRouter).not.toHaveBeenCalled();
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("ignores messages with no text", async () => {
    const message = makeSlackMessage({ text: undefined });
    await handler({ message, client });

    expect(mockRunRouter).not.toHaveBeenCalled();
  });

  it("ignores messages from bots", async () => {
    const message = makeSlackMessage({ bot_id: "B-BOT" });
    await handler({ message, client });

    expect(mockRunRouter).not.toHaveBeenCalled();
  });

  it("ignores messages from the wrong channel", async () => {
    const message = makeSlackMessage({ channel: "C-OTHER" });
    await handler({ message, client });

    expect(mockRunRouter).not.toHaveBeenCalled();
  });
});

// ============================================================
// Happy paths
// ============================================================

describe("happy paths", () => {
  it("handles router-only response (needsAgent: false)", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Hi there!",
      needsAgent: false,
    });
    mockRunRouter.mockResolvedValue(routerResult);

    await handler({ message: makeSlackMessage(), client });

    // Quick response posted
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hi there!" }),
    );

    // Event marked complete
    expect(mockUpdateEvent).toHaveBeenCalledWith("test-id", { status: "complete" });

    // Agent never called
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("handles router + agent response", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Looking into it...",
      needsAgent: true,
    });
    mockRunRouter.mockResolvedValue(routerResult);

    const agentResponse = makeAgentResponse({ text: "Here is the detailed answer." });
    mockRunAgent.mockResolvedValue(agentResponse);

    await handler({ message: makeSlackMessage(), client });

    // Quick response posted first
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Looking into it..." }),
    );

    // Placeholder posted with attachment
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: " ",
        attachments: expect.any(Array),
      }),
    );

    // Agent was called
    expect(mockRunAgent).toHaveBeenCalledOnce();

    // Placeholder updated with response
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Here is the detailed answer.",
        attachments: [],
      }),
    );

    // Reaction swapped to checkmark
    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      expect.any(String),
      "brain",
      "white_check_mark",
    );

    // Event updated with agent fields
    expect(mockUpdateEvent).toHaveBeenCalledWith(
      "test-id",
      expect.objectContaining({
        status: "complete",
        agentResponse: "Here is the detailed answer.",
      }),
    );

    // Session ID updated
    expect(mockUpdateSessionId).toHaveBeenCalledWith(
      expect.any(Object),
      "sess-test-1",
    );
  });

  it("handles long response split into multiple chunks", async () => {
    const routerResult = makeRouterResult({ needsAgent: true, quickResponse: "On it..." });
    mockRunRouter.mockResolvedValue(routerResult);

    const agentResponse = makeAgentResponse({ text: "Full response text" });
    mockRunAgent.mockResolvedValue(agentResponse);

    // Override splitMessage to return 3 chunks for this test
    mockSplitMessage.mockReturnValueOnce(["chunk1", "chunk2", "chunk3"]);

    await handler({ message: makeSlackMessage(), client });

    // First chunk updates the placeholder
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: "chunk1" }),
    );

    // Remaining chunks posted as new messages
    const postCalls = client.chat.postMessage.mock.calls;
    const chunkPosts = postCalls.filter(
      (call) => call[0].text === "chunk2" || call[0].text === "chunk3",
    );
    expect(chunkPosts).toHaveLength(2);
  });
});

// ============================================================
// Complexity routing
// ============================================================

describe("complexity routing", () => {
  it("uses very_low fast path for very_low complexity", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Looking into it...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);
    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: "Quick answer." }));

    await handler({ message: makeSlackMessage(), client });

    // Agent called with very_low complexity
    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(mockRunAgent.mock.calls[0][5]).toBe("very_low");

    // Placeholder updated with response
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Quick answer.",
        attachments: [],
      }),
    );

    // Reaction swapped to checkmark
    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      expect.any(String),
      "brain",
      "white_check_mark",
    );
  });

  it("escalates to medium when very_low fails", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Looking...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);
    mockRunAgent
      .mockRejectedValueOnce(new Error("Agent crashed"))
      .mockResolvedValueOnce(makeAgentResponse({ text: "Full agent answer." }));

    await handler({ message: makeSlackMessage(), client });

    // First call: very_low, second call: medium (escalated)
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(mockRunAgent.mock.calls[0][5]).toBe("very_low");
    expect(mockRunAgent.mock.calls[1][5]).toBe("medium");

    // Final response from medium agent
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Full agent answer.",
        attachments: [],
      }),
    );
  });

  it("uses full path with heartbeat for low complexity", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Let me check...",
      needsAgent: true,
      complexity: "low",
    });
    mockRunRouter.mockResolvedValue(routerResult);
    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: "Low answer." }));

    await handler({ message: makeSlackMessage(), client });

    // Agent called with low complexity via the full path
    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(mockRunAgent.mock.calls[0][5]).toBe("low");
  });

  it("uses full path with heartbeat for high complexity", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Let me investigate...",
      needsAgent: true,
      complexity: "high",
    });
    mockRunRouter.mockResolvedValue(routerResult);
    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: "Detailed answer." }));

    await handler({ message: makeSlackMessage(), client });

    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(mockRunAgent.mock.calls[0][5]).toBe("high");
  });

  it("passes complexity to runAgent on the full path", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "This will take a moment...",
      needsAgent: true,
      complexity: "very_high",
    });
    mockRunRouter.mockResolvedValue(routerResult);
    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: "Deep answer." }));

    await handler({ message: makeSlackMessage(), client });

    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(mockRunAgent.mock.calls[0][5]).toBe("very_high");
  });

  it("tracks routerComplexity in dashboard events", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Looking...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);
    mockRunAgent.mockResolvedValue(makeAgentResponse());

    await handler({ message: makeSlackMessage(), client });

    expect(mockUpdateEvent).toHaveBeenCalledWith(
      "test-id",
      expect.objectContaining({ routerComplexity: "very_low" }),
    );
  });
});

// ============================================================
// Thread handling
// ============================================================

describe("thread handling", () => {
  it("processes thread reply when bot is participating", async () => {
    mockIsBotParticipant.mockResolvedValue(true);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ quickResponse: "Got it!", needsAgent: false }),
    );

    await handler({ message: makeSlackThreadReply(), client });

    expect(mockIsBotParticipant).toHaveBeenCalledWith("1234567890.000001");
    expect(mockRunRouter).toHaveBeenCalled();
  });

  it("ignores thread reply when bot is NOT participating", async () => {
    mockIsBotParticipant.mockResolvedValue(false);

    await handler({ message: makeSlackThreadReply(), client });

    expect(mockIsBotParticipant).toHaveBeenCalled();
    // Event is created (for tracking) but router is never called
    expect(mockCreateEvent).toHaveBeenCalled();
    expect(mockRunRouter).not.toHaveBeenCalled();
  });
});

// ============================================================
// Error paths
// ============================================================

describe("error paths", () => {
  it("handles agent timeout", async () => {
    // Override config timeout to something fast
    (mockConfig.agent as Record<string, unknown>).timeoutMs = 50;

    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Checking..." }),
    );

    // Agent returns a promise that never resolves
    mockRunAgent.mockReturnValue(new Promise(() => {}));

    await handler({ message: makeSlackMessage(), client });

    // Error attachment posted
    expect(mockPostErrorAttachment).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "mock-ts",
      expect.stringContaining("Timed out"),
    );

    // Reaction swapped to warning
    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      expect.any(String),
      "brain",
      "warning",
    );

    // Event status set to error
    expect(mockUpdateEvent).toHaveBeenCalledWith(
      "test-id",
      expect.objectContaining({ status: "error" }),
    );

    // Trello notifier called with Agent Timeout
    expect(mockNotifyError).toHaveBeenCalledWith(
      "Agent Timeout",
      expect.stringContaining("timed out"),
      expect.objectContaining({
        threadTs: expect.any(String),
        user: "U-HUMAN",
        channelId: "C-TEST",
      }),
    );

    // Restore timeout
    (mockConfig.agent as Record<string, unknown>).timeoutMs = 300000;
  });

  it("handles agent crash (retries exhausted)", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Let me check..." }),
    );
    mockRunAgent.mockRejectedValue(new Error("SDK process died"));

    await handler({ message: makeSlackMessage(), client });

    // Agent called twice (initial + 1 retry, default maxRetries=1)
    expect(mockRunAgent).toHaveBeenCalledTimes(2);

    // Error attachment posted
    expect(mockPostErrorAttachment).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "mock-ts",
      expect.stringContaining("crashed"),
    );

    // Reaction swapped to x
    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      expect.any(String),
      "brain",
      "x",
    );

    // Event status set to error
    expect(mockUpdateEvent).toHaveBeenCalledWith(
      "test-id",
      expect.objectContaining({ status: "error" }),
    );

    // Trello notifier called with Agent Crash
    expect(mockNotifyError).toHaveBeenCalledWith(
      "Agent Crash",
      "SDK process died",
      expect.objectContaining({
        threadTs: expect.any(String),
        user: "U-HUMAN",
        channelId: "C-TEST",
      }),
    );
  });

  it("calls notifyError on top-level handler error", async () => {
    // Make getOrCreateThread throw to trigger the top-level catch
    mockGetOrCreateThread.mockRejectedValue(new Error("Thread DB failure"));

    await handler({ message: makeSlackMessage(), client });

    expect(mockNotifyError).toHaveBeenCalledWith(
      "Handler Error",
      "Thread DB failure",
      expect.objectContaining({
        threadTs: expect.any(String),
        user: "U-HUMAN",
        channelId: "C-TEST",
      }),
    );
  });
});

// ============================================================
// Rate limiting
// ============================================================

describe("rate limiting", () => {
  it("blocks agent run when user is rate limited", async () => {
    mockIsRateLimited.mockReturnValue(true);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );

    await handler({ message: makeSlackMessage(), client });

    // Router quick response still sent
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Looking..." }),
    );

    // Rate limit message sent
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I'm still working on your previous question. I'll get to this one next.",
      }),
    );

    // Agent never called
    expect(mockRunAgent).not.toHaveBeenCalled();

    // Event marked complete (not error)
    expect(mockUpdateEvent).toHaveBeenCalledWith("test-id", { status: "complete" });
  });

  it("does not rate limit router-only responses", async () => {
    mockIsRateLimited.mockReturnValue(true);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: false, quickResponse: "Hi!" }),
    );

    await handler({ message: makeSlackMessage(), client });

    // Quick response posted normally
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hi!" }),
    );

    // isRateLimited should not have been checked since needsAgent is false
    // (the rate limit message should not appear)
    const postCalls = client.chat.postMessage.mock.calls;
    const rateLimitMsgs = postCalls.filter(
      (call) =>
        typeof call[0].text === "string" &&
        call[0].text.includes("still working"),
    );
    expect(rateLimitMsgs).toHaveLength(0);
  });

  it("records agent run when not rate limited", async () => {
    mockIsRateLimited.mockReturnValue(false);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "On it..." }),
    );
    mockRunAgent.mockResolvedValue(makeAgentResponse());

    await handler({ message: makeSlackMessage(), client });

    expect(mockRecordAgentRun).toHaveBeenCalledWith("U-HUMAN");
    expect(mockRunAgent).toHaveBeenCalled();
  });

  it("does not record agent run when rate limited", async () => {
    mockIsRateLimited.mockReturnValue(true);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "On it..." }),
    );

    await handler({ message: makeSlackMessage(), client });

    expect(mockRecordAgentRun).not.toHaveBeenCalled();
  });
});

// ============================================================
// Feedback reactions
// ============================================================

describe("feedback reactions", () => {
  it("stores responseTs after successful agent response", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "On it..." }),
    );
    mockRunAgent.mockResolvedValue(makeAgentResponse());

    await handler({ message: makeSlackMessage(), client });

    expect(mockUpdateEvent).toHaveBeenCalledWith(
      "test-id",
      expect.objectContaining({ responseTs: "mock-ts" }),
    );
  });

  it("adds thumbsup and thumbsdown reactions to agent response", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "On it..." }),
    );
    mockRunAgent.mockResolvedValue(makeAgentResponse());

    await handler({ message: makeSlackMessage(), client });

    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "thumbsup", timestamp: "mock-ts" }),
    );
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "thumbsdown", timestamp: "mock-ts" }),
    );
  });

  it("registers a reaction_added event handler", async () => {
    expect(capturedEventHandlers["reaction_added"]).toBeDefined();
  });

  it("records positive feedback on thumbsup reaction", async () => {
    const reactionHandler = capturedEventHandlers["reaction_added"];
    const mockDashEvent = { id: "dash-1" };
    mockFindEventByResponseTs.mockReturnValue(mockDashEvent);

    await reactionHandler({
      event: {
        reaction: "thumbsup",
        user: "U-HUMAN",
        item: { channel: "C-TEST", ts: "1234.5678" },
      },
    });

    expect(mockFindEventByResponseTs).toHaveBeenCalledWith("1234.5678");
    expect(mockUpdateEvent).toHaveBeenCalledWith("dash-1", { feedback: "positive" });
  });

  it("records negative feedback on thumbsdown reaction", async () => {
    const reactionHandler = capturedEventHandlers["reaction_added"];
    const mockDashEvent = { id: "dash-2" };
    mockFindEventByResponseTs.mockReturnValue(mockDashEvent);

    await reactionHandler({
      event: {
        reaction: "thumbsdown",
        user: "U-HUMAN",
        item: { channel: "C-TEST", ts: "5678.1234" },
      },
    });

    expect(mockUpdateEvent).toHaveBeenCalledWith("dash-2", { feedback: "negative" });
  });

  it("records positive feedback on +1 reaction alias", async () => {
    const reactionHandler = capturedEventHandlers["reaction_added"];
    const mockDashEvent = { id: "dash-alias-pos" };
    mockFindEventByResponseTs.mockReturnValue(mockDashEvent);

    await reactionHandler({
      event: {
        reaction: "+1",
        user: "U-HUMAN",
        item: { channel: "C-TEST", ts: "1234.5678" },
      },
    });

    expect(mockFindEventByResponseTs).toHaveBeenCalledWith("1234.5678");
    expect(mockUpdateEvent).toHaveBeenCalledWith("dash-alias-pos", { feedback: "positive" });
  });

  it("records negative feedback on -1 reaction alias", async () => {
    const reactionHandler = capturedEventHandlers["reaction_added"];
    const mockDashEvent = { id: "dash-alias-neg" };
    mockFindEventByResponseTs.mockReturnValue(mockDashEvent);

    await reactionHandler({
      event: {
        reaction: "-1",
        user: "U-HUMAN",
        item: { channel: "C-TEST", ts: "5678.1234" },
      },
    });

    expect(mockFindEventByResponseTs).toHaveBeenCalledWith("5678.1234");
    expect(mockUpdateEvent).toHaveBeenCalledWith("dash-alias-neg", { feedback: "negative" });
  });

  it("ignores reactions other than thumbsup/thumbsdown", async () => {
    const reactionHandler = capturedEventHandlers["reaction_added"];

    await reactionHandler({
      event: {
        reaction: "heart",
        user: "U-HUMAN",
        item: { channel: "C-TEST", ts: "1234.5678" },
      },
    });

    expect(mockFindEventByResponseTs).not.toHaveBeenCalled();
  });

  it("ignores reactions from wrong channel", async () => {
    const reactionHandler = capturedEventHandlers["reaction_added"];

    await reactionHandler({
      event: {
        reaction: "thumbsup",
        user: "U-HUMAN",
        item: { channel: "C-OTHER", ts: "1234.5678" },
      },
    });

    expect(mockFindEventByResponseTs).not.toHaveBeenCalled();
  });

  it("ignores reactions on unknown messages", async () => {
    const reactionHandler = capturedEventHandlers["reaction_added"];
    mockFindEventByResponseTs.mockReturnValue(undefined);

    await reactionHandler({
      event: {
        reaction: "thumbsup",
        user: "U-HUMAN",
        item: { channel: "C-TEST", ts: "unknown.ts" },
      },
    });

    expect(mockFindEventByResponseTs).toHaveBeenCalledWith("unknown.ts");
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });

  it("ignores bot's own seed reactions", async () => {
    const reactionHandler = capturedEventHandlers["reaction_added"];
    mockFindEventByResponseTs.mockReturnValue({ id: "test-id" });

    await reactionHandler({
      event: {
        reaction: "thumbsup",
        user: "BOT_USER_ID",
        item: { channel: "C-TEST", ts: "response.ts" },
      },
    });

    expect(mockFindEventByResponseTs).not.toHaveBeenCalled();
    expect(mockUpdateEvent).not.toHaveBeenCalled();
  });
});

// ============================================================
// Agent retry on crash
// ============================================================

describe("agent retry on crash", () => {
  beforeEach(() => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );
  });

  it("retries on agent crash and succeeds on second attempt", async () => {
    const agentResponse = makeAgentResponse({ text: "Got it on retry." });
    mockRunAgent
      .mockRejectedValueOnce(new Error("SDK process died"))
      .mockResolvedValueOnce(agentResponse);

    await handler({ message: makeSlackMessage(), client });

    // Agent called twice (initial + 1 retry)
    expect(mockRunAgent).toHaveBeenCalledTimes(2);

    // Placeholder updated with response (not error)
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Got it on retry.",
        attachments: [],
      }),
    );

    // Reaction swapped to checkmark (not x)
    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      expect.any(String),
      "brain",
      "white_check_mark",
    );

    // Dashboard event tracks the retry
    expect(mockUpdateEvent).toHaveBeenCalledWith(
      "test-id",
      expect.objectContaining({
        status: "complete",
        agentRetried: true,
      }),
    );
  });

  it("shows error when retry also fails", async () => {
    mockRunAgent
      .mockRejectedValueOnce(new Error("First crash"))
      .mockRejectedValueOnce(new Error("Second crash"));

    await handler({ message: makeSlackMessage(), client });

    // Agent called twice
    expect(mockRunAgent).toHaveBeenCalledTimes(2);

    // Error attachment posted
    expect(mockPostErrorAttachment).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "mock-ts",
      expect.stringContaining("crashed"),
    );

    // Reaction swapped to x
    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      expect.any(String),
      "brain",
      "x",
    );
  });

  it("does NOT retry on timeout", async () => {
    (mockConfig.agent as Record<string, unknown>).timeoutMs = 50;

    mockRunAgent.mockReturnValue(new Promise(() => {}));

    await handler({ message: makeSlackMessage(), client });

    // Agent called only once
    expect(mockRunAgent).toHaveBeenCalledTimes(1);

    // Timeout error shown
    expect(mockPostErrorAttachment).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "mock-ts",
      expect.stringContaining("Timed out"),
    );

    // Restore timeout
    (mockConfig.agent as Record<string, unknown>).timeoutMs = 300000;
  });

  it("does not retry when maxRetries is 0", async () => {
    (mockConfig.agent as Record<string, unknown>).maxRetries = 0;

    mockRunAgent.mockRejectedValueOnce(new Error("SDK process died"));

    await handler({ message: makeSlackMessage(), client });

    // Agent called only once
    expect(mockRunAgent).toHaveBeenCalledTimes(1);

    // Error shown
    expect(mockPostErrorAttachment).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "mock-ts",
      expect.stringContaining("crashed"),
    );

    // Restore maxRetries
    (mockConfig.agent as Record<string, unknown>).maxRetries = 1;
  });

  it("updates placeholder with retrying text before retry", async () => {
    const agentResponse = makeAgentResponse({ text: "Success on retry." });
    mockRunAgent
      .mockRejectedValueOnce(new Error("Crash"))
      .mockResolvedValueOnce(agentResponse);

    await handler({ message: makeSlackMessage(), client });

    // Placeholder updated with retrying message before the retry
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: "mock-ts",
        text: " ",
        attachments: expect.arrayContaining([
          expect.objectContaining({
            color: "#e17055",
            blocks: expect.arrayContaining([
              expect.objectContaining({
                elements: expect.arrayContaining([
                  expect.objectContaining({
                    text: expect.stringContaining("Retrying"),
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });
});

// ============================================================
// Stale session recovery
// ============================================================

describe("stale session recovery", () => {
  beforeEach(() => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );
  });

  it("clears session ID and retries fresh when 'No conversation found' error occurs", async () => {
    // Thread has a stale session ID
    const thread = makeThreadState({ sessionId: "stale-session-id" });
    mockGetOrCreateThread.mockResolvedValue(thread);

    const agentResponse = makeAgentResponse({ text: "Fresh response." });
    mockRunAgent
      .mockRejectedValueOnce(new Error("No conversation found with session ID: stale-session-id"))
      .mockResolvedValueOnce(agentResponse);

    await handler({ message: makeSlackMessage(), client });

    // Agent called twice (first with stale session, second with null)
    expect(mockRunAgent).toHaveBeenCalledTimes(2);

    // First call had the stale session ID
    expect(mockRunAgent.mock.calls[0][1]).toBe("stale-session-id");

    // Second call had null session ID (fresh conversation)
    expect(mockRunAgent.mock.calls[1][1]).toBeNull();

    // clearSessionId was called to persist the null session
    expect(mockClearSessionId).toHaveBeenCalledWith(thread);

    // Successful response was sent
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Fresh response.",
        attachments: [],
      }),
    );

    // Reaction swapped to checkmark (success, not error)
    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      expect.any(String),
      "brain",
      "white_check_mark",
    );
  });

  it("persists null session ID to disk after session-not-found error", async () => {
    const thread = makeThreadState({ sessionId: "expired-session" });
    mockGetOrCreateThread.mockResolvedValue(thread);

    const agentResponse = makeAgentResponse({ text: "Recovered." });
    mockRunAgent
      .mockRejectedValueOnce(new Error("No conversation found with session ID: expired-session"))
      .mockResolvedValueOnce(agentResponse);

    await handler({ message: makeSlackMessage(), client });

    // clearSessionId persists the null to disk
    expect(mockClearSessionId).toHaveBeenCalledWith(thread);

    // clearSessionId mock sets thread.sessionId = null (line 69-71)
    expect(mockClearSessionId).toHaveBeenCalledTimes(1);
  });

  it("shows error when session recovery also fails", async () => {
    const thread = makeThreadState({ sessionId: "stale-session-id" });
    mockGetOrCreateThread.mockResolvedValue(thread);

    mockRunAgent
      .mockRejectedValueOnce(new Error("No conversation found with session ID: stale-session-id"))
      .mockRejectedValueOnce(new Error("Some other agent error"));

    await handler({ message: makeSlackMessage(), client });

    // Agent called twice
    expect(mockRunAgent).toHaveBeenCalledTimes(2);

    // Session was cleared before retry
    expect(mockClearSessionId).toHaveBeenCalledWith(thread);

    // Error attachment posted after retries exhausted
    expect(mockPostErrorAttachment).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "mock-ts",
      expect.stringContaining("crashed"),
    );
  });
});

// ============================================================
// Shutdown handling
// ============================================================

describe("shutdown handling", () => {
  it("rejects new messages after stopSlackListener is called", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ quickResponse: "Hi!", needsAgent: false }),
    );

    // First message should be processed normally
    await handler({ message: makeSlackMessage(), client });
    expect(mockRunRouter).toHaveBeenCalledOnce();

    // Stop the listener
    stopSlackListener();

    // Second message should be ignored
    vi.clearAllMocks();
    await handler({ message: makeSlackMessage({ ts: "1234567890.000002" }), client });
    expect(mockRunRouter).not.toHaveBeenCalled();
  });

  it("tracks in-flight agent placeholders", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );

    // Create a promise we can control
    let resolveAgent: () => void;
    const agentPromise = new Promise<void>((resolve) => {
      resolveAgent = resolve;
    });
    mockRunAgent.mockReturnValue(agentPromise);

    // Start an agent run (don't await it)
    handler({ message: makeSlackMessage(), client });

    // Wait a tick for async operations to settle
    await new Promise((resolve) => setImmediate(resolve));

    // Check in-flight placeholders
    const placeholders = getInFlightPlaceholders();
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toMatchObject({
      channel: "C-TEST",
      ts: "mock-ts",
      threadTs: expect.any(String),
    });

    // Clean up - resolve the agent to let handler complete
    resolveAgent!();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("removes placeholder from in-flight after agent completes", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );
    mockRunAgent.mockResolvedValue(makeAgentResponse());

    await handler({ message: makeSlackMessage(), client });

    // After completion, in-flight should be empty
    const placeholders = getInFlightPlaceholders();
    expect(placeholders).toHaveLength(0);
  });

  it("removes placeholder from in-flight after agent errors", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );
    mockRunAgent.mockRejectedValue(new Error("Agent crashed"));

    await handler({ message: makeSlackMessage(), client });

    // After error, in-flight should be empty
    const placeholders = getInFlightPlaceholders();
    expect(placeholders).toHaveLength(0);
  });

  it("returns empty array when no agents are in-flight", () => {
    const placeholders = getInFlightPlaceholders();
    expect(placeholders).toEqual([]);
  });
});
