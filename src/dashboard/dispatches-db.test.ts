import { describe, it, expect, beforeEach, vi } from "vitest";

const mockQuery = vi.fn();
const mockExecute = vi.fn();
const mockGetPool = vi.fn(() => ({
  query: mockQuery,
  execute: mockExecute,
}));

vi.mock("../db/connection.js", () => ({
  getPool: () => mockGetPool(),
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
  insertDispatch,
  updateDispatch,
  getDispatchById,
  listDispatches,
  deleteOldDispatches,
  rowToDispatch,
  dispatchToInsertParams,
} from "./dispatches-db.js";
import type {
  Dispatch,
  SlackTriggerMetadata,
  TrelloTriggerMetadata,
  ApiTriggerMetadata,
} from "./dispatches.js";

function makeSlackMeta(
  overrides: Partial<SlackTriggerMetadata> = {},
): SlackTriggerMetadata {
  return {
    channelId: "C123",
    threadTs: "1234.5678",
    messageTs: "1234.5679",
    user: "U1",
    userName: "Dan",
    messageText: "hi bot",
    ...overrides,
  };
}

function makeTrelloMeta(
  overrides: Partial<TrelloTriggerMetadata> = {},
): TrelloTriggerMetadata {
  return {
    cardId: "69e2791f427067165a204807",
    cardName: "Sample card",
    cardUrl: "https://trello.com/c/AbCdEfGh",
    listId: "list-in-progress",
    listName: "In Progress",
    ...overrides,
  };
}

function makeApiMeta(
  overrides: Partial<ApiTriggerMetadata> = {},
): ApiTriggerMetadata {
  return {
    endpoint: "/api/launch",
    callerIp: "10.0.0.1",
    statusUrl: "http://localhost:80/api/dispatches/1/status",
    initialPrompt: "Do the thing",
    ...overrides,
  };
}

function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "job-abc",
    repoName: "danxbot",
    trigger: "api",
    triggerMetadata: makeApiMeta(),
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    status: "running",
    startedAt: 1_700_000_000_000,
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
    danxbotCommit: "abc1234",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue([[], []]);
  mockQuery.mockResolvedValue([[], []]);
});

describe("dispatchToInsertParams", () => {
  it("serializes trigger metadata as JSON", () => {
    const d = makeDispatch({
      trigger: "slack",
      triggerMetadata: makeSlackMeta(),
      slackThreadTs: "1234.5678",
      slackChannelId: "C123",
    });
    const params = dispatchToInsertParams(d);
    const meta = params[3] as string;
    expect(typeof meta).toBe("string");
    expect(JSON.parse(meta)).toEqual(makeSlackMeta());
  });

  it("writes slack_thread_ts + slack_channel_id at their declared positions for slack dispatches", () => {
    // Mirror assertion for the new denormalized columns — same load-
    // bearing positional binding as parentJobId. A re-order of
    // COLUMN_MAP is caught here instead of silently misaligning Slack
    // thread data with some unrelated column at write time.
    const d = makeDispatch({
      trigger: "slack",
      triggerMetadata: makeSlackMeta(),
      slackThreadTs: "1234.5678",
      slackChannelId: "C123",
    });
    const params = dispatchToInsertParams(d);
    const orderedKeys: Array<keyof typeof d> = [
      "id", "repoName", "trigger", "triggerMetadata",
      "slackThreadTs", "slackChannelId",
      "sessionUuid", "jsonlPath", "parentJobId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "tokensTotal", "tokensIn", "tokensOut", "cacheRead", "cacheWrite",
      "toolCallCount", "subagentCount", "nudgeCount", "danxbotCommit",
    ];
    expect(params[orderedKeys.indexOf("slackThreadTs")]).toBe("1234.5678");
    expect(params[orderedKeys.indexOf("slackChannelId")]).toBe("C123");
  });

  it("writes null in the slack columns for non-Slack dispatches", () => {
    const d = makeDispatch(); // default trigger: api
    const params = dispatchToInsertParams(d);
    const orderedKeys: Array<keyof typeof d> = [
      "id", "repoName", "trigger", "triggerMetadata",
      "slackThreadTs", "slackChannelId",
      "sessionUuid", "jsonlPath", "parentJobId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "tokensTotal", "tokensIn", "tokensOut", "cacheRead", "cacheWrite",
      "toolCallCount", "subagentCount", "nudgeCount", "danxbotCommit",
    ];
    expect(params[orderedKeys.indexOf("slackThreadTs")]).toBeNull();
    expect(params[orderedKeys.indexOf("slackChannelId")]).toBeNull();
  });

  it("passes scalar fields straight through", () => {
    const d = makeDispatch({ id: "xyz", startedAt: 123, tokensIn: 42 });
    const params = dispatchToInsertParams(d);
    expect(params[0]).toBe("xyz");
    expect(params[1]).toBe("danxbot");
  });

  it("serializes parentJobId at its declared position in ORDERED_KEYS", () => {
    // COLUMN_MAP iteration order is load-bearing — the INSERT statement binds
    // placeholders positionally. If someone re-orders the map, the parent id
    // silently lands in the wrong column. This test locks the contract: the
    // value that went in as `parentJobId` must come out of the params array
    // next to the corresponding column name.
    const d = makeDispatch({ parentJobId: "parent-aea75840" });
    const params = dispatchToInsertParams(d);

    // Reconstruct the column→value mapping from INSERT_SQL order so a re-ordering
    // of COLUMN_MAP is caught here rather than surfacing as data corruption.
    // We look up the column index the same way dispatches-db.ts does: iterate
    // ORDERED_KEYS in declaration order and find parentJobId.
    const orderedKeys: Array<keyof typeof d> = [
      "id", "repoName", "trigger", "triggerMetadata",
      "slackThreadTs", "slackChannelId",
      "sessionUuid", "jsonlPath", "parentJobId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "tokensTotal", "tokensIn", "tokensOut", "cacheRead", "cacheWrite",
      "toolCallCount", "subagentCount", "nudgeCount", "danxbotCommit",
    ];
    const idx = orderedKeys.indexOf("parentJobId");
    expect(params[idx]).toBe("parent-aea75840");
  });

  it("sends null when parentJobId is null (launch path, not a resume)", () => {
    const d = makeDispatch({ parentJobId: null });
    const params = dispatchToInsertParams(d);
    const orderedKeys: Array<keyof typeof d> = [
      "id", "repoName", "trigger", "triggerMetadata",
      "slackThreadTs", "slackChannelId",
      "sessionUuid", "jsonlPath", "parentJobId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "tokensTotal", "tokensIn", "tokensOut", "cacheRead", "cacheWrite",
      "toolCallCount", "subagentCount", "nudgeCount", "danxbotCommit",
    ];
    const idx = orderedKeys.indexOf("parentJobId");
    expect(params[idx]).toBeNull();
  });
});

describe("rowToDispatch", () => {
  it("parses trigger_metadata JSON and hydrates full Dispatch", () => {
    const row = {
      id: "job-abc",
      repo_name: "danxbot",
      trigger: "trello",
      trigger_metadata: JSON.stringify(makeTrelloMeta()),
      slack_thread_ts: null,
      slack_channel_id: null,
      session_uuid: "sess-uuid",
      jsonl_path: "/tmp/session.jsonl",
      parent_job_id: "parent-aea75840",
      status: "completed",
      started_at: 1000,
      completed_at: 2000,
      summary: "all done",
      error: null,
      runtime_mode: "host",
      tokens_total: 100,
      tokens_in: 40,
      tokens_out: 30,
      cache_read: 20,
      cache_write: 10,
      tool_call_count: 5,
      subagent_count: 2,
      nudge_count: 0,
      danxbot_commit: "sha123",
    };
    const d = rowToDispatch(row);
    expect(d.id).toBe("job-abc");
    expect(d.trigger).toBe("trello");
    expect(d.triggerMetadata).toEqual(makeTrelloMeta());
    expect(d.status).toBe("completed");
    expect(d.tokensTotal).toBe(100);
    expect(d.runtimeMode).toBe("host");
    // Resume lineage round-trips through rowToDispatch.
    expect(d.parentJobId).toBe("parent-aea75840");
  });

  it("handles pre-parsed JSON object in trigger_metadata (mysql2 auto-parse)", () => {
    const meta = makeSlackMeta();
    const row = {
      id: "job",
      repo_name: "danxbot",
      trigger: "slack",
      trigger_metadata: meta, // pre-parsed
      slack_thread_ts: meta.threadTs,
      slack_channel_id: meta.channelId,
      session_uuid: null,
      jsonl_path: null,
      parent_job_id: null,
      status: "running",
      started_at: 1,
      completed_at: null,
      summary: null,
      error: null,
      runtime_mode: "docker",
      tokens_total: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_write: 0,
      tool_call_count: 0,
      subagent_count: 0,
      nudge_count: 0,
      danxbot_commit: null,
    };
    const d = rowToDispatch(row);
    expect(d.triggerMetadata).toEqual(meta);
  });
});

describe("insertDispatch", () => {
  it("inserts with backticked reserved columns (trigger, status, error)", async () => {
    await insertDispatch(makeDispatch({ trigger: "api" }));
    expect(mockExecute).toHaveBeenCalledOnce();
    const sql = mockExecute.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO dispatches");
    expect(sql).toContain("`trigger`");
    expect(sql).toContain("`status`");
    expect(sql).toContain("`error`");
    // Order: id first
    expect(sql.indexOf("id")).toBeLessThan(sql.indexOf("repo_name"));
  });

  it("passes ID + JSON-stringified metadata as parameters", async () => {
    const d = makeDispatch({
      id: "job-42",
      trigger: "trello",
      triggerMetadata: makeTrelloMeta(),
    });
    await insertDispatch(d);
    const params = mockExecute.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("job-42");
    expect(params[2]).toBe("trello"); // trigger
    expect(typeof params[3]).toBe("string");
    expect(JSON.parse(params[3] as string)).toEqual(makeTrelloMeta());
  });
});

describe("updateDispatch", () => {
  it("issues UPDATE SQL with only provided fields", async () => {
    await updateDispatch("job-1", {
      sessionUuid: "sess-new",
      jsonlPath: "/tmp/new.jsonl",
    });

    expect(mockExecute).toHaveBeenCalledOnce();
    const sql = mockExecute.mock.calls[0][0] as string;
    const params = mockExecute.mock.calls[0][1] as unknown[];

    expect(sql).toContain("UPDATE dispatches SET");
    expect(sql).toContain("session_uuid = ?");
    expect(sql).toContain("jsonl_path = ?");
    expect(sql).toContain("WHERE id = ?");
    expect(params).toEqual(["sess-new", "/tmp/new.jsonl", "job-1"]);
  });

  it("backticks reserved columns in UPDATE", async () => {
    await updateDispatch("job-1", { status: "failed", error: "boom" });
    const sql = mockExecute.mock.calls[0][0] as string;
    expect(sql).toContain("`status` = ?");
    expect(sql).toContain("`error` = ?");
  });

  it("does not issue SQL when no known fields are provided", async () => {
    await updateDispatch("job-1", {});
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("JSON-stringifies triggerMetadata when updated", async () => {
    const meta = makeApiMeta();
    await updateDispatch("job-1", {
      triggerMetadata: meta,
    });
    const params = mockExecute.mock.calls[0][1] as unknown[];
    expect(typeof params[0]).toBe("string");
    expect(JSON.parse(params[0] as string)).toEqual(meta);
  });
});

describe("getDispatchById", () => {
  it("returns null when no row found", async () => {
    mockExecute.mockResolvedValueOnce([[], []]);
    const result = await getDispatchById("missing");
    expect(result).toBeNull();
  });

  it("parses and returns the Dispatch when row exists", async () => {
    mockExecute.mockResolvedValueOnce([
      [
        {
          id: "job-xyz",
          repo_name: "danxbot",
          trigger: "api",
          trigger_metadata: JSON.stringify(makeApiMeta()),
          session_uuid: null,
          jsonl_path: null,
          status: "running",
          started_at: 1,
          completed_at: null,
          summary: null,
          error: null,
          runtime_mode: "docker",
          tokens_total: 0,
          tokens_in: 0,
          tokens_out: 0,
          cache_read: 0,
          cache_write: 0,
          tool_call_count: 0,
          subagent_count: 0,
          nudge_count: 0,
          danxbot_commit: null,
        },
      ],
      [],
    ]);
    const result = await getDispatchById("job-xyz");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("job-xyz");
    expect(result!.trigger).toBe("api");
  });
});

describe("listDispatches", () => {
  it("selects all rows ordered by started_at DESC with default limit", async () => {
    mockQuery.mockResolvedValueOnce([[], []]);
    await listDispatches({});

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("SELECT * FROM dispatches");
    expect(sql).toContain("ORDER BY started_at DESC");
    expect(sql).toContain("LIMIT");
  });

  it("adds trigger filter using backticked column", async () => {
    await listDispatches({ trigger: "slack" });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("`trigger` = ?");
    expect(params).toContain("slack");
  });

  it("adds repo filter", async () => {
    await listDispatches({ repo: "platform" });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("repo_name = ?");
    expect(params).toContain("platform");
  });

  it("adds status filter using backticked column", async () => {
    await listDispatches({ status: "failed" });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("`status` = ?");
    expect(params).toContain("failed");
  });

  it("adds since filter", async () => {
    await listDispatches({ since: 1_700_000_000_000 });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("started_at >= ?");
    expect(params).toContain(1_700_000_000_000);
  });

  it("adds full-text search on summary using LIKE", async () => {
    await listDispatches({ q: "deploy fix" });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("summary LIKE ?");
    expect(params).toContain("%deploy fix%");
  });

  it("returns parsed dispatches from result rows", async () => {
    mockQuery.mockResolvedValueOnce([
      [
        {
          id: "j1",
          repo_name: "r1",
          trigger: "slack",
          trigger_metadata: JSON.stringify(makeSlackMeta()),
          session_uuid: null,
          jsonl_path: null,
          status: "running",
          started_at: 1,
          completed_at: null,
          summary: null,
          error: null,
          runtime_mode: "docker",
          tokens_total: 0,
          tokens_in: 0,
          tokens_out: 0,
          cache_read: 0,
          cache_write: 0,
          tool_call_count: 0,
          subagent_count: 0,
          nudge_count: 0,
          danxbot_commit: null,
        },
      ],
      [],
    ]);
    const result = await listDispatches({});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("j1");
  });
});

describe("deleteOldDispatches", () => {
  it("selects terminal dispatches older than cutoff and deletes them", async () => {
    mockQuery.mockResolvedValueOnce([
      [
        { id: "old1", jsonl_path: "/tmp/j1.jsonl" },
        { id: "old2", jsonl_path: "/tmp/j2.jsonl" },
      ],
      [],
    ]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 2 }, []]);

    const result = await deleteOldDispatches(1_000);

    // SELECT and DELETE both issued
    const selectSql = mockQuery.mock.calls[0][0] as string;
    const deleteSql = mockExecute.mock.calls[0][0] as string;

    expect(selectSql).toContain("SELECT");
    expect(selectSql).toContain("started_at <");
    expect(selectSql).toContain("`status` IN");

    expect(deleteSql).toContain("DELETE FROM dispatches");
    expect(deleteSql).toContain("started_at <");
    expect(deleteSql).toContain("`status` IN");

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("old1");
    expect(result[0].jsonlPath).toBe("/tmp/j1.jsonl");
  });

  it("skips dispatches in non-terminal states (queued, running)", async () => {
    await deleteOldDispatches(1_000);
    const sql = mockQuery.mock.calls[0][0] as string;
    // Only completed/failed/cancelled should be deletable
    expect(sql).toContain("'completed'");
    expect(sql).toContain("'failed'");
    expect(sql).toContain("'cancelled'");
    expect(sql).not.toContain("'running'");
    expect(sql).not.toContain("'queued'");
  });

  it("returns empty array when no old dispatches found", async () => {
    mockQuery.mockResolvedValueOnce([[], []]);
    const result = await deleteOldDispatches(1_000);
    expect(result).toEqual([]);
    // No DELETE issued when nothing to delete
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("handles null jsonl_path entries gracefully", async () => {
    mockQuery.mockResolvedValueOnce([
      [{ id: "old1", jsonl_path: null }],
      [],
    ]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    const result = await deleteOldDispatches(1_000);
    expect(result[0].jsonlPath).toBeNull();
  });
});
