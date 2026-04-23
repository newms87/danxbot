import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks (top-level, before dynamic import) ---

const mockStopSlackListener = vi.fn();

vi.mock("./slack/listener.js", () => ({
  stopSlackListener: mockStopSlackListener,
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

const mockStopRetentionCron = vi.fn();
vi.mock("./dashboard/retention.js", () => ({
  stopRetentionCron: (...args: unknown[]) => mockStopRetentionCron(...args),
  startRetentionCron: vi.fn().mockReturnValue("mock-retention-interval"),
}));

const mockClearJobCleanupIntervals = vi.fn();
vi.mock("./worker/dispatch.js", () => ({
  clearJobCleanupIntervals: (...args: unknown[]) => mockClearJobCleanupIntervals(...args),
  handleLaunch: vi.fn(),
  handleCancel: vi.fn(),
  handleStatus: vi.fn(),
}));

const mockListActiveJobs = vi.fn().mockReturnValue([]);
vi.mock("./dispatch/core.js", () => ({
  listActiveJobs: (...args: unknown[]) => mockListActiveJobs(...args),
  getActiveJob: vi.fn(),
  dispatch: vi.fn(),
}));

const mockClosePool = vi.fn();
const mockClosePlatformPool = vi.fn();

vi.mock("./db/connection.js", () => ({
  closePool: (...args: unknown[]) => mockClosePool(...args),
  closePlatformPool: (...args: unknown[]) => mockClosePlatformPool(...args),
  getPool: vi.fn(),
  getAdminPool: vi.fn(),
  closeAdminPool: vi.fn(),
  getPlatformPool: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Dynamic import after mocks
const { shutdown, initShutdownHandlers } = await import("./shutdown.js");

// --- Helpers ---

interface FakeJob {
  id: string;
  status: "running" | "completed" | "failed" | "canceled" | "timeout";
  stop: ReturnType<typeof vi.fn>;
}

function makeRunningJob(id: string): FakeJob {
  return {
    id,
    status: "running",
    stop: vi.fn().mockImplementation(async function (this: FakeJob) {
      this.status = "failed";
    }),
  };
}

function makeCompletedJob(id: string): FakeJob {
  return {
    id,
    status: "completed",
    stop: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListActiveJobs.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// Shutdown function tests
// ============================================================

describe("shutdown", () => {
  it("stops accepting new messages via stopSlackListener", async () => {
    await shutdown({ exitProcess: false });

    expect(mockStopSlackListener).toHaveBeenCalledOnce();
  });

  it("calls job.stop() on every running active job before exiting", async () => {
    const running1 = makeRunningJob("job-1");
    const running2 = makeRunningJob("job-2");
    mockListActiveJobs.mockReturnValue([running1, running2]);

    await shutdown({ exitProcess: false });

    expect(running1.stop).toHaveBeenCalledTimes(1);
    expect(running1.stop).toHaveBeenCalledWith("failed", expect.stringContaining("shutdown"));
    expect(running2.stop).toHaveBeenCalledTimes(1);
    expect(running2.stop).toHaveBeenCalledWith("failed", expect.stringContaining("shutdown"));
  });

  it("does not call job.stop() on jobs that are no longer running", async () => {
    const running = makeRunningJob("job-1");
    const completed = makeCompletedJob("job-2");
    mockListActiveJobs.mockReturnValue([running, completed]);

    await shutdown({ exitProcess: false });

    expect(running.stop).toHaveBeenCalledTimes(1);
    expect(completed.stop).not.toHaveBeenCalled();
  });

  it("stops thread cleanup with the stored interval", async () => {
    await shutdown({
      exitProcess: false,
      threadCleanupInterval: "test-interval" as unknown as NodeJS.Timeout,
    });

    expect(mockStopThreadCleanup).toHaveBeenCalledWith("test-interval");
  });

  it("closes database connection pool", async () => {
    await shutdown({ exitProcess: false });

    expect(mockClosePool).toHaveBeenCalledOnce();
  });

  it("closes platform database connection pool", async () => {
    await shutdown({ exitProcess: false });

    expect(mockClosePlatformPool).toHaveBeenCalledOnce();
  });

  it("exits with code 0 when exitProcess is true", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      // Do nothing - just capture the call
    }) as never);

    await shutdown({ exitProcess: true });

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("does not exit when exitProcess is false", async () => {
    const mockExit = vi.spyOn(process, "exit");

    await shutdown({ exitProcess: false });

    expect(mockExit).not.toHaveBeenCalled();
  });

  it("continues shutdown even when a job.stop() rejects", async () => {
    const failing = makeRunningJob("job-1");
    failing.stop.mockRejectedValue(new Error("boom"));
    const ok = makeRunningJob("job-2");
    mockListActiveJobs.mockReturnValue([failing, ok]);

    await shutdown({ exitProcess: false });

    expect(ok.stop).toHaveBeenCalledTimes(1);
    expect(mockClosePool).toHaveBeenCalledOnce();
    expect(mockClosePlatformPool).toHaveBeenCalledOnce();
  });

  it("invokes clearJobCleanupIntervals so TTL timers do not leak", async () => {
    await shutdown({ exitProcess: false });

    expect(mockClearJobCleanupIntervals).toHaveBeenCalledOnce();
  });

  it("calls stopRetentionCron with the supplied retention interval", async () => {
    await shutdown({
      exitProcess: false,
      retentionInterval: "test-retention" as unknown as NodeJS.Timeout,
    });

    expect(mockStopRetentionCron).toHaveBeenCalledWith("test-retention");
  });

  it("drains running jobs in parallel rather than sequentially", async () => {
    // If this ever regresses to `for (const j of running) await j.stop(...)`,
    // the second stop() would not start until the first resolves.
    let jobAStarted = false;
    let jobBStartedBeforeAResolved = false;
    let releaseA: () => void = () => {};
    const aStopPromise = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const jobA = makeRunningJob("job-a");
    jobA.stop.mockImplementation(async () => {
      jobAStarted = true;
      await aStopPromise;
    });
    const jobB = makeRunningJob("job-b");
    jobB.stop.mockImplementation(async () => {
      jobBStartedBeforeAResolved = jobAStarted;
    });

    mockListActiveJobs.mockReturnValue([jobA, jobB]);

    const shutdownPromise = shutdown({ exitProcess: false });
    // Let the event loop schedule both stop() calls before releasing A.
    await new Promise((r) => setTimeout(r, 0));
    releaseA();
    await shutdownPromise;

    expect(jobBStartedBeforeAResolved).toBe(true);
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
    });

    expect(mockOn).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("registers SIGINT handler", () => {
    const mockOn = vi.spyOn(process, "on");

    initShutdownHandlers({
      threadCleanupInterval: "test-interval" as unknown as NodeJS.Timeout,
    });

    expect(mockOn).toHaveBeenCalledWith("SIGINT", expect.any(Function));
  });
});
