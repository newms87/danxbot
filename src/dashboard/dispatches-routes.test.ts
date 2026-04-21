import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createMockReqRes } from "../__tests__/helpers/http-mocks.js";

const mockGetDispatchById = vi.fn();
const mockListDispatches = vi.fn();
vi.mock("./dispatches-db.js", () => ({
  getDispatchById: (...args: unknown[]) => mockGetDispatchById(...args),
  listDispatches: (...args: unknown[]) => mockListDispatches(...args),
}));

const mockParseJsonlFile = vi.fn();
const mockParseJsonlContent = vi.fn();
vi.mock("./jsonl-reader.js", () => ({
  parseJsonlFile: (...args: unknown[]) => mockParseJsonlFile(...args),
  parseJsonlContent: (...args: unknown[]) => mockParseJsonlContent(...args),
}));

const mockStat = vi.fn();
const mockOpen = vi.fn();
const mockReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  open: (...args: unknown[]) => mockOpen(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

const mockCreateReadStream = vi.fn();
vi.mock("node:fs", () => ({
  createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  handleFollowDispatch,
  handleGetDispatch,
  handleListDispatches,
  handleRawJsonl,
} from "./dispatches-routes.js";

function makeDispatch(overrides = {}) {
  return {
    id: "job-1",
    repoName: "danxbot",
    trigger: "api",
    triggerMetadata: {
      endpoint: "/api/launch",
      callerIp: null,
      statusUrl: null,
      initialPrompt: "prompt",
    },
    sessionUuid: "sess-1",
    jsonlPath: "/tmp/sess-1.jsonl",
    parentJobId: null,
    status: "completed",
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
    summary: "done",
    error: null,
    runtimeMode: "docker",
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("handleListDispatches", () => {
  it("returns rows unfiltered when no query params", async () => {
    mockListDispatches.mockResolvedValueOnce([makeDispatch()]);
    const { res } = createMockReqRes("GET", "/api/dispatches");
    await handleListDispatches(res, new URLSearchParams());
    expect(res._getStatusCode()).toBe(200);
    expect(mockListDispatches).toHaveBeenCalledWith({});
  });

  it("passes only the known filters through", async () => {
    mockListDispatches.mockResolvedValueOnce([]);
    const { res } = createMockReqRes("GET", "/api/dispatches?trigger=slack&repo=platform&status=failed&since=1000&q=deploy");
    await handleListDispatches(
      res,
      new URLSearchParams({
        trigger: "slack",
        repo: "platform",
        status: "failed",
        since: "1000",
        q: "deploy",
      }),
    );
    expect(mockListDispatches).toHaveBeenCalledWith({
      trigger: "slack",
      repo: "platform",
      status: "failed",
      since: 1000,
      q: "deploy",
    });
  });

  it("rejects unknown trigger/status values silently (ignores them)", async () => {
    mockListDispatches.mockResolvedValueOnce([]);
    const { res } = createMockReqRes("GET", "/");
    await handleListDispatches(
      res,
      new URLSearchParams({ trigger: "bogus", status: "bogus" }),
    );
    expect(mockListDispatches).toHaveBeenCalledWith({});
  });

  it("returns 500 on listDispatches failure", async () => {
    mockListDispatches.mockRejectedValueOnce(new Error("db"));
    const { res } = createMockReqRes("GET", "/");
    await handleListDispatches(res, new URLSearchParams());
    expect(res._getStatusCode()).toBe(500);
  });
});

describe("handleGetDispatch", () => {
  it("returns 404 when dispatch not found", async () => {
    mockGetDispatchById.mockResolvedValueOnce(null);
    const { res } = createMockReqRes("GET", "/api/dispatches/xyz");
    await handleGetDispatch(res, "xyz");
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns dispatch + parsed timeline when jsonlPath exists", async () => {
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch());
    mockParseJsonlFile.mockResolvedValueOnce({
      blocks: [
        { type: "assistant_text", text: "hi", timestampMs: 1 },
      ],
      totals: {
        tokensIn: 10,
        tokensOut: 5,
        cacheRead: 0,
        cacheWrite: 0,
        tokensTotal: 15,
        toolCallCount: 0,
        subagentCount: 0,
      },
      sessionId: "sess-1",
    });
    const { res } = createMockReqRes("GET", "/api/dispatches/job-1");
    await handleGetDispatch(res, "job-1");

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.dispatch.id).toBe("job-1");
    expect(body.timeline).toHaveLength(1);
    expect(body.totals.tokensTotal).toBe(15);
  });

  it("returns dispatch with empty timeline when no path info is available", async () => {
    // Both jsonlPath and sessionUuid are null → resolveJsonlPath returns null
    // even via the sessionUuid fallback strategy.
    mockGetDispatchById.mockResolvedValueOnce(
      makeDispatch({ jsonlPath: null, sessionUuid: null }),
    );
    const { res } = createMockReqRes("GET", "/api/dispatches/job-1");
    await handleGetDispatch(res, "job-1");

    const body = JSON.parse(res._getBody());
    expect(body.timeline).toEqual([]);
    expect(body.totals).toBeNull();
    expect(mockParseJsonlFile).not.toHaveBeenCalled();
  });

  it("resolves via strategy-2 (translated worker path) when stored path is unreachable", async () => {
    // Strategy 1: stored worker-internal path fails (not accessible in dashboard).
    // Strategy 2: translated path succeeds (per-repo RO mount).
    const workerPath =
      "/home/danxbot/.claude/projects/-danxbot-app-repos-danxbot/sess-docker.jsonl";
    mockGetDispatchById.mockResolvedValueOnce(
      makeDispatch({ jsonlPath: workerPath }),
    );
    mockParseJsonlFile.mockResolvedValueOnce({
      blocks: [{ type: "assistant_text", text: "hi", timestampMs: 1 }],
      totals: {
        tokensIn: 5,
        tokensOut: 3,
        cacheRead: 0,
        cacheWrite: 0,
        tokensTotal: 8,
        toolCallCount: 0,
        subagentCount: 0,
      },
      sessionId: "sess-docker",
    });
    // Strategy 1 stat fails (stored path not accessible in dashboard container).
    // Strategy 2 stat succeeds (translated path under /danxbot/app/claude-projects/).
    const translatedPath =
      "/danxbot/app/claude-projects/danxbot/-danxbot-app-repos-danxbot/sess-docker.jsonl";
    mockStat.mockImplementation((p: string) =>
      p === translatedPath ? Promise.resolve({ size: 100 }) : Promise.reject(new Error("ENOENT")),
    );

    const { res } = createMockReqRes("GET", "/api/dispatches/job-1");
    await handleGetDispatch(res, "job-1");

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.timeline).toHaveLength(1);
    expect(mockParseJsonlFile).toHaveBeenCalledWith(translatedPath);
  });

  it("returns 500 when parseJsonlFile throws after resolving the path", async () => {
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch());
    mockParseJsonlFile.mockRejectedValueOnce(new Error("corrupt jsonl"));

    const { res } = createMockReqRes("GET", "/api/dispatches/job-1");
    await handleGetDispatch(res, "job-1");
    expect(res._getStatusCode()).toBe(500);
  });

  it("returns 500 on DB failure", async () => {
    mockGetDispatchById.mockRejectedValueOnce(new Error("db"));
    const { res } = createMockReqRes("GET", "/api/dispatches/job-1");
    await handleGetDispatch(res, "job-1");
    expect(res._getStatusCode()).toBe(500);
  });
});

describe("handleRawJsonl", () => {
  it("returns 404 when dispatch missing", async () => {
    mockGetDispatchById.mockResolvedValueOnce(null);
    const { res } = createMockReqRes("GET", "/api/dispatches/x/raw");
    await handleRawJsonl(res, "x");
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 404 with 'No JSONL recorded' message when no path info is available", async () => {
    // Both jsonlPath and sessionUuid are null → resolveJsonlPath returns null
    // even via the sessionUuid fallback strategy.
    mockGetDispatchById.mockResolvedValueOnce(
      makeDispatch({ jsonlPath: null, sessionUuid: null }),
    );
    const { res } = createMockReqRes("GET", "/api/dispatches/x/raw");
    await handleRawJsonl(res, "x");
    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toBe("No JSONL recorded for this dispatch");
  });

  it("returns 404 with 'JSONL file no longer available' when path recorded but all strategies fail", async () => {
    // resolveJsonlPath tries up to 3 strategies (stored path, translated path,
    // computed-from-uuid path); reject ALL stat calls so every strategy fails.
    // Because dispatch.jsonlPath is set, the message differs from the no-path case.
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch());
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const { res } = createMockReqRes("GET", "/api/dispatches/x/raw");
    await handleRawJsonl(res, "x");
    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toBe("JSONL file no longer available");
  });

  it("returns 404 with 'JSONL file no longer available' when only sessionUuid is set but file is missing", async () => {
    // jsonlPath is null but sessionUuid is set → resolveJsonlPath tries strategy 3
    // (computeDashboardJsonlPath from sessionUuid); if that also misses, the
    // message should be "no longer available" because we know a session happened.
    mockGetDispatchById.mockResolvedValueOnce(
      makeDispatch({ jsonlPath: null, sessionUuid: "orphan-session" }),
    );
    mockStat.mockRejectedValue(new Error("ENOENT"));
    const { res } = createMockReqRes("GET", "/api/dispatches/x/raw");
    await handleRawJsonl(res, "x");
    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toBe("JSONL file no longer available");
  });

  it("returns 500 on DB failure", async () => {
    mockGetDispatchById.mockRejectedValueOnce(new Error("db"));
    const { res } = createMockReqRes("GET", "/api/dispatches/x/raw");
    await handleRawJsonl(res, "x");
    expect(res._getStatusCode()).toBe(500);
  });

  it("streams the JSONL with attachment headers when file exists", async () => {
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch());
    mockStat.mockResolvedValueOnce({ size: 100 });
    // fakeStream must support the .on("error", ...).pipe(res) chain used in handleRawJsonl
    const fakeStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValueOnce(fakeStream);

    const { res } = createMockReqRes("GET", "/api/dispatches/job-1/raw");
    await handleRawJsonl(res, "job-1");

    expect(res._getHeaders()["content-type"]).toBe("application/x-ndjson");
    expect(res._getHeaders()["content-disposition"]).toBe(
      'attachment; filename="job-1.jsonl"',
    );
    expect(fakeStream.pipe).toHaveBeenCalledWith(res);
  });
});

describe("handleFollowDispatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 404 when dispatch missing", async () => {
    mockGetDispatchById.mockResolvedValueOnce(null);
    const { req, res } = createMockReqRes("GET", "/api/dispatches/x/follow");
    await handleFollowDispatch(req, res, "x");
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 404 when no path info is available", async () => {
    mockGetDispatchById.mockResolvedValueOnce(
      makeDispatch({ jsonlPath: null, sessionUuid: null }),
    );
    const { req, res } = createMockReqRes("GET", "/api/dispatches/x/follow");
    await handleFollowDispatch(req, res, "x");
    expect(res._getStatusCode()).toBe(404);
  });

  it("writes SSE headers and primes the client with existing blocks", async () => {
    vi.useFakeTimers();
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch());
    mockReadFile.mockResolvedValueOnce('{"type":"text","text":"hello"}\n');
    mockParseJsonlContent.mockReturnValueOnce({
      blocks: [{ type: "assistant_text", text: "hello", timestampMs: 1 }],
      totals: {
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokensTotal: 0,
        toolCallCount: 0,
        subagentCount: 0,
      },
      sessionId: "sess-1",
    });

    const { req, res } = createMockReqRes("GET", "/api/dispatches/job-1/follow");
    await handleFollowDispatch(req, res, "job-1");

    expect(res._getHeaders()["content-type"]).toBe("text/event-stream");
    expect(res._getHeaders()["cache-control"]).toBe("no-cache");
    expect(res._getHeaders()["x-accel-buffering"]).toBe("no");
    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining('"assistant_text"'),
    );
  });

  it("writes SSE headers even when the initial file read fails", async () => {
    vi.useFakeTimers();
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch({ status: "running" }));
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
    // Make tick's open() also reject so the tick loop stays clean with fake timers
    mockOpen.mockRejectedValue(new Error("ENOENT"));

    const { req, res } = createMockReqRes("GET", "/api/dispatches/job-1/follow");
    await handleFollowDispatch(req, res, "job-1");

    expect(res._getHeaders()["content-type"]).toBe("text/event-stream");
    expect(res._getHeaders()["cache-control"]).toBe("no-cache");
    expect(res._getHeaders()["x-accel-buffering"]).toBe("no");
    // No blocks written since the file didn't exist
    expect(res.write).not.toHaveBeenCalled();
  });

  it("stops writing after client disconnects", async () => {
    vi.useFakeTimers();
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch({ status: "running" }));
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT")); // priming fails, no blocks written
    mockOpen.mockRejectedValue(new Error("ENOENT")); // ticks also fail

    const { req, res } = createMockReqRes("GET", "/api/dispatches/job-1/follow");
    await handleFollowDispatch(req, res, "job-1");

    // Simulate client closing the connection
    req.emit("close");

    // After close, the tick loop should bail immediately without writing
    await vi.advanceTimersByTimeAsync(1000);

    expect(res.write).not.toHaveBeenCalled();
  });

  it("closes the SSE stream when the dispatch reaches a terminal status", async () => {
    const fakeFh = {
      stat: vi.fn().mockResolvedValue({ size: 0 }),
      read: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockOpen.mockResolvedValue(fakeFh);
    // Priming fails (file not yet created) — tick will retry
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
    // Initial fetch → running; tick's re-fetch → completed
    mockGetDispatchById
      .mockResolvedValueOnce(makeDispatch({ status: "running" }))
      .mockResolvedValueOnce(makeDispatch({ status: "completed" }));

    const { req, res } = createMockReqRes("GET", "/api/dispatches/job-1/follow");
    await handleFollowDispatch(req, res, "job-1");
    // Allow tick()'s async chain (open → stat → close → getDispatchById → end) to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(res.end).toHaveBeenCalled();
  });
});
