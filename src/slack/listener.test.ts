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

vi.mock("../dashboard/events.js", () => ({
  createEvent: mockCreateEvent,
  updateEvent: mockUpdateEvent,
}));

const mockGetOrCreateThread = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockUpdateSessionId = vi.fn();
const mockIsBotParticipant = vi.fn();

vi.mock("../threads.js", () => ({
  getOrCreateThread: mockGetOrCreateThread,
  addMessageToThread: mockAddMessageToThread,
  updateSessionId: mockUpdateSessionId,
  isBotParticipant: mockIsBotParticipant,
}));

// Mock @slack/bolt — App must be a real class so `new App()` works
let capturedMessageHandler: Function;
let mockAppStart: ReturnType<typeof vi.fn>;

vi.mock("@slack/bolt", () => {
  return {
    App: class MockApp {
      message(handler: Function) {
        capturedMessageHandler = handler;
      }
      async start() {}
    },
  };
});

// Dynamic import after mocks
const { startSlackListener } = await import("./listener.js");

// --- Test setup ---

let handler: (args: { message: Record<string, unknown>; client: ReturnType<typeof createMockWebClient> }) => Promise<void>;
let client: ReturnType<typeof createMockWebClient>;

beforeEach(async () => {
  vi.clearAllMocks();

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

    // Restore timeout
    (mockConfig.agent as Record<string, unknown>).timeoutMs = 300000;
  });

  it("handles agent crash", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "Let me check..." }),
    );
    mockRunAgent.mockRejectedValue(new Error("SDK process died"));

    await handler({ message: makeSlackMessage(), client });

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
  });
});
