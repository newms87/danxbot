import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import { createMockReqWithBody, createMockRes } from "../__tests__/helpers/http-mocks.js";

// --- Mocks ---

const mockSpawnAgent = vi.fn();
const mockCancelJob = vi.fn();
const mockGetJobStatus = vi.fn();
const mockBuildMcpSettings = vi.fn().mockReturnValue("/tmp/danxbot-mcp-test");
const mockCleanupMcpSettings = vi.fn();
// terminateWithGrace records the jobs it's asked to kill so tests can assert
// the Phase 3 contract (stall recovery uses it instead of ChildProcess.kill).
const mockTerminateWithGrace = vi.fn().mockResolvedValue(undefined);

vi.mock("../agent/launcher.js", () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  cancelJob: (...args: unknown[]) => mockCancelJob(...args),
  getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  buildMcpSettings: (...args: unknown[]) => mockBuildMcpSettings(...args),
  cleanupMcpSettings: (...args: unknown[]) => mockCleanupMcpSettings(...args),
  buildCompletionInstruction: () => " [completion-instruction]",
  terminateWithGrace: (...args: unknown[]) => mockTerminateWithGrace(...args),
}));

// Use vi.hoisted so these mocks are available inside the vi.mock factories (which are hoisted)
const {
  mockTerminalWatcherStart,
  mockTerminalWatcherStop,
  mockTerminalOutputWatcherCtor,
  mockStallDetectorStart,
  mockStallDetectorStop,
  mockStallDetectorGetNudgeCount,
  mockStallDetectorCtor,
} = vi.hoisted(() => {
  const mockTerminalWatcherStart = vi.fn();
  const mockTerminalWatcherStop = vi.fn();
  const mockTerminalOutputWatcherCtor = vi.fn().mockImplementation(function () {
    return {
      start: mockTerminalWatcherStart,
      stop: mockTerminalWatcherStop,
    };
  });
  const mockStallDetectorStart = vi.fn();
  const mockStallDetectorStop = vi.fn();
  const mockStallDetectorGetNudgeCount = vi.fn().mockReturnValue(0);
  const mockStallDetectorCtor = vi.fn().mockImplementation(function () {
    return {
      start: mockStallDetectorStart,
      stop: mockStallDetectorStop,
      getNudgeCount: mockStallDetectorGetNudgeCount,
    };
  });
  return {
    mockTerminalWatcherStart,
    mockTerminalWatcherStop,
    mockTerminalOutputWatcherCtor,
    mockStallDetectorStart,
    mockStallDetectorStop,
    mockStallDetectorGetNudgeCount,
    mockStallDetectorCtor,
  };
});

vi.mock("../agent/terminal-output-watcher.js", () => ({
  TerminalOutputWatcher: function TerminalOutputWatcher(...args: unknown[]) {
    mockTerminalOutputWatcherCtor(...args);
    return { start: mockTerminalWatcherStart, stop: mockTerminalWatcherStop };
  },
}));

vi.mock("../agent/stall-detector.js", () => ({
  StallDetector: function StallDetector(...args: unknown[]) {
    mockStallDetectorCtor(...args);
    return { start: mockStallDetectorStart, stop: mockStallDetectorStop, getNudgeCount: mockStallDetectorGetNudgeCount };
  },
  DEFAULT_MAX_NUDGES: 3,
}));

vi.mock("../poller/constants.js", () => ({
  getReposBase: () => "/test/repos",
}));

const { mockDispatchConfig } = vi.hoisted(() => {
  const mockDispatchConfig = {
    isHost: false,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 3600000,
    },
    logsDir: "/test/logs",
  };
  return { mockDispatchConfig };
});

vi.mock("../config.js", () => ({ config: mockDispatchConfig }));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleLaunch, handleCancel, handleStatus, handleStop, clearJobCleanupIntervals } from "./dispatch.js";

const MOCK_REPO = makeRepoContext();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleLaunch", () => {
  it("returns 400 when task is missing", async () => {
    const req = createMockReqWithBody("POST", { api_token: "tok-123" });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing required fields: task, api_token",
    });
  });

  it("returns 400 when api_token is missing", async () => {
    const req = createMockReqWithBody("POST", { task: "Do something" });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing required fields: task, api_token",
    });
  });

  it("returns 400 when repo name does not match", async () => {
    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      repo: "wrong-repo",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: `This worker manages "test-repo", not "wrong-repo"`,
    });
  });

  it("returns 200 with job_id on successful launch", async () => {
    const mockJob = {
      id: "job-abc-123",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Implement feature X",
      api_token: "tok-123",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    // job_id is the stable dispatchId (UUID), not the internal job id
    expect(body.job_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(body.status).toBe("launched");
  });

  it("passes correct options to spawnAgent", async () => {
    const mockJob = { id: "job-1", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Build schema",
      api_token: "tok-abc",
      status_url: "http://example.com/status",
      max_runtime_ms: 120000,
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        // Prompt includes the completion instruction appended by handleLaunch
        prompt: expect.stringContaining("Build schema"),
        repoName: "test-repo",
        timeoutMs: 3600000,
        mcpConfigPath: expect.stringContaining("settings.json"),
        statusUrl: "http://example.com/status",
        apiToken: "tok-abc",
        maxRuntimeMs: 120000,
        eventForwarding: {
          statusUrl: "http://example.com/status",
          apiToken: "tok-abc",
        },
        openTerminal: false, // config.isHost is false in test
      }),
    );
  });

  it("does not set eventForwarding when statusUrl is absent", async () => {
    const mockJob = { id: "job-2", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    expect(spawnOpts.eventForwarding).toBeUndefined();
  });

  it("calls buildMcpSettings with correct options", async () => {
    const mockJob = { id: "job-3", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Build schema",
      api_token: "tok-abc",
      api_url: "http://custom-api.com",
      schema_definition_id: "def-42",
      schema_role: "builder",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockBuildMcpSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        apiToken: "tok-abc",
        apiUrl: "http://custom-api.com",
        schemaDefinitionId: "def-42",
        schemaRole: "builder",
        // danxbotStopUrl is always included for dispatched agents
        danxbotStopUrl: expect.stringContaining("/api/stop/"),
      }),
    );
  });

  it("cleans up MCP settings on spawn failure", async () => {
    mockSpawnAgent.mockRejectedValue(new Error("Spawn failed"));

    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(mockCleanupMcpSettings).toHaveBeenCalledWith("/tmp/danxbot-mcp-test");
  });

  it("accepts matching repo name without error", async () => {
    const mockJob = { id: "job-match", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
      repo: "test-repo",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
  });
});

describe("handleStatus", () => {
  it("returns 404 for unknown job", () => {
    const res = createMockRes();

    handleStatus(res, "nonexistent-job");

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Job not found" });
  });

  it("returns job status for active job", async () => {
    const mockJob = { id: "job-status-test", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);
    mockGetJobStatus.mockReturnValue({ id: "job-status-test", status: "running" });

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);

    // Use the stable dispatchId returned from launch, not the internal job id
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const res = createMockRes();
    handleStatus(res, dispatchId);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ id: "job-status-test", status: "running" });
  });
});

describe("handleCancel", () => {
  it("returns 404 for unknown job", async () => {
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleCancel(req, res, "nonexistent-job");

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Job not found" });
  });

  it("returns 409 for non-running job", async () => {
    const mockJob = { id: "job-completed", status: "completed", summary: "Done", startedAt: new Date(), completedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const cancelReq = createMockReqWithBody("POST", { api_token: "tok-123" });
    const cancelRes = createMockRes();
    await handleCancel(cancelReq, cancelRes, dispatchId);

    expect(cancelRes._getStatusCode()).toBe(409);
  });

  it("returns 200 on successful cancel", async () => {
    const mockJob = { id: "job-to-cancel", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);
    mockCancelJob.mockResolvedValue(undefined);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const cancelReq = createMockReqWithBody("POST", { api_token: "tok-cancel" });
    const cancelRes = createMockRes();
    await handleCancel(cancelReq, cancelRes, dispatchId);

    expect(cancelRes._getStatusCode()).toBe(200);
    expect(JSON.parse(cancelRes._getBody())).toEqual({ status: "canceled" });
    expect(mockCancelJob).toHaveBeenCalledWith(mockJob, "tok-cancel");
  });
});

describe("handleStop", () => {
  it("returns 404 for unknown job", async () => {
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleStop(req, res, "nonexistent-job");

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Job not found" });
  });

  it("returns 409 for non-running job", async () => {
    const mockJob = { id: "job-stopped", status: "completed", summary: "Done", startedAt: new Date(), completedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId);

    expect(stopRes._getStatusCode()).toBe(409);
  });

  it("returns 500 when job has no stop method", async () => {
    const mockJob = { id: "job-no-stop", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId);

    expect(stopRes._getStatusCode()).toBe(500);
    expect(JSON.parse(stopRes._getBody())).toEqual({ error: "Job does not support agent-initiated stop" });
  });

  it("returns 200 and calls job.stop on success", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = { id: "job-stoppable", status: "running", summary: "", startedAt: new Date(), stop: mockStop };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", { status: "completed", summary: "All done" });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId);

    expect(stopRes._getStatusCode()).toBe(200);
    expect(JSON.parse(stopRes._getBody())).toEqual({ status: "completed" });
    expect(mockStop).toHaveBeenCalledWith("completed", "All done");
  });

  it("defaults to completed status when status not specified", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = { id: "job-default-status", status: "running", summary: "", startedAt: new Date(), stop: mockStop };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId);

    expect(stopRes._getStatusCode()).toBe(200);
    expect(mockStop).toHaveBeenCalledWith("completed", undefined);
  });

  it("passes failed status when specified", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = { id: "job-fail-stop", status: "running", summary: "", startedAt: new Date(), stop: mockStop };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", { status: "failed", summary: "Something went wrong" });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId);

    expect(mockStop).toHaveBeenCalledWith("failed", "Something went wrong");
  });
});

describe("clearJobCleanupIntervals", () => {
  it("is safe to call when no intervals are tracked", () => {
    expect(() => clearJobCleanupIntervals()).not.toThrow();
  });

  it("calls clearInterval for each interval registered by handleLaunch", async () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const job1 = { id: "job-ci-1", status: "running", summary: "", startedAt: new Date() };
    const job2 = { id: "job-ci-2", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValueOnce(job1).mockResolvedValueOnce(job2);

    const req1 = createMockReqWithBody("POST", { task: "Task 1", api_token: "tok-1" });
    const res1 = createMockRes();
    await handleLaunch(req1, res1, MOCK_REPO);

    const req2 = createMockReqWithBody("POST", { task: "Task 2", api_token: "tok-2" });
    const res2 = createMockRes();
    await handleLaunch(req2, res2, MOCK_REPO);

    clearIntervalSpy.mockClear();
    clearJobCleanupIntervals();

    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    clearIntervalSpy.mockClear();
    clearJobCleanupIntervals();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });
});

describe("handleLaunch — stall detection (host mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchConfig.isHost = false;
    mockBuildMcpSettings.mockReturnValue("/tmp/danxbot-mcp-test");
  });

  afterEach(() => {
    mockDispatchConfig.isHost = false;
  });

  function makeMockWatcher() {
    return {
      getEntries: vi.fn().mockReturnValue([]),
      onEntry: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }

  it("starts TerminalOutputWatcher and StallDetector when isHost + statusUrl + watcher present", async () => {
    mockDispatchConfig.isHost = true;

    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-stall-test",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-stall-test.log",
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(mockTerminalOutputWatcherCtor).toHaveBeenCalledWith(
      "/tmp/danxbot-terminal-job-stall-test.log",
    );
    expect(mockTerminalWatcherStart).toHaveBeenCalled();
    expect(mockStallDetectorCtor).toHaveBeenCalled();
    expect(mockStallDetectorStart).toHaveBeenCalled();
  });

  it("does not start stall detection when statusUrl is absent", async () => {
    mockDispatchConfig.isHost = true;

    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-no-stall",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-no-stall.log",
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockTerminalOutputWatcherCtor).not.toHaveBeenCalled();
    expect(mockStallDetectorCtor).not.toHaveBeenCalled();
  });

  it("does not start stall detection when job.terminalLogPath is absent", async () => {
    mockDispatchConfig.isHost = true;

    const mockJob = {
      id: "job-no-log",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: makeMockWatcher(),
      terminalLogPath: undefined,
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockTerminalOutputWatcherCtor).not.toHaveBeenCalled();
    expect(mockStallDetectorCtor).not.toHaveBeenCalled();
  });

  it("stall detection cleanup is wired into job._cleanup", async () => {
    mockDispatchConfig.isHost = true;

    const originalCleanup = vi.fn();
    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-cleanup-test",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-cleanup-test.log",
      _cleanup: originalCleanup,
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    // Trigger the wrapped cleanup
    mockJob._cleanup();

    expect(mockTerminalWatcherStop).toHaveBeenCalled();
    expect(mockStallDetectorStop).toHaveBeenCalled();
    expect(originalCleanup).toHaveBeenCalled();
  });

  it("does not start stall detection when isHost is false (even with statusUrl + watcher + terminalLogPath)", async () => {
    // isHost is false (set in beforeEach) — stall detection must not activate
    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-docker-mode",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-docker-mode.log",
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockTerminalOutputWatcherCtor).not.toHaveBeenCalled();
    expect(mockStallDetectorCtor).not.toHaveBeenCalled();
  });

  it("does not start stall detection when job.watcher is absent", async () => {
    mockDispatchConfig.isHost = true;

    const mockJob = {
      id: "job-no-watcher",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: undefined, // no watcher
      terminalLogPath: "/tmp/danxbot-terminal-job-no-watcher.log",
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockTerminalOutputWatcherCtor).not.toHaveBeenCalled();
    expect(mockStallDetectorCtor).not.toHaveBeenCalled();
  });

  it("onStall callback: skips when the current job is no longer running", async () => {
    mockDispatchConfig.isHost = true;

    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-already-done",
      status: "completed" as const, // already done when onStall fires
      summary: "Done",
      startedAt: new Date(),
      completedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-already-done.log",
      _cleanup: vi.fn(),
      stop: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      status_url: "http://example.com/status",
    });
    const res = createMockRes();
    await handleLaunch(req, res, MOCK_REPO);

    // Extract the onStall callback from the StallDetector constructor args
    const stallDetectorArgs = mockStallDetectorCtor.mock.calls[0][0] as { onStall: () => Promise<void> };
    const onStall = stallDetectorArgs.onStall;

    await onStall();

    // Since the job is not running, no stop and no respawn should occur
    expect(mockJob.stop).not.toHaveBeenCalled();
    // spawnAgent was called once initially; should not be called again
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it("onStall callback: kills and respawns with nudge prompt on first stall", async () => {
    mockDispatchConfig.isHost = true;
    vi.useFakeTimers();

    try {
      const mockKill = vi.fn();
      const mockWatcher = makeMockWatcher();
      const mockJob = {
        id: "job-stall-respawn",
        status: "running" as string,
        summary: "",
        startedAt: new Date(),
        watcher: mockWatcher,
        terminalLogPath: "/tmp/danxbot-terminal-job-stall-respawn.log",
        _cleanup: vi.fn(),
        process: { kill: mockKill },
      };
      const mockRespawnJob = {
        id: "job-respawn-new",
        status: "running" as string,
        summary: "",
        startedAt: new Date(),
        watcher: makeMockWatcher(),
        terminalLogPath: "/tmp/danxbot-terminal-job-respawn-new.log",
        _cleanup: vi.fn(),
      };
      mockSpawnAgent.mockResolvedValueOnce(mockJob).mockResolvedValueOnce(mockRespawnJob);

      const req = createMockReqWithBody("POST", {
        task: "Build the feature",
        api_token: "tok-123",
        status_url: "http://example.com/status",
      });
      const res = createMockRes();
      await handleLaunch(req, res, MOCK_REPO);
      const dispatchId = JSON.parse(res._getBody()).job_id;

      const stallDetectorArgs = mockStallDetectorCtor.mock.calls[0][0] as { onStall: () => Promise<void> };
      const onStall = stallDetectorArgs.onStall;

      // Start onStall (it awaits a 5s timer inside)
      const onStallPromise = onStall();
      // Advance past the 5-second kill wait
      await vi.advanceTimersByTimeAsync(6_000);
      await onStallPromise;

      // spawnAgent should have been called twice: initial + respawn
      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);

      // Respawn prompt should contain the original task
      const respawnOpts = mockSpawnAgent.mock.calls[1][0] as { prompt: string; jobId: string };
      expect(respawnOpts.prompt).toContain("Build the feature");
      expect(respawnOpts.prompt).toContain("stall");

      // Respawn uses a DIFFERENT jobId from the dispatchId
      expect(respawnOpts.jobId).not.toBe(dispatchId);

      // Active job under dispatchId is now the respawned job
      const statusRes = createMockRes();
      mockGetJobStatus.mockReturnValue({ status: "running" });
      handleStatus(statusRes, dispatchId);
      expect(statusRes._getStatusCode()).toBe(200);

      // Phase 3 contract: stall recovery routes through terminateWithGrace —
      // regression-proof against anyone re-inlining `job.process.kill(...)`,
      // which would silently break host mode (no ChildProcess handle).
      expect(mockTerminateWithGrace).toHaveBeenCalledWith(
        expect.objectContaining({ id: "job-stall-respawn" }),
        5_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("onStall callback: kills via killAgentProcess when job has no ChildProcess (host mode)", async () => {
    // Simulates a host-mode job: process is undefined, claudePid is set.
    // Before Phase 3, stall recovery directly accessed job.process.kill,
    // which was a no-op for host jobs — this test locks that contract.
    mockDispatchConfig.isHost = true;
    vi.useFakeTimers();

    try {
      const mockWatcher = makeMockWatcher();
      const hostJob = {
        id: "host-stall-job",
        status: "running" as string,
        summary: "",
        startedAt: new Date(),
        watcher: mockWatcher,
        terminalLogPath: "/tmp/danxbot-terminal-host-stall-job.log",
        _cleanup: vi.fn(),
        // No `process` — host mode runs claude in a detached wt.exe tab.
        claudePid: 424_242,
      };
      const respawnJob = {
        id: "host-respawn",
        status: "running" as string,
        summary: "",
        startedAt: new Date(),
        watcher: makeMockWatcher(),
        terminalLogPath: "/tmp/danxbot-terminal-host-respawn.log",
        _cleanup: vi.fn(),
        claudePid: 424_243,
      };
      mockSpawnAgent.mockResolvedValueOnce(hostJob).mockResolvedValueOnce(respawnJob);

      const req = createMockReqWithBody("POST", {
        task: "Host task",
        api_token: "tok-host",
        status_url: "http://example.com/status",
      });
      const res = createMockRes();
      await handleLaunch(req, res, MOCK_REPO);

      const stallArgs = mockStallDetectorCtor.mock.calls[0][0] as { onStall: () => Promise<void> };
      const p = stallArgs.onStall();
      await vi.advanceTimersByTimeAsync(6_000);
      await p;

      // Host-mode stall recovery passes the host job (no .process handle)
      // through terminateWithGrace, which must be signature-agnostic.
      expect(mockTerminateWithGrace).toHaveBeenCalledWith(
        expect.objectContaining({ id: "host-stall-job", claudePid: 424_242 }),
        5_000,
      );
      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("onStall callback: marks job failed when MAX_STALL_RESUMES exhausted", async () => {
    mockDispatchConfig.isHost = true;
    vi.useFakeTimers();

    try {
      const mockStop = vi.fn().mockResolvedValue(undefined);

      function makeStallJob(id: string) {
        return {
          id,
          status: "running" as string,
          summary: "",
          startedAt: new Date(),
          watcher: makeMockWatcher(),
          terminalLogPath: `/tmp/danxbot-terminal-${id}.log`,
          _cleanup: vi.fn(),
          process: { kill: vi.fn() },
          stop: mockStop,
        };
      }

      const job0 = makeStallJob("job-max-0");
      const job1 = makeStallJob("job-max-1");
      const job2 = makeStallJob("job-max-2");
      // Only 3 total spawns: initial + 2 respawns (3rd stall → mark failed, no respawn)
      mockSpawnAgent
        .mockResolvedValueOnce(job0)
        .mockResolvedValueOnce(job1)
        .mockResolvedValueOnce(job2);

      const req = createMockReqWithBody("POST", {
        task: "Long task",
        api_token: "tok-123",
        status_url: "http://example.com/status",
      });
      const res = createMockRes();
      await handleLaunch(req, res, MOCK_REPO);

      // Helper: fire onStall from the nth StallDetector (0-indexed) and advance past kill wait
      async function fireStall(detectorIndex: number): Promise<void> {
        const args = mockStallDetectorCtor.mock.calls[detectorIndex][0] as { onStall: () => Promise<void> };
        const promise = args.onStall();
        await vi.advanceTimersByTimeAsync(6_000);
        await promise;
      }

      // Resume 1 (resumeCount 0→1, < 3): kill + respawn
      await fireStall(0);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);

      // Resume 2 (resumeCount 1→2, < 3): kill + respawn
      await fireStall(1);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(3);

      // Resume 3 (resumeCount 2→3, >= 3): mark failed, NO respawn
      await fireStall(2);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(3); // still 3 — no 4th spawn
      expect(mockStop).toHaveBeenCalledWith("failed", expect.stringContaining("stall"));
    } finally {
      vi.useRealTimers();
    }
  });
});