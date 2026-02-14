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

// Mock fs/promises for the HTML file read
const mockReadFile = vi.fn();
vi.mock("fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// Mock config
vi.mock("../config.js", () => ({
  config: {},
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

  it("GET /unknown returns 404 Not found", async () => {
    const { req, res } = createMockReqRes("GET", "/unknown");
    await requestHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(res._getBody()).toBe("Not found");
  });

  it("all routes include CORS header", async () => {
    mockGetAnalytics.mockReturnValue({});

    const { req, res } = createMockReqRes("GET", "/api/analytics");
    await requestHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
  });
});
