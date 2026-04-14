import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeRepoContext } from "./__tests__/helpers/fixtures.js";

// --- Mocks (top-level, before dynamic import) ---

const mockStartThreadCleanup = vi.fn().mockReturnValue("mock-thread-interval");
const mockLoadEvents = vi.fn().mockResolvedValue(undefined);
const mockStartEventCleanup = vi.fn().mockReturnValue("mock-event-interval");
const mockStartDashboard = vi.fn().mockResolvedValue(undefined);
const mockStartWorkerServer = vi.fn().mockResolvedValue(undefined);
const mockStartSlackListener = vi.fn().mockResolvedValue(undefined);
const mockGetSlackClient = vi.fn().mockReturnValue({ chat: {} });
const mockInitShutdownHandlers = vi.fn();
const mockRunMigrations = vi.fn().mockResolvedValue(undefined);
const mockStartPoller = vi.fn();

const MOCK_REPO = makeRepoContext();

vi.mock("./slack/listener.js", () => ({
  startSlackListener: mockStartSlackListener,
  getSlackClient: mockGetSlackClient,
  stopSlackListener: vi.fn(),
  getInFlightPlaceholders: vi.fn().mockReturnValue([]),
  isSlackConnected: vi.fn().mockReturnValue(true),
}));

vi.mock("./threads.js", () => ({
  startThreadCleanup: mockStartThreadCleanup,
  stopThreadCleanup: vi.fn(),
  getOrCreateThread: vi.fn(),
  addMessageToThread: vi.fn(),
  updateSessionId: vi.fn(),
  isBotParticipant: vi.fn(),
  cleanupOldThreads: vi.fn(),
}));

vi.mock("./dashboard/server.js", () => ({
  startDashboard: mockStartDashboard,
}));

vi.mock("./worker/server.js", () => ({
  startWorkerServer: mockStartWorkerServer,
}));

vi.mock("./dashboard/events.js", () => ({
  loadEvents: mockLoadEvents,
  startEventCleanup: mockStartEventCleanup,
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  getEvents: vi.fn().mockReturnValue([]),
  stopEventCleanup: vi.fn(),
}));

vi.mock("./shutdown.js", () => ({
  initShutdownHandlers: mockInitShutdownHandlers,
}));

vi.mock("./db/migrate.js", () => ({
  runMigrations: mockRunMigrations,
}));

vi.mock("./poller/index.js", () => ({
  start: mockStartPoller,
}));

// Default: legacy mode (repoContexts populated, no DANXBOT_REPO_NAME)
vi.mock("./config.js", () => ({
  config: {},
  repoContexts: [MOCK_REPO],
  isWorkerMode: false,
  isDashboardMode: true,
  workerRepoName: "",
}));

vi.mock("./logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// --- Test setup ---

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();

  // Re-wire mocks after resetModules clears them
  mockRunMigrations.mockResolvedValue(undefined);
  mockStartThreadCleanup.mockReturnValue("mock-thread-interval");
  mockLoadEvents.mockResolvedValue(undefined);
  mockStartEventCleanup.mockReturnValue("mock-event-interval");
  mockStartDashboard.mockResolvedValue(undefined);
  mockStartWorkerServer.mockResolvedValue(undefined);
  mockStartSlackListener.mockResolvedValue(undefined);
  mockGetSlackClient.mockReturnValue({ chat: {} });
});

// Helper: import index.ts (which runs main() immediately) and flush microtasks
async function importIndex(): Promise<void> {
  await import("./index.js");
  // Flush the microtask queue so the main() promise chain completes
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ============================================================
// Legacy mode tests (repoContexts populated, no DANXBOT_REPO_NAME)
// ============================================================

describe("legacy mode startup flow", () => {
  it("calls startup functions without throwing", async () => {
    await importIndex();

    expect(mockStartThreadCleanup).toHaveBeenCalledOnce();
    expect(mockLoadEvents).toHaveBeenCalledOnce();
    expect(mockStartEventCleanup).toHaveBeenCalledOnce();
    expect(mockStartDashboard).toHaveBeenCalledOnce();
    expect(mockStartSlackListener).toHaveBeenCalledOnce();
  });

  it("calls startup functions in correct order", async () => {
    const callOrder: string[] = [];

    mockRunMigrations.mockImplementation(async () => {
      callOrder.push("runMigrations");
    });
    mockStartThreadCleanup.mockImplementation(() => {
      callOrder.push("startThreadCleanup");
      return "mock-thread-interval";
    });
    mockLoadEvents.mockImplementation(async () => {
      callOrder.push("loadEvents");
    });
    mockStartEventCleanup.mockImplementation(() => {
      callOrder.push("startEventCleanup");
      return "mock-event-interval";
    });
    mockStartDashboard.mockImplementation(async () => {
      callOrder.push("startDashboard");
    });
    mockStartSlackListener.mockImplementation(async () => {
      callOrder.push("startSlackListener");
    });
    mockGetSlackClient.mockImplementation(() => {
      callOrder.push("getSlackClient");
      return { chat: {} };
    });
    mockInitShutdownHandlers.mockImplementation(() => {
      callOrder.push("initShutdownHandlers");
    });

    await importIndex();

    expect(callOrder).toEqual([
      "runMigrations",
      "startThreadCleanup",
      "loadEvents",
      "startEventCleanup",
      "startDashboard",
      "startSlackListener",
      "getSlackClient",
      "initShutdownHandlers",
    ]);
  });

  it("waits for loadEvents to complete before calling startDashboard", async () => {
    let loadEventsResolve: () => void;
    const loadEventsPromise = new Promise<void>((resolve) => {
      loadEventsResolve = resolve;
    });

    mockLoadEvents.mockReturnValue(loadEventsPromise);

    // Start importing (triggers main())
    const indexPromise = import("./index.js");

    // Give microtasks a chance to run up to the await
    await new Promise((resolve) => setTimeout(resolve, 0));

    // loadEvents has been called but startDashboard should NOT have been called yet
    expect(mockLoadEvents).toHaveBeenCalledOnce();
    expect(mockStartDashboard).not.toHaveBeenCalled();

    // Now resolve loadEvents
    loadEventsResolve!();
    await indexPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Now startDashboard should have been called
    expect(mockStartDashboard).toHaveBeenCalledOnce();
  });

  it("passes threadCleanupInterval, eventCleanupInterval, and slackClient to initShutdownHandlers", async () => {
    const mockClient = { chat: { update: vi.fn() } };
    mockStartThreadCleanup.mockReturnValue("test-thread-interval");
    mockStartEventCleanup.mockReturnValue("test-event-interval");
    mockGetSlackClient.mockReturnValue(mockClient);

    await importIndex();

    expect(mockInitShutdownHandlers).toHaveBeenCalledWith({
      threadCleanupInterval: "test-thread-interval",
      eventCleanupInterval: "test-event-interval",
      slackClient: mockClient,
    });
  });

  it("calls process.exit(1) on fatal startup error", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    const startupError = new Error("Database connection failed");
    mockLoadEvents.mockRejectedValue(startupError);

    await importIndex();

    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
  });
});
