import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks (top-level, before dynamic import) ---

const mockStopSlackListener = vi.fn();
const mockGetInFlightPlaceholders = vi.fn().mockReturnValue([]);

vi.mock("./slack/listener.js", () => ({
  stopSlackListener: mockStopSlackListener,
  getInFlightPlaceholders: mockGetInFlightPlaceholders,
  startSlackListener: vi.fn(),
  isSlackConnected: vi.fn().mockReturnValue(true),
}));

const mockStopThreadCleanup = vi.fn();

vi.mock("./threads.js", () => ({
  stopThreadCleanup: mockStopThreadCleanup,
  startThreadCleanup: vi.fn().mockReturnValue("mock-interval"),
  getOrCreateThread: vi.fn(),
  addMessageToThread: vi.fn(),
  updateSessionId: vi.fn(),
  isBotParticipant: vi.fn(),
  cleanupOldThreads: vi.fn(),
}));

const mockStopEventCleanup = vi.fn();

vi.mock("./dashboard/events.js", () => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  getEvents: vi.fn().mockReturnValue([]),
  loadEvents: vi.fn(),
  stopEventCleanup: mockStopEventCleanup,
}));

vi.mock("./dashboard/server.js", () => ({
  startDashboard: vi.fn(),
}));

const mockClosePool = vi.fn();

vi.mock("./db/connection.js", () => ({
  closePool: (...args: unknown[]) => mockClosePool(...args),
  getPool: vi.fn(),
  getAdminPool: vi.fn(),
  closeAdminPool: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockChatUpdate = vi.fn().mockResolvedValue({});

// Dynamic import after mocks
const { shutdown, initShutdownHandlers } = await import("./shutdown.js");

// --- Test setup ---

// Create a mock Slack client
const mockSlackClient = {
  chat: {
    update: mockChatUpdate,
  },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockChatUpdate.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Shutdown function tests
// ============================================================

describe("shutdown", () => {
  it("stops accepting new messages via stopSlackListener", async () => {
    const shutdownPromise = shutdown({ exitProcess: false });
    await vi.runAllTimersAsync();
    await shutdownPromise;

    expect(mockStopSlackListener).toHaveBeenCalledOnce();
  });

  it("updates in-flight placeholder messages with restart message", async () => {
    mockGetInFlightPlaceholders.mockReturnValue([
      { channel: "C-TEST1", ts: "1234.5678", threadTs: "1234.0000" },
      { channel: "C-TEST2", ts: "5678.1234", threadTs: "5678.0000" },
    ]);

    const shutdownPromise = shutdown({
      exitProcess: false,
      slackClient: mockSlackClient,
    });
    await vi.runAllTimersAsync();
    await shutdownPromise;

    expect(mockChatUpdate).toHaveBeenCalledTimes(2);
    expect(mockChatUpdate).toHaveBeenCalledWith({
      channel: "C-TEST1",
      ts: "1234.5678",
      text: "Bot is restarting, I'll respond when I'm back.",
      attachments: [],
    });
    expect(mockChatUpdate).toHaveBeenCalledWith({
      channel: "C-TEST2",
      ts: "5678.1234",
      text: "Bot is restarting, I'll respond when I'm back.",
      attachments: [],
    });
  });

  it("waits up to 30 seconds for in-flight agents to complete", async () => {
    // Simulate in-flight agents that clear after a few iterations
    let callCount = 0;
    mockGetInFlightPlaceholders.mockImplementation(() => {
      callCount++;
      // Return empty after 3 calls (simulating agents completing)
      if (callCount > 3) {
        return [];
      }
      return [{ channel: "C-TEST", ts: "1234.5678", threadTs: "1234.0000" }];
    });

    const shutdownPromise = shutdown({
      exitProcess: false,
      threadCleanupInterval: "test-interval" as unknown as NodeJS.Timeout,
    });

    // Advance timers to let the wait loop run
    await vi.runAllTimersAsync();
    await shutdownPromise;

    // Should have called stopThreadCleanup after agents completed
    expect(mockStopThreadCleanup).toHaveBeenCalledWith("test-interval");
  });

  it("stops waiting after 30 seconds even if agents are still running", async () => {
    // Simulate agents that never finish
    mockGetInFlightPlaceholders.mockReturnValue([
      { channel: "C-TEST", ts: "1234.5678", threadTs: "1234.0000" },
    ]);

    const shutdownPromise = shutdown({
      exitProcess: false,
      threadCleanupInterval: "test-interval" as unknown as NodeJS.Timeout,
    });

    // Fast-forward past 30 seconds + a bit more for the while loop
    await vi.advanceTimersByTimeAsync(31000);
    await shutdownPromise;

    expect(mockStopThreadCleanup).toHaveBeenCalledWith("test-interval");
  });

  it("stops thread cleanup with the stored interval", async () => {
    const shutdownPromise = shutdown({
      exitProcess: false,
      threadCleanupInterval: "test-interval" as unknown as NodeJS.Timeout,
    });
    await vi.runAllTimersAsync();
    await shutdownPromise;

    expect(mockStopThreadCleanup).toHaveBeenCalledWith("test-interval");
  });

  it("stops event cleanup with the stored interval", async () => {
    const shutdownPromise = shutdown({
      exitProcess: false,
      eventCleanupInterval: "test-event-interval" as unknown as NodeJS.Timeout,
    });
    await vi.runAllTimersAsync();
    await shutdownPromise;

    expect(mockStopEventCleanup).toHaveBeenCalledWith("test-event-interval");
  });

  it("closes database connection pool", async () => {
    const shutdownPromise = shutdown({ exitProcess: false });
    await vi.runAllTimersAsync();
    await shutdownPromise;

    expect(mockClosePool).toHaveBeenCalledOnce();
  });

  it("exits with code 0 when exitProcess is true", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      // Do nothing - just capture the call
    }) as never);

    const shutdownPromise = shutdown({ exitProcess: true });
    await vi.runAllTimersAsync();
    await shutdownPromise;

    expect(mockExit).toHaveBeenCalledWith(0);

    mockExit.mockRestore();
  });

  it("does not exit when exitProcess is false", async () => {
    const mockExit = vi.spyOn(process, "exit");

    const shutdownPromise = shutdown({ exitProcess: false });
    await vi.runAllTimersAsync();
    await shutdownPromise;

    expect(mockExit).not.toHaveBeenCalled();

    mockExit.mockRestore();
  });

  it("handles errors during placeholder updates gracefully", async () => {
    // First call returns placeholders, subsequent calls return empty
    let callCount = 0;
    mockGetInFlightPlaceholders.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return [{ channel: "C-TEST", ts: "1234.5678", threadTs: "1234.0000" }];
      }
      return [];
    });
    mockChatUpdate.mockRejectedValue(new Error("Slack API error"));

    const shutdownPromise = shutdown({
      exitProcess: false,
      threadCleanupInterval: "test-interval" as unknown as NodeJS.Timeout,
      slackClient: mockSlackClient,
    });
    await vi.runAllTimersAsync();
    await shutdownPromise;

    // Should complete despite error
    expect(mockStopThreadCleanup).toHaveBeenCalledWith("test-interval");
  });
});

// ============================================================
// Signal handler registration tests
// ============================================================

describe("initShutdownHandlers", () => {
  it("registers SIGTERM handler", () => {
    const mockOn = vi.spyOn(process, "on");

    initShutdownHandlers({
      threadCleanupInterval: "test-interval" as unknown as NodeJS.Timeout,
      eventCleanupInterval: "test-event-interval" as unknown as NodeJS.Timeout,
    });

    expect(mockOn).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

    mockOn.mockRestore();
  });

  it("registers SIGINT handler", () => {
    const mockOn = vi.spyOn(process, "on");

    initShutdownHandlers({
      threadCleanupInterval: "test-interval" as unknown as NodeJS.Timeout,
      eventCleanupInterval: "test-event-interval" as unknown as NodeJS.Timeout,
    });

    expect(mockOn).toHaveBeenCalledWith("SIGINT", expect.any(Function));

    mockOn.mockRestore();
  });
});
