import { describe, it, expect, vi, beforeAll } from "vitest";
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

// Mock config
vi.mock("../config.js", () => ({
  repos: [
    { name: "platform", url: "https://github.com/test/platform.git", localPath: "/danxbot/repos/platform" },
    { name: "danxbot", url: "https://github.com/test/danxbot.git", localPath: "/danxbot/repos/danxbot" },
  ],
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Capture the request handler registered by createServer so we can invoke it directly.
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

  it("GET /api/repos returns configured repos", async () => {
    const { req, res } = createMockReqRes("GET", "/api/repos");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()["content-type"]).toBe("application/json");
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

  it("GET /unknown serves index.html as SPA fallback", async () => {
    mockReadFile.mockResolvedValue("<html>Dashboard</html>");

    const { req, res } = createMockReqRes("GET", "/unknown");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()["content-type"]).toBe("text/html");
    expect(res._getBody()).toBe("<html>Dashboard</html>");
  });

  it("GET /unknown returns 404 when dashboard not built", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const { req, res } = createMockReqRes("GET", "/unknown");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(res._getBody()).toBe("Dashboard not built. Run: cd dashboard && npm run build");
  });

  it("all routes include CORS header", async () => {
    const { req, res } = createMockReqRes("GET", "/api/repos");
    await requestHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
  });

  it("GET /health returns 200 with JSON when healthy", async () => {
    const healthData = {
      status: "ok",
      uptime_seconds: 120,
      slack_connected: true,
      db_connected: true,
      events_count: 5,
      memory_usage_mb: 64.3,
    };
    mockGetHealthStatus.mockResolvedValue(healthData);

    const { req, res } = createMockReqRes("GET", "/health");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()["content-type"]).toBe("application/json");
    expect(JSON.parse(res._getBody())).toEqual(healthData);
  });

  it("GET /health returns 503 when degraded", async () => {
    const healthData = {
      status: "degraded",
      uptime_seconds: 120,
      slack_connected: false,
      db_connected: true,
      events_count: 0,
      memory_usage_mb: 64.3,
    };
    mockGetHealthStatus.mockResolvedValue(healthData);

    const { req, res } = createMockReqRes("GET", "/health");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getBody())).toEqual(healthData);
  });

  describe("static asset serving", () => {
    it("GET /assets/*.js serves with correct MIME type and immutable cache", async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue("console.log('app')");

      const { req, res } = createMockReqRes("GET", "/assets/index-abc123.js");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("application/javascript");
      expect(res._getHeaders()["cache-control"]).toBe("public, max-age=31536000, immutable");
    });

    it("GET /assets/*.css serves with correct MIME type", async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue("body { color: red }");

      const { req, res } = createMockReqRes("GET", "/assets/index-abc123.css");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("text/css");
    });

    it("GET /assets/nonexistent returns 404", async () => {
      mockAccess.mockRejectedValue(new Error("ENOENT"));

      const { req, res } = createMockReqRes("GET", "/assets/nonexistent.js");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(404);
    });
  });
});
