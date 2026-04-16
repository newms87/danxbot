import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import { createMockReqWithBody, createMockRes } from "../__tests__/helpers/http-mocks.js";

// --- Mocks ---

const mockSpawnAgent = vi.fn();
const mockCancelJob = vi.fn();
const mockGetJobStatus = vi.fn();
const mockBuildMcpSettings = vi.fn().mockReturnValue("/tmp/danxbot-mcp-test");
const mockCleanupMcpSettings = vi.fn();

vi.mock("../agent/launcher.js", () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  cancelJob: (...args: unknown[]) => mockCancelJob(...args),
  getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  buildMcpSettings: (...args: unknown[]) => mockBuildMcpSettings(...args),
  cleanupMcpSettings: (...args: unknown[]) => mockCleanupMcpSettings(...args),
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
    expect(body.job_id).toBe("job-abc-123");
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
        prompt: "Build schema",
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

    expect(mockBuildMcpSettings).toHaveBeenCalledWith({
      apiToken: "tok-abc",
      apiUrl: "http://custom-api.com",
      schemaDefinitionId: "def-42",
      schemaRole: "builder",
    });
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
    const mockJob = { id: "job-completed", status: "completed", summary: "Done", startedAt: new Date(), completedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);

    const cancelReq = createMockReqWithBody("POST", { api_token: "tok-123" });
    const cancelRes = createMockRes();
    await handleCancel(cancelReq, cancelRes, "job-completed");

    expect(cancelRes._getStatusCode()).toBe(409);
  });

  it("returns 200 on successful cancel", async () => {
    const mockJob = { id: "job-to-cancel", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);
    mockCancelJob.mockResolvedValue(undefined);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
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

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "job-stopped");

    expect(stopRes._getStatusCode()).toBe(409);
  });

  it("returns 500 when job has no stop method", async () => {
    const mockJob = { id: "job-no-stop", status: "running", summary: "", startedAt: new Date() };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", { task: "Test task", api_token: "tok-123" });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "job-no-stop");

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

    const stopReq = createMockReqWithBody("POST", { status: "completed", summary: "All done" });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "job-stoppable");

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

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "job-default-status");

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

    const stopReq = createMockReqWithBody("POST", { status: "failed", summary: "Something went wrong" });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "job-fail-stop");

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
