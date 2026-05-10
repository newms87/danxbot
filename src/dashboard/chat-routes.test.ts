import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMockReqRes,
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";

const mockGetDispatchById = vi.fn();
const mockListDispatchesByIssueId = vi.fn();
const mockListBoardChatDispatches = vi.fn();
const mockGetResumeChain = vi.fn();
vi.mock("./dispatches-db.js", () => ({
  getDispatchById: (...args: unknown[]) => mockGetDispatchById(...args),
  listDispatchesByIssueId: (...args: unknown[]) =>
    mockListDispatchesByIssueId(...args),
  listBoardChatDispatches: (...args: unknown[]) =>
    mockListBoardChatDispatches(...args),
  getResumeChain: (...args: unknown[]) => mockGetResumeChain(...args),
}));

const mockResolveJsonlPath = vi.fn();
vi.mock("./jsonl-path-resolver.js", () => ({
  resolveJsonlPath: (...args: unknown[]) => mockResolveJsonlPath(...args),
}));

const mockReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

const mockProxy = vi.fn();
vi.mock("./dispatch-proxy.js", () => ({
  proxyToWorkerWithFallback: (...args: unknown[]) => mockProxy(...args),
}));

const mockHandleStream = vi.fn();
vi.mock("./stream-routes.js", () => ({
  handleStream: (...args: unknown[]) => mockHandleStream(...args),
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
  handleCancelChatSession,
  handleChatStream,
  handleChatTimeline,
  handleListBoardChatSessions,
  handleListChatSessions,
  handleResumeChatSession,
  handleStartBoardChat,
} from "./chat-routes.js";

const FAKE_DEPS = {
  token: "tok-test",
  repos: [
    {
      name: "danxbot",
      url: "git@github.com:danxbot",
      workerPort: 5562,
      workerHost: undefined,
      localPath: "/repo",
      runtime: "docker" as const,
    },
  ],
  resolveHost: (name: string) => `danxbot-worker-${name}`,
} as never;

function makeDispatch(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "job-1",
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {},
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: "sess-1",
    jsonlPath: "/tmp/sess-1.jsonl",
    parentJobId: null,
    issueId: "DX-84",
    status: "completed",
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
    summary: "shipped",
    error: null,
    runtimeMode: "docker",
    hostPid: null,
    hostPidAt: null,
    pidTerminatedAt: null,
    tokensTotal: 100,
    tokensIn: 60,
    tokensOut: 40,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 3,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    agentName: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("handleListChatSessions", () => {
  it("400s without issue_id", async () => {
    const { res } = createMockReqRes("GET", "/api/chat/sessions");
    await handleListChatSessions(res, new URLSearchParams());
    expect(res._getStatusCode()).toBe(400);
  });

  it("returns the projection shape for the issue's dispatches", async () => {
    mockListDispatchesByIssueId.mockResolvedValueOnce([makeDispatch()]);
    const { res } = createMockReqRes(
      "GET",
      "/api/chat/sessions?issue_id=DX-84",
    );
    await handleListChatSessions(
      res,
      new URLSearchParams({ issue_id: "DX-84" }),
    );
    expect(mockListDispatchesByIssueId).toHaveBeenCalledWith("DX-84");
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body).toHaveLength(1);
    expect(body[0].job_id).toBe("job-1");
    expect(body[0].issue_id).toBe("DX-84");
    expect(body[0].tokens_total).toBe(100);
  });
});

describe("handleListBoardChatSessions", () => {
  it("400s without repo", async () => {
    const { res } = createMockReqRes("GET", "/api/chat/sessions/board");
    await handleListBoardChatSessions(res, new URLSearchParams());
    expect(res._getStatusCode()).toBe(400);
  });

  it("forwards repo to the DB helper", async () => {
    mockListBoardChatDispatches.mockResolvedValueOnce([makeDispatch()]);
    const { res } = createMockReqRes(
      "GET",
      "/api/chat/sessions/board?repo=danxbot",
    );
    await handleListBoardChatSessions(
      res,
      new URLSearchParams({ repo: "danxbot" }),
    );
    expect(mockListBoardChatDispatches).toHaveBeenCalledWith("danxbot");
    expect(res._getStatusCode()).toBe(200);
  });
});

describe("handleChatTimeline", () => {
  it("404s when chain is empty", async () => {
    mockGetResumeChain.mockResolvedValueOnce([]);
    const { res } = createMockReqRes("GET", "/api/chat/sessions/x/timeline");
    await handleChatTimeline(res, "x");
    expect(res._getStatusCode()).toBe(404);
  });

  it("merges blocks across the resume chain and dedupes shared JSONL paths", async () => {
    const parent = makeDispatch({ id: "p1" });
    const child = makeDispatch({ id: "c1", parentJobId: "p1" });
    mockGetResumeChain.mockResolvedValueOnce([parent, child]);
    // Both ancestors share the same JSONL path → readFile only called once.
    mockResolveJsonlPath.mockResolvedValue("/tmp/shared.jsonl");
    // Multi-block assistant turn with the same `message.id` repeated —
    // parseJsonlContent should keep one usage entry.
    const usageLine = JSON.stringify({
      type: "assistant",
      timestamp: "2025-01-01T00:00:00Z",
      message: {
        id: "msg-1",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "tu-1", name: "Read", input: {} },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    // Two assistant entries from the same response → same message.id →
    // dedupe must collapse usage to ONE accumulation, not two.
    mockReadFile.mockResolvedValue(`${usageLine}\n${usageLine}\n`);

    const { res } = createMockReqRes("GET", "/api/chat/sessions/c1/timeline");
    await handleChatTimeline(res, "c1");
    expect(res._getStatusCode()).toBe(200);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res._getBody());
    expect(body.totals.tokensIn).toBe(100);
    expect(body.totals.tokensOut).toBe(50);
    expect(body.chain).toEqual(["p1", "c1"]);
  });
});

describe("handleStartBoardChat", () => {
  it("400s on missing repo or task", async () => {
    const req = createMockReqWithBody("POST", { repo: "danxbot" });
    const res = createMockRes();
    await handleStartBoardChat(req, res, FAKE_DEPS);
    expect(res._getStatusCode()).toBe(400);
  });

  it("404s on unknown repo", async () => {
    const req = createMockReqWithBody("POST", { repo: "ghost", task: "hi" });
    const res = createMockRes();
    await handleStartBoardChat(req, res, FAKE_DEPS);
    expect(res._getStatusCode()).toBe(404);
  });

  it("forwards to /api/launch with workspace=board-chat", async () => {
    mockProxy.mockImplementationOnce(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job_id: "new-1", status: "launched" }));
    });
    const req = createMockReqWithBody("POST", {
      repo: "danxbot",
      task: "hello",
    });
    const res = createMockRes();
    await handleStartBoardChat(req, res, FAKE_DEPS);
    expect(mockProxy).toHaveBeenCalledOnce();
    const [, , upstream, body] = mockProxy.mock.calls[0];
    expect(upstream.path).toBe("/api/launch");
    expect(JSON.parse(body)).toEqual({
      repo: "danxbot",
      workspace: "board-chat",
      task: "hello",
    });
  });
});

describe("handleResumeChatSession", () => {
  it("404s when dispatch missing", async () => {
    mockGetDispatchById.mockResolvedValueOnce(null);
    const req = createMockReqWithBody("POST", { task: "next" });
    const res = createMockRes();
    await handleResumeChatSession(req, res, "job-1", FAKE_DEPS);
    expect(res._getStatusCode()).toBe(404);
  });

  it("forwards repo + job_id + task + workspace to /api/resume (board-chat workspace inherited from parent)", async () => {
    // Board-chat resume: parent dispatch was launched via `/api/launch`
    // with `workspace: "board-chat"` and the worker stamped that into
    // triggerMetadata.workspace. The resume MUST forward the same
    // workspace because /api/resume → parseDispatchRequest hard-requires
    // it (400 "Missing workspace" otherwise).
    mockGetDispatchById.mockResolvedValueOnce(
      makeDispatch({
        trigger: "api",
        triggerMetadata: {
          endpoint: "/api/launch",
          callerIp: null,
          statusUrl: null,
          initialPrompt: "hi",
          workspace: "board-chat",
        },
      }),
    );
    mockProxy.mockImplementationOnce(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          job_id: "child-1",
          parent_job_id: "job-1",
          status: "launched",
        }),
      );
    });
    const req = createMockReqWithBody("POST", { task: "next" });
    const res = createMockRes();
    await handleResumeChatSession(req, res, "job-1", FAKE_DEPS);
    expect(mockProxy).toHaveBeenCalledOnce();
    const [, , upstream, body] = mockProxy.mock.calls[0];
    expect(upstream.path).toBe("/api/resume");
    expect(JSON.parse(body)).toEqual({
      repo: "danxbot",
      job_id: "job-1",
      task: "next",
      workspace: "board-chat",
    });
  });

  it("falls back to workspace=issue-worker for legacy trello-trigger rows that predate the workspace stamp", async () => {
    // Pre-DX-84 trello-trigger dispatches have no `workspace` key on
    // triggerMetadata. The poller path is always `issue-worker`, so we
    // default to that name to keep resume working on historical rows.
    mockGetDispatchById.mockResolvedValueOnce(
      makeDispatch({
        trigger: "trello",
        triggerMetadata: {
          cardId: "ext-1",
          cardName: "DX-84",
          cardUrl: "u",
          listId: "l",
          listName: "ToDo",
        },
      }),
    );
    mockProxy.mockImplementationOnce(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          job_id: "child-1",
          parent_job_id: "job-1",
          status: "launched",
        }),
      );
    });
    const req = createMockReqWithBody("POST", { task: "next" });
    const res = createMockRes();
    await handleResumeChatSession(req, res, "job-1", FAKE_DEPS);
    const [, , , body] = mockProxy.mock.calls[0];
    expect(JSON.parse(body).workspace).toBe("issue-worker");
  });
});

describe("handleCancelChatSession", () => {
  it("404s when dispatch missing", async () => {
    mockGetDispatchById.mockResolvedValueOnce(null);
    const { req, res } = createMockReqRes(
      "POST",
      "/api/chat/sessions/job-x/cancel",
    );
    await handleCancelChatSession(req, res, "job-x", FAKE_DEPS);
    expect(res._getStatusCode()).toBe(404);
  });

  it("forwards to /api/cancel/:id with the dispatch's repo", async () => {
    mockGetDispatchById.mockResolvedValueOnce(makeDispatch());
    mockProxy.mockImplementationOnce(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "canceled" }));
    });
    const { req, res } = createMockReqRes(
      "POST",
      "/api/chat/sessions/job-1/cancel",
    );
    await handleCancelChatSession(req, res, "job-1", FAKE_DEPS);
    expect(mockProxy).toHaveBeenCalledOnce();
    const [, , upstream] = mockProxy.mock.calls[0];
    expect(upstream.path).toBe("/api/cancel/job-1");
    expect(upstream.repoName).toBe("danxbot");
  });
});

describe("handleChatStream", () => {
  it("delegates to handleStream with dispatch:jsonl:<id>", async () => {
    const { req, res } = createMockReqRes(
      "GET",
      "/api/chat/sessions/job-1/stream",
    );
    await handleChatStream(req, res, "job-1");
    expect(mockHandleStream).toHaveBeenCalledOnce();
    const [, , params] = mockHandleStream.mock.calls[0];
    expect(params.get("topics")).toBe("dispatch:jsonl:job-1");
  });
});
