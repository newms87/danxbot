import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import http from "http";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import { createMockReqRes } from "../__tests__/helpers/http-mocks.js";

// --- Mocks ---

const mockGetHealthStatus = vi.fn();
vi.mock("./health.js", () => ({
  getHealthStatus: (...args: unknown[]) => mockGetHealthStatus(...args),
}));

const mockHandleLaunch = vi.fn();
const mockHandleCancel = vi.fn();
const mockHandleStatus = vi.fn();
const mockHandleStop = vi.fn();
const mockHandleResume = vi.fn();
const mockHandleSlackReply = vi.fn();
const mockHandleSlackUpdate = vi.fn();
vi.mock("./dispatch.js", () => ({
  handleLaunch: (...args: unknown[]) => mockHandleLaunch(...args),
  handleCancel: (...args: unknown[]) => mockHandleCancel(...args),
  handleStatus: (...args: unknown[]) => mockHandleStatus(...args),
  handleStop: (...args: unknown[]) => mockHandleStop(...args),
  handleResume: (...args: unknown[]) => mockHandleResume(...args),
  handleSlackReply: (...args: unknown[]) => mockHandleSlackReply(...args),
  handleSlackUpdate: (...args: unknown[]) => mockHandleSlackUpdate(...args),
}));

const mockHandleClearCriticalFailure = vi.fn();
vi.mock("./critical-failure-route.js", () => ({
  handleClearCriticalFailure: (...args: unknown[]) =>
    mockHandleClearCriticalFailure(...args),
}));

const mockHandleRestart = vi.fn();
vi.mock("./restart-route.js", () => ({
  handleRestart: (...args: unknown[]) => mockHandleRestart(...args),
}));

const mockSeedCooldown = vi.fn().mockResolvedValue(undefined);
vi.mock("./restart.js", () => ({
  seedCooldownFromDb: (...args: unknown[]) => mockSeedCooldown(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Capture the request handler from createServer
let requestHandler: http.RequestListener;
const mockServer = {
  listen: vi.fn((_port: number, cb: () => void) => cb()),
  close: vi.fn((cb?: () => void) => cb?.()),
};

vi.mock("http", async () => {
  const actual = await vi.importActual<typeof import("http")>("http");
  return {
    ...actual,
    createServer: (handler: http.RequestListener) => {
      requestHandler = handler;
      return mockServer;
    },
  };
});

import { startWorkerServer } from "./server.js";

const MOCK_REPO = makeRepoContext();

let bootSeedCalls: unknown[][] = [];

describe("worker server", () => {
  beforeAll(async () => {
    await startWorkerServer(MOCK_REPO);
    bootSeedCalls = mockSeedCooldown.mock.calls.map((c) => [...c]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("boot — restart cooldown seed", () => {
    it("calls seedCooldownFromDb with the repo name", () => {
      expect(bootSeedCalls.length).toBeGreaterThanOrEqual(1);
      expect(bootSeedCalls[0][0]).toBe(MOCK_REPO.name);
    });
  });

  describe("GET /health", () => {
    it("returns 200 when healthy", async () => {
      const health = {
        status: "ok",
        repo: "test-repo",
        uptime_seconds: 60,
        slack_connected: true,
        slack_expected: true,
        db_connected: true,
        memory_usage_mb: 50.1,
        queued_messages: 0,
        queue_by_thread: {},
      };
      mockGetHealthStatus.mockResolvedValue(health);

      const { req, res } = createMockReqRes("GET", "/health");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getBody())).toEqual(health);
    });

    it("returns 503 when degraded", async () => {
      const health = {
        status: "degraded",
        repo: "test-repo",
        uptime_seconds: 60,
        slack_connected: false,
        slack_expected: true,
        db_connected: true,
        memory_usage_mb: 50.1,
        queued_messages: 0,
        queue_by_thread: {},
      };
      mockGetHealthStatus.mockResolvedValue(health);

      const { req, res } = createMockReqRes("GET", "/health");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(503);
      expect(JSON.parse(res._getBody())).toEqual(health);
    });

    it("includes all expected fields", async () => {
      mockGetHealthStatus.mockResolvedValue({
        status: "ok",
        repo: "test-repo",
        uptime_seconds: 120,
        slack_connected: true,
        slack_expected: true,
        db_connected: true,
        memory_usage_mb: 64.3,
        queued_messages: 2,
        queue_by_thread: { "thread-1": 1, "thread-2": 1 },
      });

      const { req, res } = createMockReqRes("GET", "/health");
      await requestHandler(req, res);

      const body = JSON.parse(res._getBody());
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("repo");
      expect(body).toHaveProperty("uptime_seconds");
      expect(body).toHaveProperty("slack_connected");
      expect(body).toHaveProperty("slack_expected");
      expect(body).toHaveProperty("db_connected");
      expect(body).toHaveProperty("memory_usage_mb");
      expect(body).toHaveProperty("queued_messages");
      expect(body).toHaveProperty("queue_by_thread");
    });

    it("sets CORS header", async () => {
      mockGetHealthStatus.mockResolvedValue({ status: "ok" });

      const { req, res } = createMockReqRes("GET", "/health");
      await requestHandler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
    });

    it("passes repo context to getHealthStatus", async () => {
      mockGetHealthStatus.mockResolvedValue({ status: "ok" });

      const { req, res } = createMockReqRes("GET", "/health");
      await requestHandler(req, res);

      expect(mockGetHealthStatus).toHaveBeenCalledWith(MOCK_REPO);
    });
  });

  describe("POST /api/launch", () => {
    it("delegates to handleLaunch with req, res, and repo", async () => {
      mockHandleLaunch.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes("POST", "/api/launch");
      await requestHandler(req, res);

      expect(mockHandleLaunch).toHaveBeenCalledWith(req, res, MOCK_REPO);
    });

    it("does not match GET /api/launch", async () => {
      const { req, res } = createMockReqRes("GET", "/api/launch");
      await requestHandler(req, res);

      expect(mockHandleLaunch).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(404);
    });
  });

  describe("POST /api/cancel/:jobId", () => {
    it("delegates to handleCancel with req, res, and jobId", async () => {
      mockHandleCancel.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes("POST", "/api/cancel/job-123");
      await requestHandler(req, res);

      expect(mockHandleCancel).toHaveBeenCalledWith(req, res, "job-123");
    });

    it("does not match GET /api/cancel/:jobId", async () => {
      const { req, res } = createMockReqRes("GET", "/api/cancel/job-123");
      await requestHandler(req, res);

      expect(mockHandleCancel).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(404);
    });
  });

  describe("POST /api/stop/:jobId", () => {
    it("delegates to handleStop with req, res, jobId, and the worker's repo", async () => {
      mockHandleStop.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes("POST", "/api/stop/job-789");
      await requestHandler(req, res);

      expect(mockHandleStop).toHaveBeenCalledWith(req, res, "job-789", MOCK_REPO);
    });

    it("does not match GET /api/stop/:jobId", async () => {
      const { req, res } = createMockReqRes("GET", "/api/stop/job-789");
      await requestHandler(req, res);

      expect(mockHandleStop).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(404);
    });
  });

  describe("POST /api/slack/reply/:dispatchId", () => {
    it("delegates to handleSlackReply with req, res, dispatchId, and the worker's repo", async () => {
      mockHandleSlackReply.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes(
        "POST",
        "/api/slack/reply/slack-job-xyz",
      );
      await requestHandler(req, res);

      expect(mockHandleSlackReply).toHaveBeenCalledWith(
        req,
        res,
        "slack-job-xyz",
        MOCK_REPO,
      );
    });

    it("does not match GET /api/slack/reply/:dispatchId", async () => {
      const { req, res } = createMockReqRes(
        "GET",
        "/api/slack/reply/slack-job-xyz",
      );
      await requestHandler(req, res);

      expect(mockHandleSlackReply).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(404);
    });
  });

  describe("POST /api/slack/update/:dispatchId", () => {
    it("delegates to handleSlackUpdate with req, res, dispatchId, and the worker's repo", async () => {
      mockHandleSlackUpdate.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes(
        "POST",
        "/api/slack/update/slack-job-xyz",
      );
      await requestHandler(req, res);

      expect(mockHandleSlackUpdate).toHaveBeenCalledWith(
        req,
        res,
        "slack-job-xyz",
        MOCK_REPO,
      );
    });

    it("does not match GET /api/slack/update/:dispatchId", async () => {
      const { req, res } = createMockReqRes(
        "GET",
        "/api/slack/update/slack-job-xyz",
      );
      await requestHandler(req, res);

      expect(mockHandleSlackUpdate).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(404);
    });
  });

  describe("DELETE /api/poller/critical-failure", () => {
    it("delegates to handleClearCriticalFailure with req, res, and the worker's repo", async () => {
      mockHandleClearCriticalFailure.mockResolvedValue(undefined);

      const { req, res } = createMockReqRes(
        "DELETE",
        "/api/poller/critical-failure",
      );
      await requestHandler(req, res);

      expect(mockHandleClearCriticalFailure).toHaveBeenCalledWith(
        req,
        res,
        MOCK_REPO,
      );
    });

    it("does not match GET /api/poller/critical-failure", async () => {
      const { req, res } = createMockReqRes(
        "GET",
        "/api/poller/critical-failure",
      );
      await requestHandler(req, res);

      expect(mockHandleClearCriticalFailure).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(404);
    });
  });

  describe("POST /api/restart/:dispatchId", () => {
    it("delegates to handleRestart with req, res, dispatchId, and the worker's repo", async () => {
      mockHandleRestart.mockResolvedValue(undefined);
      const { req, res } = createMockReqRes(
        "POST",
        "/api/restart/dispatch-abc",
      );
      await requestHandler(req, res);
      expect(mockHandleRestart).toHaveBeenCalledWith(
        req,
        res,
        "dispatch-abc",
        MOCK_REPO,
      );
    });

    it("does not match GET /api/restart/:dispatchId", async () => {
      const { req, res } = createMockReqRes("GET", "/api/restart/dispatch-abc");
      await requestHandler(req, res);
      expect(mockHandleRestart).not.toHaveBeenCalled();
      expect(res._getStatusCode()).toBe(404);
    });
  });

  describe("GET /api/status/:jobId", () => {
    it("delegates to handleStatus with res and jobId", async () => {
      const { req, res } = createMockReqRes("GET", "/api/status/job-456");
      await requestHandler(req, res);

      expect(mockHandleStatus).toHaveBeenCalledWith(res, "job-456");
    });

    it("does not match POST /api/status/:jobId", async () => {
      const { req, res } = createMockReqRes("POST", "/api/status/job-456");
      await requestHandler(req, res);

      expect(mockHandleStatus).not.toHaveBeenCalled();
    });
  });

  describe("unknown routes", () => {
    it("GET /unknown returns 404", async () => {
      const { req, res } = createMockReqRes("GET", "/unknown");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(404);
      expect(JSON.parse(res._getBody())).toEqual({ error: "Not found" });
    });

    it("POST /unknown returns 404", async () => {
      const { req, res } = createMockReqRes("POST", "/unknown");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(404);
    });

    it("GET / returns 404", async () => {
      const { req, res } = createMockReqRes("GET", "/");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(404);
    });
  });
});
