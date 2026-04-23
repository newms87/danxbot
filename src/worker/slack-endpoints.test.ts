/**
 * Tests for the per-dispatch Slack MCP-callback endpoints:
 *   POST /api/slack/reply/:dispatchId
 *   POST /api/slack/update/:dispatchId
 *
 * These endpoints are the worker's side of the `danxbot_slack_reply` and
 * `danxbot_slack_post_update` MCP tools. The agent POSTs `{text}`; the
 * handler looks up the dispatch, reads the Slack thread metadata, and
 * calls `chat.postMessage` via the repo's already-running bolt client.
 *
 * Phase 1 of the Slack unified dispatch epic (Trello `kMQ170Ea`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import { createMockWebClient } from "../__tests__/helpers/slack-mock.js";

// --- Mocks ---

const mockGetDispatchById = vi.fn();
vi.mock("../dashboard/dispatches-db.js", () => ({
  getDispatchById: (...args: unknown[]) => mockGetDispatchById(...args),
}));

const mockGetSlackClientForRepo = vi.fn();
vi.mock("../slack/listener.js", () => ({
  getSlackClientForRepo: (...args: unknown[]) =>
    mockGetSlackClientForRepo(...args),
}));

vi.mock("../config.js", () => ({
  config: {
    isHost: false,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 3600000,
    },
    logsDir: "/tmp/danxbot-slack-endpoints-logs",
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

// dispatch.ts transitively imports agent/launcher which reaches into the
// settings-file + critical-failure modules. Mock both so module load
// doesn't touch the real filesystem or fail on missing env vars.
vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock("../critical-failure.js", () => ({
  writeFlag: vi.fn(),
  readFlag: vi.fn().mockReturnValue(null),
  clearFlag: vi.fn().mockReturnValue(false),
  flagPath: (localPath: string) => `${localPath}/.danxbot/CRITICAL_FAILURE`,
}));

import { handleSlackReply, handleSlackUpdate } from "./dispatch.js";

const MOCK_REPO = makeRepoContext();
const DISPATCH_ID = "slack-dispatch-uuid";
const CHANNEL = "C0123456";
const THREAD_TS = "1700000000.000100";

function makeSlackDispatch(over: Record<string, unknown> = {}) {
  return {
    id: DISPATCH_ID,
    repoName: MOCK_REPO.name,
    trigger: "slack",
    triggerMetadata: {
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      messageTs: "1700000000.000200",
      user: "U0123456",
      userName: null,
      messageText: "why is X happening?",
    },
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
    summary: null,
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
    ...over,
  };
}

function makeApiDispatch(over: Record<string, unknown> = {}) {
  return {
    ...makeSlackDispatch(),
    trigger: "api",
    triggerMetadata: {
      endpoint: "/api/launch",
      callerIp: "127.0.0.1",
      statusUrl: null,
      initialPrompt: "task",
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// -------------------------------------------------------------------------
// handleSlackReply
// -------------------------------------------------------------------------

describe("handleSlackReply", () => {
  it("returns 404 when no dispatch with the given id exists", async () => {
    mockGetDispatchById.mockResolvedValue(null);
    const req = createMockReqWithBody("POST", { text: "hi" });
    const res = createMockRes();

    await handleSlackReply(req, res, "unknown-id", MOCK_REPO);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Dispatch not found" });
    expect(mockGetSlackClientForRepo).not.toHaveBeenCalled();
  });

  it("returns 404 when the dispatch exists but its trigger is NOT slack (fail loud — a non-Slack agent must not post to Slack)", async () => {
    mockGetDispatchById.mockResolvedValue(makeApiDispatch());
    const req = createMockReqWithBody("POST", { text: "hi" });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toMatchObject({
      error: expect.stringMatching(/slack/i),
    });
  });

  it("returns 400 when body.text is missing", async () => {
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toMatchObject({
      error: expect.stringMatching(/text/i),
    });
  });

  it("returns 400 when body.text is a blank string (whitespace-only counts as missing)", async () => {
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    const req = createMockReqWithBody("POST", { text: "   " });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 400 when body.text is not a string", async () => {
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    const req = createMockReqWithBody("POST", { text: 42 });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 500 when the Slack bolt client for the repo is unavailable (disconnected listener)", async () => {
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(undefined);
    const req = createMockReqWithBody("POST", { text: "hi" });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody())).toMatchObject({
      error: expect.stringMatching(/slack.*not connected|not available|unavailable/i),
    });
  });

  it("calls bolt.chat.postMessage with the right channel, thread_ts, and text and returns 200", async () => {
    const client = createMockWebClient();
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", {
      text: "Here's the answer: 42.",
    });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      text: "Here's the answer: 42.",
    });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ status: "posted" });
  });

  it("calls getSlackClientForRepo with the dispatch's repoName (same as the worker's repo post-guard)", async () => {
    // Post cross-worker guard, `dispatch.repoName` always equals
    // `repo.name` on success — but the handler still hands
    // `dispatch.repoName` to `getSlackClientForRepo`, not `repo.name`.
    // That's the enforcement seam: if the guard ever regressed,
    // routing would still prefer the dispatch's declared repo, not
    // the worker's closure. This test pins the argument source.
    const client = createMockWebClient();
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", { text: "hi" });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(mockGetSlackClientForRepo).toHaveBeenCalledWith(MOCK_REPO.name);
  });

  it("returns 500 when the request body is malformed JSON (parseBody throws)", async () => {
    // parseBody streams the request body and throws "Invalid JSON body"
    // on a malformed payload. The outer try/catch in handleSlackPost
    // converts that to a 500 — this is the one request-level error
    // class not covered by the other tests. Build a request that
    // emits non-JSON bytes so parseBody's catch block fires.
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    const http = await import("http");
    const req = new http.IncomingMessage(null as never);
    req.method = "POST";
    process.nextTick(() => {
      req.emit("data", Buffer.from("}{ not json"));
      req.emit("end");
    });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody())).toMatchObject({
      error: expect.stringMatching(/invalid json|reply failed/i),
    });
  });

  it("returns 500 when bolt.chat.postMessage throws (Slack API failure)", async () => {
    const client = createMockWebClient();
    client.chat.postMessage.mockRejectedValueOnce(new Error("slack 429"));
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", { text: "hi" });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody())).toMatchObject({
      error: expect.stringMatching(/slack 429|failed/i),
    });
  });
});

// -------------------------------------------------------------------------
// handleSlackUpdate (thin variant of handleSlackReply; same contract)
// -------------------------------------------------------------------------

describe("handleSlackUpdate", () => {
  it("returns 404 when the dispatch does not exist", async () => {
    mockGetDispatchById.mockResolvedValue(null);
    const req = createMockReqWithBody("POST", { text: "hi" });
    const res = createMockRes();

    await handleSlackUpdate(req, res, "unknown-id", MOCK_REPO);

    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 404 when the dispatch trigger is NOT slack", async () => {
    mockGetDispatchById.mockResolvedValue(makeApiDispatch());
    const req = createMockReqWithBody("POST", { text: "hi" });
    const res = createMockRes();

    await handleSlackUpdate(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 400 when body.text is missing", async () => {
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleSlackUpdate(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 400 when body.text is a blank string (parity with reply)", async () => {
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    const req = createMockReqWithBody("POST", { text: "   " });
    const res = createMockRes();

    await handleSlackUpdate(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 400 when body.text is not a string (parity with reply)", async () => {
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    const req = createMockReqWithBody("POST", { text: 42 });
    const res = createMockRes();

    await handleSlackUpdate(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 500 when the Slack bolt client is disconnected (parity with reply)", async () => {
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(undefined);
    const req = createMockReqWithBody("POST", { text: "status" });
    const res = createMockRes();

    await handleSlackUpdate(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
  });

  it("returns 500 when bolt.chat.postMessage throws (parity with reply)", async () => {
    const client = createMockWebClient();
    client.chat.postMessage.mockRejectedValueOnce(new Error("slack 429"));
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", { text: "status" });
    const res = createMockRes();

    await handleSlackUpdate(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
  });

  it("calls bolt.chat.postMessage with the right channel, thread_ts, and text", async () => {
    const client = createMockWebClient();
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", {
      text: "Reading the campaign schema now...",
    });
    const res = createMockRes();

    await handleSlackUpdate(req, res, DISPATCH_ID, MOCK_REPO);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      text: "Reading the campaign schema now...",
    });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ status: "posted" });
  });
});

describe("cross-worker guard", () => {
  // The dispatches table is shared across workers via a single MySQL
  // database. A POST to worker A with a dispatchId belonging to
  // worker B must NOT reach through to worker B's Slack workspace
  // (or, worse, leak the existence of other repos' dispatches via a
  // 500 message). The handler 404s the mismatch cleanly.
  it("returns 404 when the dispatch exists but is owned by a different repo's worker", async () => {
    mockGetDispatchById.mockResolvedValue(
      makeSlackDispatch({ repoName: "a-different-repo" }),
    );
    const req = createMockReqWithBody("POST", { text: "hi" });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toMatchObject({
      error: expect.stringMatching(/not owned by this worker/i),
    });
    // The cross-worker mismatch must short-circuit BEFORE calling
    // into the Slack client — otherwise a lookup against another
    // repo's bolt client could leak connection status.
    expect(mockGetSlackClientForRepo).not.toHaveBeenCalled();
  });

  it("mismatch check runs before the trigger check (fail loud on the specific mismatch, not with a generic 'not a Slack dispatch')", async () => {
    // A dispatch that's BOTH from another repo AND non-slack should
    // 404 with the cross-worker message, not the non-slack message —
    // the mismatch is the more specific explanation.
    mockGetDispatchById.mockResolvedValue(
      makeApiDispatch({ repoName: "a-different-repo" }),
    );
    const req = createMockReqWithBody("POST", { text: "hi" });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toMatchObject({
      error: expect.stringMatching(/not owned by this worker/i),
    });
  });
});
