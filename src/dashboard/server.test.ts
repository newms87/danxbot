import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import http from "http";
import { createMockReqRes } from "../__tests__/helpers/http-mocks.js";

// Mock health module
const mockGetHealthStatus = vi.fn();
vi.mock("./health.js", () => ({
  getHealthStatus: (...args: unknown[]) => mockGetHealthStatus(...args),
}));

// Mock fs/promises for file reads and access checks
const mockReadFile = vi.fn();
const mockAccess = vi.fn();
vi.mock("fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  access: (...args: unknown[]) => mockAccess(...args),
}));

// Short-circuit DNS lookups during unit tests; real resolution would hang on
// container hostnames that only exist on `danxbot-net`.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => ({ address: "127.0.0.1", family: 4, host })),
}));

// Mock config — dashboard sees two repos with worker ports.
vi.mock("../config.js", () => ({
  repos: [
    {
      name: "platform",
      url: "https://github.com/test/platform.git",
      localPath: "/danxbot/repos/platform",
      workerPort: 5561,
    },
    {
      name: "danxbot",
      url: "https://github.com/test/danxbot.git",
      localPath: "/danxbot/repos/danxbot",
      workerPort: 5562,
    },
  ],
}));

// Stub dispatch-proxy so we only verify the router wires routes correctly;
// the proxy logic itself has its own test file.
const mockHandleLaunchProxy = vi.fn();
const mockHandleJobProxy = vi.fn();
vi.mock("./dispatch-proxy.js", () => ({
  handleLaunchProxy: (...args: unknown[]) => mockHandleLaunchProxy(...args),
  handleJobProxy: (...args: unknown[]) => mockHandleJobProxy(...args),
  loadDispatchToken: () => "test-token",
  workerHost: (name: string) => `test-worker-${name}`,
}));

// Stub dispatches-routes so router tests don't hit the dispatch DB.
const mockHandleListDispatches = vi.fn();
const mockHandleGetDispatch = vi.fn();
const mockHandleRawJsonl = vi.fn();
const mockHandleFollowDispatch = vi.fn();
vi.mock("./dispatches-routes.js", () => ({
  handleListDispatches: (...args: unknown[]) => mockHandleListDispatches(...args),
  handleGetDispatch: (...args: unknown[]) => mockHandleGetDispatch(...args),
  handleRawJsonl: (...args: unknown[]) => mockHandleRawJsonl(...args),
  handleFollowDispatch: (...args: unknown[]) => mockHandleFollowDispatch(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

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

import { startDashboard } from "./server.js";

describe("dashboard server", () => {
  beforeAll(async () => {
    await startDashboard();
  });

  beforeEach(() => {
    mockReadFile.mockReset();
    mockAccess.mockReset();
    mockHandleLaunchProxy.mockReset();
    mockHandleJobProxy.mockReset();
    mockHandleListDispatches.mockReset();
    mockHandleGetDispatch.mockReset();
    mockHandleRawJsonl.mockReset();
    mockHandleFollowDispatch.mockReset();
    mockGetHealthStatus.mockReset();
  });

  describe("known routes", () => {
    it("GET /api/repos returns configured repos (without workerPort)", async () => {
      const { req, res } = createMockReqRes("GET", "/api/repos");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getBody())).toEqual([
        { name: "platform", url: "https://github.com/test/platform.git" },
        { name: "danxbot", url: "https://github.com/test/danxbot.git" },
      ]);
    });

    it("GET / returns 200 with HTML content", async () => {
      mockReadFile.mockResolvedValue("<html>Dashboard</html>");
      const { req, res } = createMockReqRes("GET", "/");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("text/html");
      expect(res._getBody()).toBe("<html>Dashboard</html>");
    });

    it("GET / returns 404 when dashboard not built", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const { req, res } = createMockReqRes("GET", "/");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(404);
      expect(res._getBody()).toContain("Dashboard not built");
    });

    it("GET /health returns 200 with JSON when healthy", async () => {
      mockGetHealthStatus.mockResolvedValue({
        status: "ok",
        uptime_seconds: 120,
        db_connected: true,
        memory_usage_mb: 64.3,
      });
      const { req, res } = createMockReqRes("GET", "/health");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("application/json");
    });

    it("GET /health returns 503 when degraded", async () => {
      mockGetHealthStatus.mockResolvedValue({
        status: "degraded",
        uptime_seconds: 120,
        db_connected: false,
        memory_usage_mb: 64.3,
      });
      const { req, res } = createMockReqRes("GET", "/health");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(503);
    });

    it("GET /assets/*.js serves with correct MIME type and immutable cache", async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue("console.log('app')");
      const { req, res } = createMockReqRes("GET", "/assets/index-abc123.js");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("application/javascript");
      expect(res._getHeaders()["cache-control"]).toBe("public, max-age=31536000, immutable");
    });

    it("GET /assets/nonexistent returns 404", async () => {
      mockAccess.mockRejectedValue(new Error("ENOENT"));
      const { req, res } = createMockReqRes("GET", "/assets/nope.js");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(404);
    });

    it("all routes include CORS header", async () => {
      const { req, res } = createMockReqRes("GET", "/api/repos");
      await requestHandler(req, res);
      expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
    });
  });

  describe("strict 404 for unknown routes", () => {
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
    const unknownPaths = [
      "/not-a-route",
      "/random/deep/path",
      "/api/unknown",
      "/api",
      "/unknown.html",
    ];

    for (const method of methods) {
      for (const path of unknownPaths) {
        it(`${method} ${path} returns 404 with JSON`, async () => {
          const { req, res } = createMockReqRes(method, path);
          await requestHandler(req, res);
          expect(res._getStatusCode()).toBe(404);
          expect(res._getHeaders()["content-type"]).toBe("application/json");
          expect(JSON.parse(res._getBody())).toEqual({ error: "Not found" });
        });
      }
    }

    it("POST / returns 404 (SPA routes only serve on GET)", async () => {
      const { req, res } = createMockReqRes("POST", "/");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(404);
      expect(JSON.parse(res._getBody())).toEqual({ error: "Not found" });
    });

    it("POST /health returns 404 (health is GET-only)", async () => {
      const { req, res } = createMockReqRes("POST", "/health");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(404);
    });

    it("GET /api/launch returns 404 (launch is POST-only)", async () => {
      const { req, res } = createMockReqRes("GET", "/api/launch");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(404);
      expect(mockHandleLaunchProxy).not.toHaveBeenCalled();
    });
  });

  describe("dispatch proxy wiring", () => {
    it("POST /api/launch forwards to handleLaunchProxy with token + repos", async () => {
      mockHandleLaunchProxy.mockImplementation(
        async (_req: unknown, res: http.ServerResponse) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ job_id: "j1", status: "launched" }));
        },
      );
      const { req, res } = createMockReqRes("POST", "/api/launch");
      await requestHandler(req, res);
      expect(mockHandleLaunchProxy).toHaveBeenCalledTimes(1);
      const [, , deps] = mockHandleLaunchProxy.mock.calls[0];
      expect(deps.token).toBe("test-token");
      expect(deps.repos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "platform", workerPort: 5561 }),
          expect.objectContaining({ name: "danxbot", workerPort: 5562 }),
        ]),
      );
      expect(typeof deps.resolveHost).toBe("function");
      expect(deps.resolveHost("platform")).toBe("test-worker-platform");
    });

    it("reuses the same deps object for every request (built once in startDashboard)", async () => {
      mockHandleLaunchProxy.mockImplementation(
        async (_req: unknown, res: http.ServerResponse) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        },
      );
      const { req: req1, res: res1 } = createMockReqRes("POST", "/api/launch");
      await requestHandler(req1, res1);
      const { req: req2, res: res2 } = createMockReqRes("POST", "/api/launch");
      await requestHandler(req2, res2);
      expect(mockHandleLaunchProxy).toHaveBeenCalledTimes(2);
      const deps1 = mockHandleLaunchProxy.mock.calls[0][2];
      const deps2 = mockHandleLaunchProxy.mock.calls[1][2];
      expect(deps1).toBe(deps2);
    });

    it("GET /api/status/:jobId forwards jobId + ?repo= to handleJobProxy", async () => {
      mockHandleJobProxy.mockImplementation(
        async (_req: unknown, res: http.ServerResponse) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        },
      );
      const { req, res } = createMockReqRes("GET", "/api/status/abc-123?repo=platform");
      await requestHandler(req, res);
      expect(mockHandleJobProxy).toHaveBeenCalledTimes(1);
      const [, , params] = mockHandleJobProxy.mock.calls[0];
      expect(params).toEqual({
        method: "GET",
        pathTemplate: "/api/status/:jobId",
        jobId: "abc-123",
        repoName: "platform",
      });
    });

    it("POST /api/cancel/:jobId forwards to handleJobProxy", async () => {
      mockHandleJobProxy.mockImplementation(
        async (_req: unknown, res: http.ServerResponse) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        },
      );
      const { req, res } = createMockReqRes("POST", "/api/cancel/abc-123?repo=danxbot");
      await requestHandler(req, res);
      expect(mockHandleJobProxy).toHaveBeenCalledTimes(1);
      const [, , params] = mockHandleJobProxy.mock.calls[0];
      expect(params).toEqual({
        method: "POST",
        pathTemplate: "/api/cancel/:jobId",
        jobId: "abc-123",
        repoName: "danxbot",
      });
    });

    it("POST /api/stop/:jobId forwards to handleJobProxy", async () => {
      mockHandleJobProxy.mockImplementation(
        async (_req: unknown, res: http.ServerResponse) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        },
      );
      const { req, res } = createMockReqRes("POST", "/api/stop/xyz?repo=platform");
      await requestHandler(req, res);
      expect(mockHandleJobProxy).toHaveBeenCalledTimes(1);
      const [, , params] = mockHandleJobProxy.mock.calls[0];
      expect(params.pathTemplate).toBe("/api/stop/:jobId");
      expect(params.jobId).toBe("xyz");
    });
  });

  describe("error handling", () => {
    it("returns 500 JSON when a route handler throws", async () => {
      mockHandleLaunchProxy.mockRejectedValue(new Error("boom"));
      const { req, res } = createMockReqRes("POST", "/api/launch");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(500);
      expect(JSON.parse(res._getBody())).toEqual({ error: "Internal server error" });
    });
  });
});
