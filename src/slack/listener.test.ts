import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeConfig,
  makeRepoContext,
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
      getApiCalls() { return []; }
      getSnapshots() { return []; }
      latestHeartbeat = { emoji: ":hourglass:", color: "#6c5ce7", text: "Working...", stop: false };
    },
  };
});

const mockRunRouter = vi.fn();
const mockRunAgent = vi.fn();

vi.mock("../agent/router.js", () => ({
  runRouter: mockRunRouter,
}));

vi.mock("../agent/agent.js", () => ({
  runAgent: mockRunAgent,
}));

const mockProcessResponseWithAttachments = vi.fn().mockImplementation((text: string) => Promise.resolve({ text, attachments: [] }));
const mockExtractSqlBlocks = vi.fn().mockReturnValue([]);

vi.mock("../agent/sql-executor.js", () => ({
  processResponseWithAttachments: (...args: unknown[]) => mockProcessResponseWithAttachments(...args),
  extractSqlBlocks: (...args: unknown[]) => mockExtractSqlBlocks(...args),
}));

const mockGetOrCreateThread = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockUpdateSessionId = vi.fn();
const mockClearSessionId = vi.fn().mockImplementation((t: { sessionId: string | null }) => {
  t.sessionId = null;
});
const mockIsBotParticipant = vi.fn();

const mockIsProcessing = vi.fn().mockReturnValue(false);
const mockMarkProcessing = vi.fn();
const mockMarkIdle = vi.fn();
const mockEnqueue = vi.fn();
const mockDequeue = vi.fn().mockReturnValue(undefined);
const mockResetQueue = vi.fn();
const mockGetQueueStats = vi.fn().mockReturnValue({});
const mockGetTotalQueuedCount = vi.fn().mockReturnValue(0);

vi.mock("./message-queue.js", () => ({
  isProcessing: (...args: unknown[]) => mockIsProcessing(...args),
  markProcessing: (...args: unknown[]) => mockMarkProcessing(...args),
  markIdle: (...args: unknown[]) => mockMarkIdle(...args),
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  dequeue: (...args: unknown[]) => mockDequeue(...args),
  resetQueue: (...args: unknown[]) => mockResetQueue(...args),
  getQueueStats: (...args: unknown[]) => mockGetQueueStats(...args),
  getTotalQueuedCount: (...args: unknown[]) => mockGetTotalQueuedCount(...args),
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

const mockInsertDispatch = vi.fn().mockResolvedValue(undefined);
const mockUpdateDispatch = vi.fn().mockResolvedValue(undefined);

vi.mock("../dashboard/dispatches-db.js", () => ({
  insertDispatch: (...args: unknown[]) => mockInsertDispatch(...args),
  updateDispatch: (...args: unknown[]) => mockUpdateDispatch(...args),
}));

const mockGetDanxbotCommit = vi.fn().mockReturnValue("abc1234");

vi.mock("../agent/danxbot-commit.js", () => ({
  getDanxbotCommit: () => mockGetDanxbotCommit(),
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
  mockIsProcessing.mockReturnValue(false);
  mockDequeue.mockReturnValue(undefined);
  mockProcessResponseWithAttachments.mockImplementation((text: string) => Promise.resolve({ text, attachments: [] }));
  mockExtractSqlBlocks.mockReturnValue([]);

  // Reset listener state (shutdown flag and in-flight tracking)
  resetListenerState();

  // Re-register handler each test (startSlackListener calls app.message(handler))
  await startSlackListener(makeRepoContext());
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
    expect(mockRunAgent.mock.calls[0][6]).toBe("very_low");

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
    expect(mockRunAgent.mock.calls[0][6]).toBe("very_low");
    expect(mockRunAgent.mock.calls[1][6]).toBe("medium");

    // Final response from medium agent
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Full agent answer.",
        attachments: [],
      }),
    );

    // Session NOT cleared for generic errors (only msg_too_long triggers clearing)
    expect(mockClearSessionId).not.toHaveBeenCalled();
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
    expect(mockRunAgent.mock.calls[0][6]).toBe("low");
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
    expect(mockRunAgent.mock.calls[0][6]).toBe("high");
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
    expect(mockRunAgent.mock.calls[0][6]).toBe("very_high");
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

    // Trello notifier called with Agent Timeout
    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.any(Object),
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

    // Trello notifier called with Agent Crash
    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.any(Object),
      "Agent Crash",
      "SDK process died",
      expect.objectContaining({
        threadTs: expect.any(String),
        user: "U-HUMAN",
        channelId: "C-TEST",
      }),
    );
  });

  it("handles router error (error field set)", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "I'm having a moment — give me a sec and try again.",
      needsAgent: false,
      error: "credit balance is too low",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    await handler({ message: makeSlackMessage(), client });

    // Quick response still sent to user
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I'm having a moment — give me a sec and try again.",
      }),
    );

    // :x: reaction added
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
    );

    // Trello notifier called
    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.any(Object),
      "Router Error",
      "credit balance is too low",
      expect.objectContaining({
        threadTs: expect.any(String),
        user: "U-HUMAN",
        channelId: "C-TEST",
      }),
    );

    // Agent never called
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("routes operational router errors to Needs Help list", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "I'm temporarily unavailable due to a service configuration issue. The team has been notified.",
      needsAgent: false,
      error: "credit balance is too low",
      isOperational: true,
    });
    mockRunRouter.mockResolvedValue(routerResult);

    await handler({ message: makeSlackMessage(), client });

    // notifyError called with Needs Help overrides
    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.any(Object),
      "Router Error",
      "credit balance is too low",
      expect.objectContaining({
        threadTs: expect.any(String),
        user: "U-HUMAN",
        channelId: "C-TEST",
      }),
      {
        listId: "test-needs-help-list-id",
        labelId: "test-needs-help-label-id",
      },
    );
  });

  it("routes non-operational router errors to default list (no overrides)", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "I'm having a moment — give me a sec and try again.",
      needsAgent: false,
      error: "API rate limit exceeded",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    await handler({ message: makeSlackMessage(), client });

    // notifyError called WITHOUT overrides (3 args, no 4th)
    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.any(Object),
      "Router Error",
      "API rate limit exceeded",
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
      expect.any(Object),
      "Handler Error",
      "Thread DB failure",
      expect.objectContaining({
        threadTs: expect.any(String),
        user: "U-HUMAN",
        channelId: "C-TEST",
      }),
    );
  });

  it("does not call notifyError for transient ETIMEDOUT handler errors", async () => {
    mockGetOrCreateThread.mockRejectedValue(new Error("connect ETIMEDOUT"));

    await handler({ message: makeSlackMessage(), client });

    expect(mockNotifyError).not.toHaveBeenCalled();
    // Still adds :x: reaction so the user sees failure
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
    );
  });

  it("does not call notifyError for transient ECONNREFUSED handler errors", async () => {
    mockGetOrCreateThread.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:3306"));

    await handler({ message: makeSlackMessage(), client });

    expect(mockNotifyError).not.toHaveBeenCalled();
  });

  it("does not call notifyError for transient ENOTFOUND handler errors", async () => {
    mockGetOrCreateThread.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.anthropic.com"));

    await handler({ message: makeSlackMessage(), client });

    expect(mockNotifyError).not.toHaveBeenCalled();
  });

  it("does not call notifyError when agent crashes with a transient network error", async () => {
    mockRunRouter.mockResolvedValue(makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }));
    mockRunAgent.mockRejectedValue(new Error("connect ETIMEDOUT 1.2.3.4:443"));

    await handler({ message: makeSlackMessage(), client });

    expect(mockNotifyError).not.toHaveBeenCalled();
  });

  it("calls notifyError when agent crashes with a non-transient error", async () => {
    mockRunRouter.mockResolvedValue(makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }));
    mockRunAgent.mockRejectedValue(new Error("Internal server error"));

    await handler({ message: makeSlackMessage(), client });

    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.any(Object),
      "Agent Crash",
      "Internal server error",
      expect.any(Object),
    );
  });
});

// ============================================================
// Message queue
// ============================================================

describe("message queue", () => {
  it("queues message when thread is already processing", async () => {
    mockIsProcessing.mockReturnValue(true);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );

    await handler({ message: makeSlackMessage(), client });

    // Router quick response still sent
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Looking..." }),
    );

    // Queue acknowledgement sent
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I'll get to this after your current question.",
      }),
    );

    // Message enqueued
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        threadTs: expect.any(String),
        userId: "U-HUMAN",
        text: "Hello danxbot",
      }),
    );

    // Agent never called
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("does not queue router-only responses", async () => {
    mockIsProcessing.mockReturnValue(true);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: false, quickResponse: "Hi!" }),
    );

    await handler({ message: makeSlackMessage(), client });

    // Quick response posted normally
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hi!" }),
    );

    // No queue acknowledgement
    const postCalls = client.chat.postMessage.mock.calls;
    const queueMsgs = postCalls.filter(
      (call) =>
        typeof call[0].text === "string" &&
        call[0].text.includes("after your current question"),
    );
    expect(queueMsgs).toHaveLength(0);

    // Nothing enqueued
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("marks thread as processing when starting agent", async () => {
    mockIsProcessing.mockReturnValue(false);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "On it..." }),
    );
    mockRunAgent.mockResolvedValue(makeAgentResponse());

    await handler({ message: makeSlackMessage(), client });

    expect(mockMarkProcessing).toHaveBeenCalledWith(expect.any(String));
    expect(mockRunAgent).toHaveBeenCalled();
  });

  it("marks thread as idle and drains queue after agent completes", async () => {
    mockIsProcessing.mockReturnValue(false);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "On it..." }),
    );
    mockRunAgent.mockResolvedValue(makeAgentResponse());

    await handler({ message: makeSlackMessage(), client });

    expect(mockMarkIdle).toHaveBeenCalledWith(expect.any(String));
    expect(mockDequeue).toHaveBeenCalledWith(expect.any(String));
  });

  it("marks thread as idle after agent error", async () => {
    mockIsProcessing.mockReturnValue(false);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "On it..." }),
    );
    mockRunAgent.mockRejectedValue(new Error("Agent crashed"));

    await handler({ message: makeSlackMessage(), client });

    expect(mockMarkIdle).toHaveBeenCalledWith(expect.any(String));
  });

  it("marks thread as idle after very_low agent succeeds", async () => {
    mockIsProcessing.mockReturnValue(false);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Quick...", complexity: "very_low" }),
    );
    mockRunAgent.mockResolvedValue(makeAgentResponse());

    await handler({ message: makeSlackMessage(), client });

    expect(mockMarkIdle).toHaveBeenCalledWith(expect.any(String));
    expect(mockDequeue).toHaveBeenCalledWith(expect.any(String));
  });
});

// ============================================================
// Feedback reactions
// ============================================================

describe("feedback reactions", () => {

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

    // Thread marked idle even on timeout
    expect(mockMarkIdle).toHaveBeenCalledWith(expect.any(String));

    // Restore timeout
    (mockConfig.agent as Record<string, unknown>).timeoutMs = 300000;
  });

  it("does not retry billing/credit errors (non-retryable)", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("Credit balance is too low"));

    await handler({ message: makeSlackMessage(), client });

    // Agent called only once — billing errors should not be retried
    expect(mockRunAgent).toHaveBeenCalledTimes(1);

    // Error attachment posted immediately
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

  it("does not retry billing_error pattern", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("billing_error: insufficient funds"));

    await handler({ message: makeSlackMessage(), client });

    // Agent called only once
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
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
    expect(mockRunAgent.mock.calls[0][2]).toBe("stale-session-id");

    // Second call had null session ID (fresh conversation)
    expect(mockRunAgent.mock.calls[1][2]).toBeNull();

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

  it("clears session ID and retries fresh when msg_too_long error occurs", async () => {
    const thread = makeThreadState({ sessionId: "long-session-id" });
    mockGetOrCreateThread.mockResolvedValue(thread);

    const agentResponse = makeAgentResponse({ text: "Fresh response after msg_too_long." });
    mockRunAgent
      .mockRejectedValueOnce(new Error("An API error occurred: msg_too_long"))
      .mockResolvedValueOnce(agentResponse);

    await handler({ message: makeSlackMessage(), client });

    // Agent called twice (first with long session, second with null)
    expect(mockRunAgent).toHaveBeenCalledTimes(2);

    // First call had the session ID
    expect(mockRunAgent.mock.calls[0][2]).toBe("long-session-id");

    // Second call had null session ID (fresh conversation)
    expect(mockRunAgent.mock.calls[1][2]).toBeNull();

    // clearSessionId was called to persist the null session
    expect(mockClearSessionId).toHaveBeenCalledWith(thread);

    // Successful response was sent
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Fresh response after msg_too_long.",
        attachments: [],
      }),
    );
  });

  it("clears session ID in very_low path before escalating to medium on msg_too_long", async () => {
    const thread = makeThreadState({ sessionId: "long-session-id" });
    mockGetOrCreateThread.mockResolvedValue(thread);

    const routerResult = makeRouterResult({
      quickResponse: "Looking...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    const agentResponse = makeAgentResponse({ text: "Recovered via medium." });
    mockRunAgent
      .mockRejectedValueOnce(new Error("An API error occurred: msg_too_long"))
      .mockResolvedValueOnce(agentResponse);

    await handler({ message: makeSlackMessage(), client });

    // Session was cleared before escalation
    expect(mockClearSessionId).toHaveBeenCalledWith(thread);

    // Agent called twice: first very_low (failed), then medium (succeeded)
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(mockRunAgent.mock.calls[0][6]).toBe("very_low");
    expect(mockRunAgent.mock.calls[1][6]).toBe("medium");

    // Second call had null session ID
    expect(mockRunAgent.mock.calls[1][2]).toBeNull();
  });

  it("shows error when msg_too_long retry also fails", async () => {
    const thread = makeThreadState({ sessionId: "long-session-id" });
    mockGetOrCreateThread.mockResolvedValue(thread);

    mockRunAgent
      .mockRejectedValueOnce(new Error("An API error occurred: msg_too_long"))
      .mockRejectedValueOnce(new Error("Still too long"));

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

  it("handles msg_too_long gracefully when no session exists", async () => {
    const thread = makeThreadState({ sessionId: null });
    mockGetOrCreateThread.mockResolvedValue(thread);

    const agentResponse = makeAgentResponse({ text: "Recovered." });
    mockRunAgent
      .mockRejectedValueOnce(new Error("An API error occurred: msg_too_long"))
      .mockResolvedValueOnce(agentResponse);

    await handler({ message: makeSlackMessage(), client });

    // clearSessionId called (no-op when already null, but safe)
    expect(mockClearSessionId).toHaveBeenCalledWith(thread);

    // Retry succeeded
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Recovered.",
        attachments: [],
      }),
    );
  });

  it("shows error when very_low msg_too_long escalation to medium also fails", async () => {
    const thread = makeThreadState({ sessionId: "long-session-id" });
    mockGetOrCreateThread.mockResolvedValue(thread);

    const routerResult = makeRouterResult({
      quickResponse: "Looking...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    mockRunAgent
      .mockRejectedValueOnce(new Error("An API error occurred: msg_too_long"))
      .mockRejectedValueOnce(new Error("Medium also failed"))
      .mockRejectedValueOnce(new Error("Medium retry also failed"));

    await handler({ message: makeSlackMessage(), client });

    // Session cleared on very_low failure
    expect(mockClearSessionId).toHaveBeenCalledWith(thread);

    // very_low (1) + medium attempts (2) = 3 total calls
    expect(mockRunAgent).toHaveBeenCalledTimes(3);
    expect(mockRunAgent.mock.calls[0][6]).toBe("very_low");
    expect(mockRunAgent.mock.calls[1][6]).toBe("medium");

    // Error surfaced after medium retries exhausted
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

// ============================================================
// Usage collection across all flows
// ============================================================


// ============================================================
// SQL processing in agent responses
// ============================================================

describe("SQL processing in agent responses", () => {
  it("processes SQL blocks in very_low agent response before sending to Slack", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Quick...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    const responseWithSql = "Here are the results:\n```sql:execute\nSELECT * FROM users\n```";
    const processedText = "Here are the results:\n| id | name |\n|---|---|\n| 1 | Alice |";
    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: responseWithSql }));
    mockProcessResponseWithAttachments.mockResolvedValue({ text: processedText, attachments: [] });

    await handler({ message: makeSlackMessage(), client });

    // processResponseWithAttachments was called with the raw agent response
    expect(mockProcessResponseWithAttachments).toHaveBeenCalledWith(responseWithSql);

    // Slack received the processed text (not raw SQL blocks)
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: processedText,
        attachments: [],
      }),
    );
  });

  it("processes SQL blocks in full agent path response before sending to Slack", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Looking...",
      needsAgent: true,
      complexity: "high",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    const responseWithSql = "Results:\n```sql:execute\nSELECT count(*) FROM orders\n```";
    const processedText = "Results:\n| count(*) |\n|---|\n| 42 |";
    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: responseWithSql }));
    mockProcessResponseWithAttachments.mockResolvedValue({ text: processedText, attachments: [] });

    await handler({ message: makeSlackMessage(), client });

    expect(mockProcessResponseWithAttachments).toHaveBeenCalledWith(responseWithSql);

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: processedText,
        attachments: [],
      }),
    );
  });

  it("falls back to raw response text when SQL processing fails (very_low path)", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Quick...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    const rawText = "Here is some text with ```sql:execute\nSELECT 1\n```";
    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: rawText }));
    mockProcessResponseWithAttachments.mockRejectedValue(new Error("DB connection failed"));

    await handler({ message: makeSlackMessage(), client });

    // Should fall back to raw text, not crash
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: rawText,
        attachments: [],
      }),
    );
  });

  it("falls back to raw response text when SQL processing fails (full agent path)", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Looking...",
      needsAgent: true,
      complexity: "high",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    const rawText = "Text with ```sql:execute\nSELECT 1\n```";
    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: rawText }));
    mockProcessResponseWithAttachments.mockRejectedValue(new Error("DB connection failed"));

    await handler({ message: makeSlackMessage(), client });

    // Should fall back to raw text, not crash
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: rawText,
        attachments: [],
      }),
    );
  });

});

describe("CSV file upload for SQL results", () => {
  it("uploads CSV attachments in very_low path", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Quick...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: "results" }));
    mockProcessResponseWithAttachments.mockResolvedValue({
      text: "| id |\n|---|\n| 1 |",
      attachments: [
        { csv: "id\n1", filename: "query-result-123-1.csv", query: "SELECT id FROM users" },
      ],
    });

    await handler({ message: makeSlackMessage(), client });

    expect(client.filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C-TEST",
        filename: "query-result-123-1.csv",
        content: "id\n1",
      }),
    );
  });

  it("uploads CSV attachments in full agent path", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Looking...",
      needsAgent: true,
      complexity: "high",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: "results" }));
    mockProcessResponseWithAttachments.mockResolvedValue({
      text: "| id |\n|---|\n| 1 |",
      attachments: [
        { csv: "id\n1", filename: "query-result-456-1.csv", query: "SELECT id FROM users" },
      ],
    });

    await handler({ message: makeSlackMessage(), client });

    expect(client.filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C-TEST",
        filename: "query-result-456-1.csv",
        content: "id\n1",
      }),
    );
  });

  it("uploads multiple CSV files for multiple SQL blocks", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Quick...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: "results" }));
    mockProcessResponseWithAttachments.mockResolvedValue({
      text: "table1\ntable2",
      attachments: [
        { csv: "id\n1", filename: "query-result-1.csv", query: "SELECT 1" },
        { csv: "id\n2", filename: "query-result-2.csv", query: "SELECT 2" },
      ],
    });

    await handler({ message: makeSlackMessage(), client });

    expect(client.filesUploadV2).toHaveBeenCalledTimes(2);
  });

  it("does not call filesUploadV2 when no attachments", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Quick...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: "no sql here" }));
    mockProcessResponseWithAttachments.mockResolvedValue({
      text: "no sql here",
      attachments: [],
    });

    await handler({ message: makeSlackMessage(), client });

    expect(client.filesUploadV2).not.toHaveBeenCalled();
  });

  it("continues gracefully when CSV upload fails", async () => {
    const routerResult = makeRouterResult({
      quickResponse: "Quick...",
      needsAgent: true,
      complexity: "very_low",
    });
    mockRunRouter.mockResolvedValue(routerResult);

    mockRunAgent.mockResolvedValue(makeAgentResponse({ text: "results" }));
    mockProcessResponseWithAttachments.mockResolvedValue({
      text: "| id |\n|---|\n| 1 |",
      attachments: [
        { csv: "id\n1", filename: "query-result-1.csv", query: "SELECT 1" },
      ],
    });
    client.filesUploadV2.mockRejectedValueOnce(new Error("Upload failed"));

    await handler({ message: makeSlackMessage(), client });

    // Should still complete the response (chat.update called)
    expect(client.chat.update).toHaveBeenCalled();
  });
});

// ============================================================
// Dispatch row lifecycle (insertDispatch / updateDispatch wiring)
// ============================================================

describe("dispatch row lifecycle", () => {
  const sampleUsage = {
    totalCostUsd: 0.05,
    durationMs: 1000,
    durationApiMs: 800,
    numTurns: 2,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadInputTokens: 50,
    cacheCreationInputTokens: 25,
    costUsd: 0.05,
    modelUsage: {},
  };

  const sampleLog = [
    {
      timestamp: Date.now(),
      type: "assistant",
      summary: "",
      data: {
        content: [
          { type: "tool_use", name: "Read" },
          { type: "tool_use", name: "Task" },
          { type: "text", text: "Hello" },
        ],
      },
    },
  ];

  it("inserts a slack dispatch row and finalizes completed on the very_low fast path", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({
        quickResponse: "Quick...",
        needsAgent: true,
        complexity: "very_low",
      }),
    );
    mockRunAgent.mockResolvedValue(
      makeAgentResponse({
        text: "Quick answer.",
        usage: sampleUsage,
        log: sampleLog,
      }),
    );

    await handler({ message: makeSlackMessage(), client });

    // Insert: one slack-trigger row in "running" state with full metadata
    expect(mockInsertDispatch).toHaveBeenCalledTimes(1);
    const row = mockInsertDispatch.mock.calls[0][0];
    expect(row).toMatchObject({
      repoName: "test-repo",
      trigger: "slack",
      status: "running",
      triggerMetadata: {
        channelId: "C-TEST",
        threadTs: "1234567890.000100",
        messageTs: "1234567890.000100",
        user: "U-HUMAN",
        userName: null,
        messageText: "Hello danxbot",
      },
      danxbotCommit: "abc1234",
    });
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);

    // Finalize: status=completed + session + summary + tokens + tool counts
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    const [finalizeId, finalizeFields] = mockUpdateDispatch.mock.calls[0];
    expect(finalizeId).toBe(row.id);
    expect(finalizeFields).toMatchObject({
      status: "completed",
      sessionUuid: "sess-test-1",
      summary: "Quick answer.",
      error: null,
      tokensIn: 100,
      tokensOut: 200,
      cacheRead: 50,
      cacheWrite: 25,
      tokensTotal: 375,
      toolCallCount: 2,
      subagentCount: 1,
    });
    expect(typeof finalizeFields.completedAt).toBe("number");
    expect(finalizeFields.completedAt).toBeGreaterThanOrEqual(row.startedAt);
  });

  it("inserts a slack dispatch row and finalizes completed on the full path (medium complexity)", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({
        quickResponse: "Looking...",
        needsAgent: true,
        complexity: "medium",
      }),
    );
    mockRunAgent.mockResolvedValue(
      makeAgentResponse({
        text: "Medium answer.",
        usage: sampleUsage,
        log: sampleLog,
      }),
    );

    await handler({ message: makeSlackMessage(), client });

    expect(mockInsertDispatch).toHaveBeenCalledTimes(1);
    expect(mockInsertDispatch.mock.calls[0][0]).toMatchObject({
      trigger: "slack",
      status: "running",
      triggerMetadata: expect.objectContaining({
        channelId: "C-TEST",
        user: "U-HUMAN",
        messageText: "Hello danxbot",
      }),
    });

    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch.mock.calls[0][1]).toMatchObject({
      status: "completed",
      sessionUuid: "sess-test-1",
      summary: "Medium answer.",
      tokensIn: 100,
      tokensOut: 200,
      cacheRead: 50,
      cacheWrite: 25,
      tokensTotal: 375,
      toolCallCount: 2,
      subagentCount: 1,
    });
  });

  it("finalizes failed with a 'timed out' error when the agent times out", async () => {
    (mockConfig.agent as Record<string, unknown>).timeoutMs = 50;

    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Checking..." }),
    );
    // Agent never resolves — timeout race wins
    mockRunAgent.mockReturnValue(new Promise(() => {}));

    await handler({ message: makeSlackMessage(), client });

    expect(mockInsertDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);

    const [, fields] = mockUpdateDispatch.mock.calls[0];
    expect(fields).toMatchObject({
      status: "failed",
      sessionUuid: null,
      summary: null,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokensTotal: 0,
      toolCallCount: 0,
      subagentCount: 0,
    });
    expect(fields.error).toContain("timed out");

    (mockConfig.agent as Record<string, unknown>).timeoutMs = 300000;
  });

  it("finalizes failed with the last error message when retries are exhausted", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );
    mockRunAgent
      .mockRejectedValueOnce(new Error("first crash"))
      .mockRejectedValueOnce(new Error("final crash"));

    await handler({ message: makeSlackMessage(), client });

    expect(mockInsertDispatch).toHaveBeenCalledTimes(1);

    // Finalize runs once — only on the terminal failure, not per retry attempt
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch.mock.calls[0][1]).toMatchObject({
      status: "failed",
      error: "final crash",
      sessionUuid: null,
      summary: null,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokensTotal: 0,
      toolCallCount: 0,
      subagentCount: 0,
    });
  });

  it("keeps a single dispatch row when very_low fails and escalation to medium succeeds", async () => {
    // Guards the invariant at listener.ts:456-458 — the medium retry path
    // reuses the SAME dispatch row. A regression that calls
    // createSlackDispatch again or finalizes per-attempt would fail here.
    mockRunRouter.mockResolvedValue(
      makeRouterResult({
        quickResponse: "Looking...",
        needsAgent: true,
        complexity: "very_low",
      }),
    );
    mockRunAgent
      .mockRejectedValueOnce(new Error("very_low crashed"))
      .mockResolvedValueOnce(
        makeAgentResponse({
          text: "Escalated answer.",
          usage: sampleUsage,
          log: sampleLog,
        }),
      );

    await handler({ message: makeSlackMessage(), client });

    // One insert — escalation must NOT create a second dispatch row
    expect(mockInsertDispatch).toHaveBeenCalledTimes(1);

    // One finalize — the very_low catch block must NOT finalize on failure;
    // the retry path owns the terminal status
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch.mock.calls[0][1]).toMatchObject({
      status: "completed",
      summary: "Escalated answer.",
      tokensIn: 100,
      tokensOut: 200,
      toolCallCount: 2,
      subagentCount: 1,
    });
  });

  it("finalizes failed exactly once on a non-retryable error (no retry loop)", async () => {
    // Billing/credit errors short-circuit via isOperationalError and take a
    // different terminal path than retry-exhaustion.
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );
    mockRunAgent.mockRejectedValueOnce(
      new Error("Credit balance is too low"),
    );

    await handler({ message: makeSlackMessage(), client });

    // No retry on non-retryable errors
    expect(mockRunAgent).toHaveBeenCalledTimes(1);

    expect(mockInsertDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch.mock.calls[0][1]).toMatchObject({
      status: "failed",
      error: "Credit balance is too low",
    });
  });

  it("finalizes exactly once (completed) when a retry succeeds on the second attempt", async () => {
    // Guards against a regression that finalizes per-attempt — the failure
    // path inside the catch block must NOT call finalize when the retry loop
    // still has attempts remaining.
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Looking..." }),
    );
    mockRunAgent
      .mockRejectedValueOnce(new Error("first crash"))
      .mockResolvedValueOnce(
        makeAgentResponse({
          text: "Recovered.",
          usage: sampleUsage,
          log: sampleLog,
        }),
      );

    await handler({ message: makeSlackMessage(), client });

    expect(mockInsertDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch.mock.calls[0][1]).toMatchObject({
      status: "completed",
      summary: "Recovered.",
      error: null,
    });
  });

  it("does NOT create a dispatch when router returns needsAgent=false (router-only responses are not dispatches)", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ quickResponse: "Hi there!", needsAgent: false }),
    );

    await handler({ message: makeSlackMessage(), client });

    expect(mockInsertDispatch).not.toHaveBeenCalled();
    expect(mockUpdateDispatch).not.toHaveBeenCalled();
  });
});
