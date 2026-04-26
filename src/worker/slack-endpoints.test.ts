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

// The sql:execute substitution layer. Default: passthrough (text
// unchanged, no attachments) — matches the no-block case so existing
// tests don't see any new behavior. Tests that exercise substitution
// override this implementation per-test.
const mockProcessResponseWithAttachments = vi.fn(
  async (text: string) => ({ text, attachments: [] as unknown[] }),
);
vi.mock("./sql-executor.js", () => ({
  processResponseWithAttachments: (...args: unknown[]) =>
    mockProcessResponseWithAttachments(...(args as [string])),
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

// -------------------------------------------------------------------------
// sql:execute substitution — the agent emits ` ```sql:execute ... ``` `
// blocks in its reply text; the worker MUST execute them via the
// platform DB pool, replace each block with a CSV-attachment reference,
// upload one CSV per result set in the same Slack thread, and post the
// substituted text. This is the contract retired in commit f2eeaba and
// re-introduced here.
// -------------------------------------------------------------------------

describe("sql:execute substitution in handleSlackReply", () => {
  const SQL_TEXT =
    "Counting suppliers:\n```sql:execute\nSELECT COUNT(*) FROM suppliers\n```\nDone.";

  it("substitutes the agent's reply text via processResponseWithAttachments before posting", async () => {
    mockProcessResponseWithAttachments.mockResolvedValueOnce({
      text: "Counting suppliers:\n_Query returned 1 row — see attached CSV._\nDone.",
      attachments: [
        {
          csv: "count\n42",
          filename: "query-result-1.csv",
          query: "SELECT COUNT(*) FROM suppliers",
        },
      ],
    });
    const client = createMockWebClient();
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", { text: SQL_TEXT });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(mockProcessResponseWithAttachments).toHaveBeenCalledWith(SQL_TEXT);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      text: "Counting suppliers:\n_Query returned 1 row — see attached CSV._\nDone.",
    });
    expect(res._getStatusCode()).toBe(200);
  });

  it("uploads each CSV attachment via filesUploadV2 in the same Slack thread, AFTER the substituted text is posted", async () => {
    mockProcessResponseWithAttachments.mockResolvedValueOnce({
      text: "substituted",
      attachments: [
        {
          csv: "count\n42",
          filename: "query-result-1.csv",
          query: "SELECT COUNT(*) FROM suppliers",
        },
        {
          csv: "name\nAlice",
          filename: "query-result-2.csv",
          query: "SELECT name FROM users LIMIT 1",
        },
      ],
    });
    const client = createMockWebClient();
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", { text: SQL_TEXT });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(client.filesUploadV2).toHaveBeenCalledTimes(2);
    expect(client.filesUploadV2).toHaveBeenNthCalledWith(1, {
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      filename: "query-result-1.csv",
      content: "count\n42",
      title: "query-result-1.csv",
    });
    expect(client.filesUploadV2).toHaveBeenNthCalledWith(2, {
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      filename: "query-result-2.csv",
      content: "name\nAlice",
      title: "query-result-2.csv",
    });
    // Text MUST be posted before the attachments. If a future refactor
    // inverts the order and `chat.postMessage` then fails, the
    // attachments would orphan in-thread with no parent message.
    const postOrder = client.chat.postMessage.mock.invocationCallOrder[0];
    const upload1Order = client.filesUploadV2.mock.invocationCallOrder[0];
    const upload2Order = client.filesUploadV2.mock.invocationCallOrder[1];
    expect(postOrder).toBeLessThan(upload1Order);
    expect(upload1Order).toBeLessThan(upload2Order);
    expect(res._getStatusCode()).toBe(200);
  });

  it("continues uploading subsequent attachments after one upload fails — no early break on rejection", async () => {
    mockProcessResponseWithAttachments.mockResolvedValueOnce({
      text: "substituted",
      attachments: [
        {
          csv: "first\n1",
          filename: "query-result-1.csv",
          query: "SELECT 1",
        },
        {
          csv: "second\n2",
          filename: "query-result-2.csv",
          query: "SELECT 2",
        },
      ],
    });
    const client = createMockWebClient();
    client.filesUploadV2
      .mockRejectedValueOnce(new Error("slack 503"))
      .mockResolvedValueOnce({});
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", { text: SQL_TEXT });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    // Both attempts must be made — the loop does not short-circuit on
    // the first rejection. Substituting an outer try/catch for the
    // per-attachment one would silently regress this guarantee.
    expect(client.filesUploadV2).toHaveBeenCalledTimes(2);
    expect(client.filesUploadV2).toHaveBeenNthCalledWith(2, {
      channel_id: CHANNEL,
      thread_ts: THREAD_TS,
      filename: "query-result-2.csv",
      content: "second\n2",
      title: "query-result-2.csv",
    });
    expect(res._getStatusCode()).toBe(200);
  });

  it("does not upload attachments when the substitution returns none (e.g. unsafe-query rejection)", async () => {
    mockProcessResponseWithAttachments.mockResolvedValueOnce({
      text: "_Only SELECT queries are allowed._",
      attachments: [],
    });
    const client = createMockWebClient();
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", {
      text: "```sql:execute\nDELETE FROM users\n```",
    });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      text: "_Only SELECT queries are allowed._",
    });
    expect(client.filesUploadV2).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
  });

  it("posts text verbatim and does NOT call the substitution layer when repo.db.enabled is false", async () => {
    // Repos like danxbot/gpt-manager have no platform DB. The agent
    // shouldn't emit sql:execute in those workers, but if it does the
    // worker must NOT call getPlatformPool() (which would throw) — it
    // posts the raw text and lets the failure surface to the user.
    const repoNoDb = makeRepoContext({
      db: { ...MOCK_REPO.db, enabled: false },
    });
    const client = createMockWebClient();
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", { text: SQL_TEXT });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, repoNoDb);

    expect(mockProcessResponseWithAttachments).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      text: SQL_TEXT,
    });
    expect(client.filesUploadV2).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
  });

  it("still posts the substituted text with status 200 when a CSV upload fails (Slack file-upload errors must not block the reply)", async () => {
    mockProcessResponseWithAttachments.mockResolvedValueOnce({
      text: "substituted",
      attachments: [
        {
          csv: "id\n1",
          filename: "query-result-1.csv",
          query: "SELECT id FROM x",
        },
      ],
    });
    const client = createMockWebClient();
    client.filesUploadV2.mockRejectedValueOnce(new Error("slack 500"));
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", { text: SQL_TEXT });
    const res = createMockRes();

    await handleSlackReply(req, res, DISPATCH_ID, MOCK_REPO);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });
});

// -------------------------------------------------------------------------
// Substitution applies to update-style replies as well — the agent uses
// `danxbot_slack_post_update` to stream interim findings ("Reading the
// schema…", "Found 42 suppliers"); those updates can also contain
// sql:execute blocks and must be substituted the same way.
// -------------------------------------------------------------------------

describe("sql:execute substitution in handleSlackUpdate", () => {
  it("posts text verbatim and does NOT call the substitution layer when repo.db.enabled is false (parity with reply-side passthrough)", async () => {
    const repoNoDb = makeRepoContext({
      db: { ...MOCK_REPO.db, enabled: false },
    });
    const client = createMockWebClient();
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", {
      text: "update with sql:\n```sql:execute\nSELECT 1\n```",
    });
    const res = createMockRes();

    await handleSlackUpdate(req, res, DISPATCH_ID, repoNoDb);

    expect(mockProcessResponseWithAttachments).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      text: "update with sql:\n```sql:execute\nSELECT 1\n```",
    });
    expect(client.filesUploadV2).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
  });

  it("substitutes update-style replies through the same processResponseWithAttachments path", async () => {
    mockProcessResponseWithAttachments.mockResolvedValueOnce({
      text: "Found 42 suppliers.",
      attachments: [
        {
          csv: "count\n42",
          filename: "query-result-1.csv",
          query: "SELECT COUNT(*) FROM suppliers",
        },
      ],
    });
    const client = createMockWebClient();
    mockGetDispatchById.mockResolvedValue(makeSlackDispatch());
    mockGetSlackClientForRepo.mockReturnValue(client);
    const req = createMockReqWithBody("POST", {
      text: "Counting...\n```sql:execute\nSELECT COUNT(*) FROM suppliers\n```",
    });
    const res = createMockRes();

    await handleSlackUpdate(req, res, DISPATCH_ID, MOCK_REPO);

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      text: "Found 42 suppliers.",
    });
    expect(client.filesUploadV2).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });
});
