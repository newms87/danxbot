import { describe, it, expect, beforeEach, vi } from "vitest";
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
  vi.clearAllMocks();
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

  it("returns dispatch with empty timeline when jsonlPath is null", async () => {
    mockGetDispatchById.mockResolvedValueOnce(
      makeDispatch({ jsonlPath: null }),
    );
    const { res } = createMockReqRes("GET", "/api/dispatches/job-1");
    await handleGetDispatch(res, "job-1");

    const body = JSON.parse(res._getBody());
    expect(body.timeline).toEqual([]);
    expect(body.totals).toBeNull();
    expect(mockParseJsonlFile).not.toHaveBeenCalled();
  });
});

describe("handleRawJsonl", () => {
  it("returns 404 when dispatch missing", async () => {
    mockGetDispatchById.mockResolvedValueOnce(null);
    const { res } = createMockReqRes("GET", "/api/dispatches/x/raw");
    await handleRawJsonl(res, "x");
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 404 when jsonlPath is null", async () => {
    mockGetDispatchById.mockResolvedValueOnce(
      makeDispatch({ jsonlPath: null }),
    );
    const { res } = createMockReqRes("GET", "/api/dispatches/x/raw");
    await handleRawJsonl(res, "x");
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 404 when the file no longer exists", async () => {
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch());
    mockStat.mockRejectedValueOnce(new Error("ENOENT"));
    const { res } = createMockReqRes("GET", "/api/dispatches/x/raw");
    await handleRawJsonl(res, "x");
    expect(res._getStatusCode()).toBe(404);
  });

  it("streams the JSONL with attachment headers when file exists", async () => {
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch());
    mockStat.mockResolvedValueOnce({ size: 100 });
    const fakeStream = { pipe: vi.fn() };
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
