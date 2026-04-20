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

// Stub only the per-request handlers so the router tests don't hit the
// real dispatch upstream. `extractBearer` + `checkAuth` are the real
// implementations — stubbing them would hide drift if either signature
// changes. `loadDispatchToken` + `workerHost` are trivial pure fns we
// override for deterministic expectations.
const mockHandleLaunchProxy = vi.fn();
const mockHandleResumeProxy = vi.fn();
const mockHandleJobProxy = vi.fn();
vi.mock("./dispatch-proxy.js", async () => {
  const actual =
    await vi.importActual<typeof import("./dispatch-proxy.js")>(
      "./dispatch-proxy.js",
    );
  return {
    ...actual,
    handleLaunchProxy: (...args: unknown[]) => mockHandleLaunchProxy(...args),
    handleResumeProxy: (...args: unknown[]) => mockHandleResumeProxy(...args),
    handleJobProxy: (...args: unknown[]) => mockHandleJobProxy(...args),
    loadDispatchToken: () => "test-token",
    workerHost: (name: string) => `test-worker-${name}`,
  };
});

// agents-routes imports from auth-middleware + dispatches-db — the dashboard
// side of the /api/agents/:repo/toggles handler. Stub it so server.test only
// verifies the wiring; agents-routes.test.ts owns the full-path coverage.
const mockHandleGetAgent = vi.fn();
const mockHandleListAgents = vi.fn();
const mockHandlePatchToggle = vi.fn();
vi.mock("./agents-routes.js", () => ({
  handleGetAgent: (...args: unknown[]) => mockHandleGetAgent(...args),
  handleListAgents: (...args: unknown[]) => mockHandleListAgents(...args),
  handlePatchToggle: (...args: unknown[]) => mockHandlePatchToggle(...args),
}));

// auth-routes depends on auth-db + auth-middleware; stub for the server test.
const mockHandleLogin = vi.fn();
const mockHandleLogout = vi.fn();
const mockHandleMe = vi.fn();
vi.mock("./auth-routes.js", () => ({
  handleLogin: (...args: unknown[]) => mockHandleLogin(...args),
  handleLogout: (...args: unknown[]) => mockHandleLogout(...args),
  handleMe: (...args: unknown[]) => mockHandleMe(...args),
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

// Per-user auth gate backing store. `ok-token` is the valid bearer for tests
// that exercise the authed path; anything else returns null (simulates
// unknown/revoked/expired). Keeps the gate behavior local to this file.
const mockValidateToken = vi.fn(async (t: string) =>
  t === "ok-token" ? { userId: 1, username: "tester" } : null,
);
const mockLoginDashboardUser = vi.fn();
const mockRevokeAllTokensForUser = vi.fn();

vi.mock("./auth-db.js", () => ({
  validateToken: (t: string) => mockValidateToken(t),
  loginDashboardUser: (...args: unknown[]) => mockLoginDashboardUser(...args),
  revokeAllTokensForUser: (...args: unknown[]) =>
    mockRevokeAllTokensForUser(...args),
}));

/** Attach an Authorization: Bearer header to a mock IncomingMessage. */
function withAuth(
  req: http.IncomingMessage,
  token = "ok-token",
): http.IncomingMessage {
  req.headers = { ...(req.headers ?? {}), authorization: `Bearer ${token}` };
  return req;
}

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
    mockHandleResumeProxy.mockReset();
    mockHandleJobProxy.mockReset();
    mockHandleListDispatches.mockReset();
    mockHandleGetDispatch.mockReset();
    mockHandleRawJsonl.mockReset();
    mockHandleFollowDispatch.mockReset();
    mockGetHealthStatus.mockReset();
    mockHandleGetAgent.mockReset();
    mockHandleListAgents.mockReset();
    mockHandlePatchToggle.mockReset();
    mockHandleLogin.mockReset();
    mockHandleLogout.mockReset();
    mockHandleMe.mockReset();
    mockValidateToken.mockClear();
    // Re-install the default implementation (mockReset would wipe it).
    mockValidateToken.mockImplementation(async (t: string) =>
      t === "ok-token" ? { userId: 1, username: "tester" } : null,
    );
  });

  describe("known routes", () => {
    it("GET /api/repos returns configured repos (without workerPort)", async () => {
      const { req, res } = createMockReqRes("GET", "/api/repos");
      withAuth(req);
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
      withAuth(req);
      await requestHandler(req, res);
      expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
    });
  });

  describe("strict 404 for unknown routes", () => {
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
    // Non-/api/ paths must 404 regardless of method, with or without auth.
    const nonApiUnknownPaths = ["/not-a-route", "/random/deep/path", "/unknown.html"];

    for (const method of methods) {
      for (const path of nonApiUnknownPaths) {
        it(`${method} ${path} returns 404 with JSON`, async () => {
          const { req, res } = createMockReqRes(method, path);
          await requestHandler(req, res);
          expect(res._getStatusCode()).toBe(404);
          expect(res._getHeaders()["content-type"]).toBe("application/json");
          expect(JSON.parse(res._getBody())).toEqual({ error: "Not found" });
        });
      }
    }

    // Unknown /api/* paths — with a valid bearer they must still 404
    // (the auth gate shouldn't turn a missing route into a pretend 401).
    const apiUnknownPaths = ["/api/unknown", "/api"];
    for (const method of methods) {
      for (const path of apiUnknownPaths) {
        it(`${method} ${path} with auth returns 404 with JSON`, async () => {
          const { req, res } = createMockReqRes(method, path);
          withAuth(req);
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

    it("GET /api/launch with auth returns 404 (launch is POST-only)", async () => {
      const { req, res } = createMockReqRes("GET", "/api/launch");
      withAuth(req);
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(404);
      expect(mockHandleLaunchProxy).not.toHaveBeenCalled();
    });
  });

  describe("auth gate", () => {
    it("GET /api/repos without auth returns 401", async () => {
      const { req, res } = createMockReqRes("GET", "/api/repos");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(401);
      expect(JSON.parse(res._getBody())).toEqual({ error: "Unauthorized" });
    });

    it("GET /api/dispatches without auth returns 401", async () => {
      const { req, res } = createMockReqRes("GET", "/api/dispatches");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(401);
      expect(mockHandleListDispatches).not.toHaveBeenCalled();
    });

    it("GET /api/agents without auth returns 401", async () => {
      const { req, res } = createMockReqRes("GET", "/api/agents");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(401);
    });

    it("GET /api/agents/danxbot without auth returns 401", async () => {
      const { req, res } = createMockReqRes("GET", "/api/agents/danxbot");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(401);
    });

    it("GET / serves index.html unconditionally (no auth required)", async () => {
      mockReadFile.mockResolvedValue("<html>Dashboard</html>");
      const { req, res } = createMockReqRes("GET", "/");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(200);
    });

    it("GET /health open without auth", async () => {
      mockGetHealthStatus.mockResolvedValue({
        status: "ok",
        uptime_seconds: 1,
        db_connected: true,
        memory_usage_mb: 10,
      });
      const { req, res } = createMockReqRes("GET", "/health");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(200);
    });

    it("GET /assets/foo.js open without auth", async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue("//js");
      const { req, res } = createMockReqRes("GET", "/assets/foo.js");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(200);
    });

    it("GET /api/repos with invalid bearer returns 401", async () => {
      const { req, res } = createMockReqRes("GET", "/api/repos");
      withAuth(req, "bogus-token");
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(401);
    });

    it("GET /api/dispatches/:id/follow requires a header bearer (no query-token fallback)", async () => {
      mockHandleFollowDispatch.mockImplementation(
        async (_req: unknown, res: http.ServerResponse) => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end("");
        },
      );

      // No Authorization header → 401 even when `?token=` is present.
      const unauthed = createMockReqRes(
        "GET",
        "/api/dispatches/abc-123/follow?token=ok-token",
      );
      await requestHandler(unauthed.req, unauthed.res);
      expect(unauthed.res._getStatusCode()).toBe(401);
      expect(mockHandleFollowDispatch).not.toHaveBeenCalled();

      // With the real bearer header → handler runs.
      const authed = createMockReqRes("GET", "/api/dispatches/abc-123/follow");
      withAuth(authed.req);
      await requestHandler(authed.req, authed.res);
      expect(mockHandleFollowDispatch).toHaveBeenCalledTimes(1);
    });

    it("array-form Authorization header is accepted", async () => {
      const { req, res } = createMockReqRes("GET", "/api/repos");
      // Node preserves repeated headers as a string[]. Cast through unknown
      // because `IncomingMessage.headers.authorization` is string|undefined
      // in the public typing but the underlying implementation accepts
      // arrays via raw headers.
      (req.headers as unknown as Record<string, unknown>).authorization = [
        "Bearer ok-token",
      ];
      await requestHandler(req, res);
      expect(res._getStatusCode()).toBe(200);
    });

    it("dispatch-proxy routes are NOT gated by user auth (they use their own token)", async () => {
      mockHandleLaunchProxy.mockImplementation(
        async (_req: unknown, res: http.ServerResponse) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        },
      );
      const { req, res } = createMockReqRes("POST", "/api/launch");
      // No Authorization header — the handler itself checks the dispatch token.
      await requestHandler(req, res);
      expect(mockHandleLaunchProxy).toHaveBeenCalledTimes(1);
      expect(res._getStatusCode()).toBe(200);
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
