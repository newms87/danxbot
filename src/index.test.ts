import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeRepoContext } from "./__tests__/helpers/fixtures.js";

// --- Mocks (top-level, before dynamic import) ---

const mockStartThreadCleanup = vi.fn().mockReturnValue("mock-thread-interval");
const mockStartDashboard = vi.fn().mockResolvedValue(undefined);
const mockStartWorkerServer = vi.fn().mockResolvedValue(undefined);
const mockStartSlackListener = vi.fn().mockResolvedValue(undefined);
const mockGetSlackClient = vi.fn().mockReturnValue({ chat: {} });
const mockInitShutdownHandlers = vi.fn();
const mockRunMigrations = vi.fn().mockResolvedValue(undefined);
const mockStartPoller = vi.fn();
const mockInitPlatformPool = vi.fn();

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

vi.mock("./shutdown.js", () => ({
  initShutdownHandlers: mockInitShutdownHandlers,
}));

vi.mock("./db/migrate.js", () => ({
  runMigrations: mockRunMigrations,
}));

vi.mock("./db/connection.js", () => ({
  initPlatformPool: mockInitPlatformPool,
  getPlatformPool: vi.fn(),
  closePlatformPool: vi.fn(),
  getPool: vi.fn(),
  getAdminPool: vi.fn(),
  closePool: vi.fn(),
  closeAdminPool: vi.fn(),
}));

vi.mock("./poller/index.js", () => ({
  start: mockStartPoller,
}));

// Default: dashboard mode (no DANXBOT_REPO_NAME, no repo contexts)
// These mocks are overridden in worker describe blocks via vi.doMock
let mockIsWorkerMode = false;
let mockIsDashboardMode = true;
let mockWorkerRepoName = "";
let mockRepoContexts: typeof MOCK_REPO[] = [];

vi.mock("./config.js", () => ({
  get config() { return {}; },
  get isWorkerMode() { return mockIsWorkerMode; },
  get isDashboardMode() { return mockIsDashboardMode; },
  get workerRepoName() { return mockWorkerRepoName; },
}));

vi.mock("./repo-context.js", () => ({
  get repoContexts() { return mockRepoContexts; },
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
// Worker mode tests (DANXBOT_REPO_NAME set)
// ============================================================

describe("worker mode startup flow", () => {
  beforeEach(() => {
    mockIsWorkerMode = true;
    mockIsDashboardMode = false;
    mockWorkerRepoName = "test-repo";
    mockRepoContexts = [MOCK_REPO];
  });

  afterEach(() => {
    // Reset to dashboard defaults
    mockIsWorkerMode = false;
    mockIsDashboardMode = true;
    mockWorkerRepoName = "";
    mockRepoContexts = [];
  });

  it("calls startWorkerServer with repo context", async () => {
    await importIndex();

    expect(mockStartWorkerServer).toHaveBeenCalledWith(MOCK_REPO);
  });

  it("calls initPlatformPool with repo.db before starting the worker server", async () => {
    await importIndex();

    expect(mockInitPlatformPool).toHaveBeenCalledWith(MOCK_REPO.db);
    expect(mockInitPlatformPool).toHaveBeenCalledBefore(mockStartWorkerServer);
  });

  it("starts poller", async () => {
    await importIndex();

    expect(mockStartPoller).toHaveBeenCalledOnce();
  });

  it("starts Slack listener when repo has Slack enabled", async () => {
    await importIndex();

    expect(mockStartSlackListener).toHaveBeenCalledWith(MOCK_REPO);
    expect(mockGetSlackClient).toHaveBeenCalledOnce();
  });

  it("skips Slack listener when repo has Slack disabled", async () => {
    mockRepoContexts = [makeRepoContext({
      slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    })];

    await importIndex();

    expect(mockStartSlackListener).not.toHaveBeenCalled();
    expect(mockGetSlackClient).not.toHaveBeenCalled();
  });

  it("does NOT start dashboard or run migrations", async () => {
    await importIndex();

    expect(mockStartDashboard).not.toHaveBeenCalled();
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  it("does NOT start thread cleanup", async () => {
    await importIndex();

    expect(mockStartThreadCleanup).not.toHaveBeenCalled();
  });

  it("calls initShutdownHandlers with slackClient when Slack enabled", async () => {
    const mockClient = { chat: { update: vi.fn() } };
    mockGetSlackClient.mockReturnValue(mockClient);

    await importIndex();

    expect(mockInitShutdownHandlers).toHaveBeenCalledWith({
      slackClient: mockClient,
    });
  });

  it("calls initShutdownHandlers without slackClient when Slack disabled", async () => {
    mockRepoContexts = [makeRepoContext({
      slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    })];

    await importIndex();

    expect(mockInitShutdownHandlers).toHaveBeenCalledWith({
      slackClient: undefined,
    });
  });

  it("throws when no repo context is loaded", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    mockRepoContexts = [];

    await importIndex();

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });
});

// ============================================================
// Dashboard mode tests (isDashboardMode + no repos)
// ============================================================

describe("dashboard mode startup flow", () => {
  beforeEach(() => {
    mockIsWorkerMode = false;
    mockIsDashboardMode = true;
    mockWorkerRepoName = "";
    mockRepoContexts = [];
  });

  afterEach(() => {
    mockRepoContexts = [];
  });

  it("runs migrations", async () => {
    await importIndex();

    expect(mockRunMigrations).toHaveBeenCalledOnce();
  });

  it("starts dashboard server", async () => {
    await importIndex();

    expect(mockStartDashboard).toHaveBeenCalledOnce();
  });

  it("starts thread cleanup", async () => {
    await importIndex();

    expect(mockStartThreadCleanup).toHaveBeenCalledOnce();
  });

  it("does NOT start poller or Slack", async () => {
    await importIndex();

    expect(mockStartPoller).not.toHaveBeenCalled();
    expect(mockStartSlackListener).not.toHaveBeenCalled();
  });

  it("does NOT start worker server", async () => {
    await importIndex();

    expect(mockStartWorkerServer).not.toHaveBeenCalled();
  });

  it("does NOT initialize the platform pool", async () => {
    await importIndex();

    expect(mockInitPlatformPool).not.toHaveBeenCalled();
  });

  it("calls initShutdownHandlers with thread cleanup interval", async () => {
    mockStartThreadCleanup.mockReturnValue("dash-thread-interval");

    await importIndex();

    expect(mockInitShutdownHandlers).toHaveBeenCalledWith({
      threadCleanupInterval: "dash-thread-interval",
    });
  });
});
