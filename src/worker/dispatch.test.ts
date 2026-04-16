import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import { createMockReqWithBody, createMockRes } from "../__tests__/helpers/http-mocks.js";

// --- Mocks ---

const mockSpawnAgent = vi.fn();
const mockCancelJob = vi.fn();
const mockGetJobStatus = vi.fn();
const mockBuildMcpSettings = vi.fn().mockReturnValue("/tmp/danxbot-mcp-test");
const mockPutStatus = vi.fn().mockResolvedValue(undefined);
const mockStartHeartbeat = vi.fn();
const mockStopHeartbeat = vi.fn();
const mockCleanupMcpSettings = vi.fn();

vi.mock("../agent/launcher.js", () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  cancelJob: (...args: unknown[]) => mockCancelJob(...args),
  getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  buildMcpSettings: (...args: unknown[]) => mockBuildMcpSettings(...args),
  putStatus: (...args: unknown[]) => mockPutStatus(...args),
  startHeartbeat: (...args: unknown[]) => mockStartHeartbeat(...args),
  stopHeartbeat: (...args: unknown[]) => mockStopHeartbeat(...args),
  cleanupMcpSettings: (...args: unknown[]) => mockCleanupMcpSettings(...args),
}));

vi.mock("../terminal.js", () => ({
  spawnInTerminal: vi.fn(),
  buildDispatchScript: vi.fn().mockReturnValue("/tmp/test-script.sh"),
}));

vi.mock("../poller/constants.js", () => ({
  getReposBase: () => "/test/repos",
}));

vi.mock("../config.js", () => ({
  config: {
    isHost: false,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 3600000,
    },
    logsDir: "/test/logs",
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

import { handleLaunch, handleCancel, handleStatus, clearJobCleanupIntervals } from "./dispatch.js";

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

  it("returns 200 with job_id on successful launch (Docker mode)", async () => {
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
    expect(body.job_id).toBe("job-abc-123");
    expect(body.status).toBe("launched");
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Implement feature X",
        repoName: "test-repo",
        mcpConfigPath: expect.any(String),
      }),
    );
  });

  it("accepts matching repo name without error", async () => {
    const mockJob = {
      id: "job-match",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
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

  it("returns 500 when spawnAgent throws", async () => {
    mockSpawnAgent.mockRejectedValue(new Error("Spawn failed"));

    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Spawn failed" });
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
    // Launch a job first so it's in activeJobs
    const mockJob = {
      id: "job-status-test",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);
    mockGetJobStatus.mockReturnValue({ id: "job-status-test", status: "running" });

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);

    // Now check status
    const res = createMockRes();
    handleStatus(res, "job-status-test");

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
    // Launch and then complete a job
    const mockJob = {
      id: "job-completed",
      status: "completed",
      summary: "Done",
      startedAt: new Date(),
      completedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);

    // Try to cancel
    const cancelReq = createMockReqWithBody("POST", { api_token: "tok-123" });
    const cancelRes = createMockRes();
    await handleCancel(cancelReq, cancelRes, "job-completed");

    expect(cancelRes._getStatusCode()).toBe(409);
    expect(JSON.parse(cancelRes._getBody())).toEqual({
      error: "Job is not running (status: completed)",
    });
  });

  it("returns 200 on successful cancel", async () => {
    const mockJob = {
      id: "job-to-cancel",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);
    mockCancelJob.mockResolvedValue(undefined);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);

    const cancelReq = createMockReqWithBody("POST", { api_token: "tok-cancel" });
    const cancelRes = createMockRes();
    await handleCancel(cancelReq, cancelRes, "job-to-cancel");

    expect(cancelRes._getStatusCode()).toBe(200);
    expect(JSON.parse(cancelRes._getBody())).toEqual({ status: "canceled" });
    expect(mockCancelJob).toHaveBeenCalledWith(mockJob, "tok-cancel");
  });
});

describe("clearJobCleanupIntervals", () => {
  it("is safe to call when no intervals are tracked", () => {
    expect(() => clearJobCleanupIntervals()).not.toThrow();
  });

  it("calls clearInterval for each interval registered by handleLaunch", async () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    // Launch two jobs to register two cleanup intervals
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

    // Should have cleared at least 2 intervals (one per job)
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Calling again should clear 0 (Set was emptied)
    clearIntervalSpy.mockClear();
    clearJobCleanupIntervals();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });
});
