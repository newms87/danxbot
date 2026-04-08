import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "http";

// Mock events module
const mockGetEvents = vi.fn();
const mockGetAnalytics = vi.fn();
const mockAddSSEClient = vi.fn();
const mockRemoveSSEClient = vi.fn();

vi.mock("./events.js", () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  getAnalytics: (...args: unknown[]) => mockGetAnalytics(...args),
  addSSEClient: (...args: unknown[]) => mockAddSSEClient(...args),
  removeSSEClient: (...args: unknown[]) => mockRemoveSSEClient(...args),
}));

// Mock export module
const mockEventsToCSV = vi.fn();
vi.mock("./export.js", () => ({
  eventsToCSV: (...args: unknown[]) => mockEventsToCSV(...args),
}));

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
  config: {},
}));

// Mock constants (prevents module-level YAML loading)
vi.mock("../poller/constants.js", () => ({
  getReposBase: () => "/danxbot/repos",
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// We need to test the server, but startDashboard hardcodes port 5555.
// We'll import the module and use it, but we need to handle the port.
// Since we're in a test environment, we'll use the actual server on a random port
// by mocking createServer to capture the handler.

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

// Helper to make a fake request/response pair
function createMockReqRes(method: string, url: string) {
  const req = new http.IncomingMessage(null as any);
  req.method = method;
  req.url = url;

  const headers: Record<string, string | number> = {};
  let statusCode = 200;
  let body = "";

  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }),
    end: vi.fn((data?: string) => {
      if (data) body = data;
    }),
    write: vi.fn(),
    getHeader: vi.fn((name: string) => headers[name.toLowerCase()]),
    _getStatusCode: () => statusCode,
    _getHeaders: () => headers,
    _getBody: () => body,
  };

  return { req, res: res as any };
}

describe("dashboard server", () => {
  beforeAll(async () => {
    await startDashboard();
  });

  it("GET /api/events returns 200 with JSON array", async () => {
    const events = [{ id: "test-1", status: "complete" }];
    mockGetEvents.mockReturnValue(events);

    const { req, res } = createMockReqRes("GET", "/api/events");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()["content-type"]).toBe("application/json");
    expect(JSON.parse(res._getBody())).toEqual(events);
  });

  it("GET /api/events has CORS header", async () => {
    mockGetEvents.mockReturnValue([]);

    const { req, res } = createMockReqRes("GET", "/api/events");
    await requestHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
  });

  it("GET /api/events/:id/log returns event log when found", async () => {
    const event = {
      id: "abc-123",
      text: "hello",
      status: "complete",
      agentLog: [{ type: "text", content: "log entry" }],
    };
    mockGetEvents.mockReturnValue([event]);

    const { req, res } = createMockReqRes("GET", "/api/events/abc-123/log");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.id).toBe("abc-123");
    expect(body.text).toBe("hello");
    expect(body.status).toBe("complete");
    expect(body.agentLog).toEqual([{ type: "text", content: "log entry" }]);
  });

  it("GET /api/events/:id/log returns 404 when not found", async () => {
    mockGetEvents.mockReturnValue([]);

    const { req, res } = createMockReqRes("GET", "/api/events/nonexistent/log");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Event not found" });
  });

  it("GET /api/analytics returns 200 with analytics object", async () => {
    const analytics = { totalMessages: 10, errorCount: 1 };
    mockGetAnalytics.mockReturnValue(analytics);

    const { req, res } = createMockReqRes("GET", "/api/analytics");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()["content-type"]).toBe("application/json");
    expect(JSON.parse(res._getBody())).toEqual(analytics);
  });

  it("GET /api/stream sets SSE headers and registers client", async () => {
    const { req, res } = createMockReqRes("GET", "/api/stream");
    await requestHandler(req, res);

    expect(res._getHeaders()["content-type"]).toBe("text/event-stream");
    expect(res._getHeaders()["cache-control"]).toBe("no-cache");
    expect(res._getHeaders()["connection"]).toBe("keep-alive");
    expect(mockAddSSEClient).toHaveBeenCalledWith(expect.any(Function));
  });

  it("GET /api/stream removes client on connection close", async () => {
    const { req, res } = createMockReqRes("GET", "/api/stream");
    await requestHandler(req, res);

    // Simulate connection close
    req.emit("close");

    expect(mockRemoveSSEClient).toHaveBeenCalledWith(expect.any(Function));
  });

  it("GET /api/stream registered client writes SSE-formatted data to response", async () => {
    const { req, res } = createMockReqRes("GET", "/api/stream");
    await requestHandler(req, res);

    // Capture the client function that was registered
    const clientFn = mockAddSSEClient.mock.calls[mockAddSSEClient.mock.calls.length - 1][0];
    expect(clientFn).toBeTypeOf("function");

    // Invoke it like broadcast() would
    clientFn('{"id":"test-1","status":"complete"}');

    // Should write SSE-formatted data to the response
    expect(res.write).toHaveBeenCalledWith('data: {"id":"test-1","status":"complete"}\n\n');
  });

  it("GET / returns 200 with HTML content", async () => {
    mockReadFile.mockResolvedValue("<html>Dashboard</html>");

    const { req, res } = createMockReqRes("GET", "/");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeaders()["content-type"]).toBe("text/html");
    expect(res._getBody()).toBe("<html>Dashboard</html>");
  });

  it("GET /index.html returns 200 with HTML content", async () => {
    mockReadFile.mockResolvedValue("<html>Dashboard</html>");

    const { req, res } = createMockReqRes("GET", "/index.html");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
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
    mockGetAnalytics.mockReturnValue({});

    const { req, res } = createMockReqRes("GET", "/api/analytics");
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
    expect(res._getHeaders()["content-type"]).toBe("application/json");
    expect(JSON.parse(res._getBody())).toEqual(healthData);
  });

  it("GET /health response includes all required fields", async () => {
    const healthData = {
      status: "ok",
      uptime_seconds: 60,
      slack_connected: true,
      db_connected: true,
      events_count: 10,
      memory_usage_mb: 50.1,
    };
    mockGetHealthStatus.mockResolvedValue(healthData);

    const { req, res } = createMockReqRes("GET", "/health");
    await requestHandler(req, res);

    const body = JSON.parse(res._getBody());
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("uptime_seconds");
    expect(body).toHaveProperty("slack_connected");
    expect(body).toHaveProperty("db_connected");
    expect(body).toHaveProperty("events_count");
    expect(body).toHaveProperty("memory_usage_mb");
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

  describe("GET /api/events/export", () => {
    it("returns JSON download with Content-Disposition header", async () => {
      const events = [{ id: "test-1", status: "complete" }];
      mockGetEvents.mockReturnValue(events);

      const { req, res } = createMockReqRes("GET", "/api/events/export?format=json");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("application/json");
      expect(res._getHeaders()["content-disposition"]).toBe('attachment; filename="danxbot-events.json"');
      expect(JSON.parse(res._getBody())).toEqual(events);
    });

    it("returns CSV download with Content-Disposition header", async () => {
      const events = [{ id: "test-1", status: "complete" }];
      mockGetEvents.mockReturnValue(events);
      mockEventsToCSV.mockReturnValue("timestamp,user,text,status,cost,feedback,response_time_ms\n");

      const { req, res } = createMockReqRes("GET", "/api/events/export?format=csv");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("text/csv");
      expect(res._getHeaders()["content-disposition"]).toBe('attachment; filename="danxbot-events.csv"');
      expect(mockEventsToCSV).toHaveBeenCalledWith(events);
    });

    it("returns 400 when format query param is missing", async () => {
      const { req, res } = createMockReqRes("GET", "/api/events/export");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getBody())).toEqual({ error: 'Missing or invalid format parameter. Use "json" or "csv".' });
    });

    it("returns 400 when format is invalid", async () => {
      const { req, res } = createMockReqRes("GET", "/api/events/export?format=xml");
      await requestHandler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getBody())).toEqual({ error: 'Missing or invalid format parameter. Use "json" or "csv".' });
    });
  });
});
