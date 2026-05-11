import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPool, MockPoolCtor, mockQuery } = vi.hoisted(() => {
  const mockPool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
  const MockPoolCtor = vi.fn().mockImplementation(() => mockPool);
  const mockQuery = vi.fn();
  return { mockPool, MockPoolCtor, mockQuery };
});

vi.mock("pg", () => ({
  Pool: MockPoolCtor,
  types: { setTypeParser: vi.fn() },
}));

vi.mock("../db/connection.js", () => ({
  getPool: () => mockPool,
  query: mockQuery,
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
  findLatestDispatchBySlackThread,
  findNonTerminalDispatches,
  listDispatches,
  deleteOldDispatches,
  rowToDispatch,
  dispatchToInsertParams,
  listDispatchesByIssueId,
  listBoardChatDispatches,
  getResumeChain,
  agentBusyOn,
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
    issueId: null,
    status: "running",
    startedAt: 1_700_000_000_000,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "docker",
    hostPid: process.pid,
    hostPidAt: null,
    pidTerminatedAt: null,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: "abc1234",
    agentName: null,
    mcpSettingsPath: null,
    recoverCount: 0,
    parentRecoverId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
      "sessionUuid", "jsonlPath", "parentJobId", "issueId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "hostPid",
      "hostPidAt",
      "pidTerminatedAt",
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
      "sessionUuid", "jsonlPath", "parentJobId", "issueId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "hostPid",
      "hostPidAt",
      "pidTerminatedAt",
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
      "sessionUuid", "jsonlPath", "parentJobId", "issueId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "hostPid",
      "hostPidAt",
      "pidTerminatedAt",
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
      "sessionUuid", "jsonlPath", "parentJobId", "issueId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "hostPid",
      "hostPidAt",
      "pidTerminatedAt",
      "tokensTotal", "tokensIn", "tokensOut", "cacheRead", "cacheWrite",
      "toolCallCount", "subagentCount", "nudgeCount", "danxbotCommit",
    ];
    const idx = orderedKeys.indexOf("parentJobId");
    expect(params[idx]).toBeNull();
  });

  it("writes mcpSettingsPath at its declared position (round-trip on insert path)", () => {
    // DX-207 — the per-dispatch MCP settings file path is the load-bearing
    // hand-off between `dispatch()` and Phase 2c's reattach pass. A
    // re-order of COLUMN_MAP that misaligned this column would silently
    // route the path into some unrelated cell at write time, then surface
    // as a NULL on the read side and force every reattached dispatch
    // through the mark-failed branch.
    const d = makeDispatch({
      mcpSettingsPath: "/tmp/danxbot-mcp-AbCdEf/settings.json",
    });
    const params = dispatchToInsertParams(d);
    // Reconstruct COLUMN_MAP order — `mcpSettingsPath` appended after
    // `agentName` per dispatches-db.ts's COLUMN_MAP declaration.
    const orderedKeys: Array<keyof typeof d> = [
      "id", "repoName", "trigger", "triggerMetadata",
      "slackThreadTs", "slackChannelId",
      "sessionUuid", "jsonlPath", "parentJobId", "issueId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "hostPid", "hostPidAt", "pidTerminatedAt",
      "tokensTotal", "tokensIn", "tokensOut", "cacheRead", "cacheWrite",
      "toolCallCount", "subagentCount", "nudgeCount",
      "danxbotCommit", "agentName", "mcpSettingsPath",
      "recoverCount", "parentRecoverId",
    ];
    const idx = orderedKeys.indexOf("mcpSettingsPath");
    expect(params[idx]).toBe("/tmp/danxbot-mcp-AbCdEf/settings.json");
  });

  it("sends null when mcpSettingsPath is null (legacy / no-MCP test paths)", () => {
    const d = makeDispatch({ mcpSettingsPath: null });
    const params = dispatchToInsertParams(d);
    const orderedKeys: Array<keyof typeof d> = [
      "id", "repoName", "trigger", "triggerMetadata",
      "slackThreadTs", "slackChannelId",
      "sessionUuid", "jsonlPath", "parentJobId", "issueId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "hostPid", "hostPidAt", "pidTerminatedAt",
      "tokensTotal", "tokensIn", "tokensOut", "cacheRead", "cacheWrite",
      "toolCallCount", "subagentCount", "nudgeCount",
      "danxbotCommit", "agentName", "mcpSettingsPath",
      "recoverCount", "parentRecoverId",
    ];
    const idx = orderedKeys.indexOf("mcpSettingsPath");
    expect(params[idx]).toBeNull();
  });

  it("writes recoverCount + parentRecoverId at their declared positions (DX-259 round-trip)", () => {
    // DX-259 Phase 1 — the recover-chain columns are the load-bearing
    // hand-off between the launcher's API-error recover handler (Phase 2)
    // and the chain walker the dashboard "show recover chain" view will
    // call (Phase 3). A re-order of COLUMN_MAP that misaligned either
    // column would silently route the values into unrelated cells at
    // write time and corrupt every recovered dispatch's lineage.
    const d = makeDispatch({
      recoverCount: 2,
      parentRecoverId: "parent-recover-12345",
    });
    const params = dispatchToInsertParams(d);
    const orderedKeys: Array<keyof typeof d> = [
      "id", "repoName", "trigger", "triggerMetadata",
      "slackThreadTs", "slackChannelId",
      "sessionUuid", "jsonlPath", "parentJobId", "issueId", "status",
      "startedAt", "completedAt", "summary", "error", "runtimeMode",
      "hostPid", "hostPidAt", "pidTerminatedAt",
      "tokensTotal", "tokensIn", "tokensOut", "cacheRead", "cacheWrite",
      "toolCallCount", "subagentCount", "nudgeCount",
      "danxbotCommit", "agentName", "mcpSettingsPath",
      "recoverCount", "parentRecoverId",
    ];
    const recoverCountIdx = orderedKeys.indexOf("recoverCount");
    const parentRecoverIdIdx = orderedKeys.indexOf("parentRecoverId");
    expect(params[recoverCountIdx]).toBe(2);
    expect(params[parentRecoverIdIdx]).toBe("parent-recover-12345");
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
      issue_id: null,
      status: "completed",
      started_at: 1000,
      completed_at: 2000,
      summary: "all done",
      error: null,
      runtime_mode: "host",
      host_pid: 4242,
      host_pid_at: 1500,
      pid_terminated_at: 1900,
      tokens_total: 100,
      tokens_in: 40,
      tokens_out: 30,
      cache_read: 20,
      cache_write: 10,
      tool_call_count: 5,
      subagent_count: 2,
      nudge_count: 0,
      danxbot_commit: "sha123",
      agent_name: null,
      mcp_settings_path: null,
      recover_count: 0,
      parent_recover_id: null,
    };
    const d = rowToDispatch(row);
    expect(d.id).toBe("job-abc");
    expect(d.trigger).toBe("trello");
    expect(d.triggerMetadata).toEqual(makeTrelloMeta());
    expect(d.status).toBe("completed");
    expect(d.tokensTotal).toBe(100);
    expect(d.runtimeMode).toBe("host");
    expect(d.hostPid).toBe(4242);
    // Resume lineage round-trips through rowToDispatch.
    expect(d.parentJobId).toBe("parent-aea75840");
    // DX-259 — fresh / non-recovered rows surface defaults.
    expect(d.recoverCount).toBe(0);
    expect(d.parentRecoverId).toBeNull();
  });

  it("hydrates recover_count / parent_recover_id (DX-259; legacy fixture defaults to 0 / null)", () => {
    // DX-259 Phase 1 — read-side counterpart to the COLUMN_MAP positional
    // round-trip test. Three branches exercised, mirroring the existing
    // `mcp_settings_path` pattern:
    //   1. columns carry real values → recoverCount / parentRecoverId reflect them
    //   2. columns are 0 / NULL → defaults
    //   3. columns missing entirely (pre-DX-259 fixture) → recoverCount = 0,
    //      parentRecoverId = null
    // Branch 3 protects the loose `==` null check from being "fixed" to
    // strict `===`. `Number(undefined)` would surface as `NaN`, silently
    // corrupting every legacy fixture's recoverCount and breaking the
    // Phase 2 cap decision.
    const baseRow = {
      id: "j",
      repo_name: "r",
      trigger: "api",
      trigger_metadata: JSON.stringify(makeApiMeta()),
      slack_thread_ts: null,
      slack_channel_id: null,
      session_uuid: null,
      jsonl_path: null,
      parent_job_id: null,
      issue_id: null,
      status: "running",
      started_at: 1,
      completed_at: null,
      summary: null,
      error: null,
      runtime_mode: "docker",
      host_pid: null,
      host_pid_at: null,
      pid_terminated_at: null,
      tokens_total: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_write: 0,
      tool_call_count: 0,
      subagent_count: 0,
      nudge_count: 0,
      danxbot_commit: null,
      agent_name: null,
      mcp_settings_path: null,
    };

    const recovered = rowToDispatch({
      ...baseRow,
      recover_count: 2,
      parent_recover_id: "parent-recover-XyZ",
    } as never);
    expect(recovered.recoverCount).toBe(2);
    expect(recovered.parentRecoverId).toBe("parent-recover-XyZ");

    const fresh = rowToDispatch({
      ...baseRow,
      recover_count: 0,
      parent_recover_id: null,
    } as never);
    expect(fresh.recoverCount).toBe(0);
    expect(fresh.parentRecoverId).toBeNull();

    // Pre-DX-259 fixture — both columns entirely absent on the row object.
    const legacy = rowToDispatch(baseRow as never);
    expect(legacy.recoverCount).toBe(0);
    expect(legacy.parentRecoverId).toBeNull();
  });

  it("hydrates mcp_settings_path → mcpSettingsPath (string round-trips; null + missing column both surface as null)", () => {
    // DX-207 — the read-side counterpart to the COLUMN_MAP positional
    // round-trip test. Three branches exercised:
    //   1. column carries a string → mcpSettingsPath = that string
    //   2. column is NULL → mcpSettingsPath = null
    //   3. column missing entirely (pre-DX-207 fixture) → mcpSettingsPath = null
    // Branch 3 protects the loose `==` null check from being "fixed" to
    // strict `===` — `Number(undefined)` style coercion would surface as
    // the string "undefined", silently corrupting every legacy fixture
    // and breaking the reattach decision.
    const baseRow = {
      id: "j",
      repo_name: "r",
      trigger: "api",
      trigger_metadata: JSON.stringify(makeApiMeta()),
      slack_thread_ts: null,
      slack_channel_id: null,
      session_uuid: null,
      jsonl_path: null,
      parent_job_id: null,
      issue_id: null,
      status: "running",
      started_at: 1,
      completed_at: null,
      summary: null,
      error: null,
      runtime_mode: "docker",
      host_pid: null,
      host_pid_at: null,
      pid_terminated_at: null,
      tokens_total: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_write: 0,
      tool_call_count: 0,
      subagent_count: 0,
      nudge_count: 0,
      danxbot_commit: null,
      agent_name: null,
    };

    const withPath = rowToDispatch({
      ...baseRow,
      mcp_settings_path: "/tmp/danxbot-mcp-XyZ123/settings.json",
    } as never);
    expect(withPath.mcpSettingsPath).toBe(
      "/tmp/danxbot-mcp-XyZ123/settings.json",
    );

    const withNull = rowToDispatch({
      ...baseRow,
      mcp_settings_path: null,
    } as never);
    expect(withNull.mcpSettingsPath).toBeNull();

    // Pre-DX-207 fixture — column entirely absent on the row object.
    const legacy = rowToDispatch(baseRow as never);
    expect(legacy.mcpSettingsPath).toBeNull();
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
      issue_id: null,
      status: "running",
      started_at: 1,
      completed_at: null,
      summary: null,
      error: null,
      runtime_mode: "docker",
      host_pid: null,
      host_pid_at: null,
      pid_terminated_at: null,
      tokens_total: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_write: 0,
      tool_call_count: 0,
      subagent_count: 0,
      nudge_count: 0,
      danxbot_commit: null,
      agent_name: null,
      mcp_settings_path: null,
      recover_count: 0,
      parent_recover_id: null,
    };
    const d = rowToDispatch(row);
    expect(d.triggerMetadata).toEqual(meta);
    expect(d.hostPid).toBeNull();
  });
});

describe("insertDispatch", () => {
  it("inserts with double-quoted reserved columns (trigger, status, error)", async () => {
    await insertDispatch(makeDispatch({ trigger: "api" }));
    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("INSERT INTO dispatches");
    expect(sql).toContain('"trigger"');
    expect(sql).toContain('"status"');
    expect(sql).toContain('"error"');
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
    const params = mockQuery.mock.calls[0][1] as unknown[];
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

    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];

    expect(sql).toContain("UPDATE dispatches SET");
    expect(sql).toContain("session_uuid = $1");
    expect(sql).toContain("jsonl_path = $2");
    expect(sql).toContain("WHERE id = $3");
    expect(params).toEqual(["sess-new", "/tmp/new.jsonl", "job-1"]);
  });

  it("double-quotes reserved columns in UPDATE", async () => {
    await updateDispatch("job-1", { status: "failed", error: "boom" });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('"status" = $1');
    expect(sql).toContain('"error" = $2');
  });

  it("does not issue SQL when no known fields are provided", async () => {
    await updateDispatch("job-1", {});
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("JSON-stringifies triggerMetadata when updated", async () => {
    const meta = makeApiMeta();
    await updateDispatch("job-1", {
      triggerMetadata: meta,
    });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(typeof params[0]).toBe("string");
    expect(JSON.parse(params[0] as string)).toEqual(meta);
  });
});

describe("getDispatchById", () => {
  it("returns null when no row found", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await getDispatchById("missing");
    expect(result).toBeNull();
  });

  it("parses and returns the Dispatch when row exists", async () => {
    mockQuery.mockResolvedValueOnce([
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
          agent_name: null,
        },
      ]);
    const result = await getDispatchById("job-xyz");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("job-xyz");
    expect(result!.trigger).toBe("api");
  });
});

describe("findLatestDispatchBySlackThread", () => {
  function makeSlackRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-slack-abc",
      repo_name: "danxbot",
      trigger: "slack",
      trigger_metadata: JSON.stringify(makeSlackMeta()),
      slack_thread_ts: "1234.5678",
      slack_channel_id: "C123",
      session_uuid: "session-prior-1",
      jsonl_path: null,
      parent_job_id: null,
      status: "completed",
      started_at: 1_700_000_010_000,
      completed_at: 1_700_000_020_000,
      summary: "Answered the question",
      error: null,
      runtime_mode: "docker",
      tokens_total: 100,
      tokens_in: 50,
      tokens_out: 50,
      cache_read: 0,
      cache_write: 0,
      tool_call_count: 2,
      subagent_count: 0,
      nudge_count: 0,
      danxbot_commit: "abc1234",
      agent_name: null,
      ...overrides,
    };
  }

  it("returns null when no completed dispatch exists for the thread", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await findLatestDispatchBySlackThread("nonexistent.thread");
    expect(result).toBeNull();
  });

  it("returns the most recent completed dispatch for the thread", async () => {
    mockQuery.mockResolvedValueOnce([makeSlackRow()]);
    const result = await findLatestDispatchBySlackThread("1234.5678");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("job-slack-abc");
    expect(result!.sessionUuid).toBe("session-prior-1");
    expect(result!.status).toBe("completed");
  });

  it("filters to status = 'completed' and orders by started_at DESC", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await findLatestDispatchBySlackThread("1234.5678");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("WHERE slack_thread_ts = $1");
    expect(sql).toContain('"status" = \'completed\'');
    expect(sql).toContain("ORDER BY started_at DESC");
    expect(sql).toContain("LIMIT 1");
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toEqual(["1234.5678"]);
  });

});

describe("findNonTerminalDispatches", () => {
  it("queries by repo_name with status IN (queued, running) and oldest-first ordering", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await findNonTerminalDispatches("danxbot");
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("FROM dispatches");
    expect(sql).toContain("repo_name = $1");
    expect(sql).toContain("'queued'");
    expect(sql).toContain("'running'");
    expect(sql).toMatch(/ORDER BY started_at ASC/i);
    expect(params).toEqual(["danxbot"]);
  });

  it("hydrates rows via rowToDispatch (host_pid round-trips)", async () => {
    mockQuery.mockResolvedValueOnce(      [
        {
          id: "alive-1",
          repo_name: "danxbot",
          trigger: "trello",
          trigger_metadata: JSON.stringify(makeTrelloMeta()),
          slack_thread_ts: null,
          slack_channel_id: null,
          session_uuid: null,
          jsonl_path: null,
          parent_job_id: null,
          status: "running",
          started_at: 1000,
          completed_at: null,
          summary: null,
          error: null,
          runtime_mode: "host",
          host_pid: 4321,
          host_pid_at: null,
          pid_terminated_at: null,
          tokens_total: 0,
          tokens_in: 0,
          tokens_out: 0,
          cache_read: 0,
          cache_write: 0,
          tool_call_count: 0,
          subagent_count: 0,
          nudge_count: 0,
          danxbot_commit: null,
          agent_name: null,
        },
      ]);
    const rows = await findNonTerminalDispatches("danxbot");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("alive-1");
    expect(rows[0].hostPid).toBe(4321);
  });
});

describe("agentBusyOn", () => {
  it("queries non-terminal rows for repo with agent_name set, oldest-first", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await agentBusyOn("danxbot");
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("FROM dispatches");
    expect(sql).toContain("repo_name = $1");
    expect(sql).toContain("agent_name IS NOT NULL");
    // Excludes the canonical TERMINAL_STATUSES list (built from the
    // single source of truth in `dispatches.ts`) so a stale terminal
    // dispatch never reports busy.
    for (const t of ["completed", "failed", "cancelled"]) {
      expect(sql).toContain(`'${t}'`);
    }
    expect(sql).toMatch(/ORDER BY started_at ASC/i);
    expect(params).toEqual(["danxbot"]);
  });

  it("returns Map<agentName, busyOn> with card_id from issue_id", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        agent_name: "alice",
        issue_id: "DX-1",
        started_at: 1_700_000_001_000,
        id: "uuid-1",
      },
      {
        agent_name: "bob",
        issue_id: null,
        started_at: 1_700_000_002_000,
        id: "uuid-2",
      },
    ]);
    const map = await agentBusyOn("danxbot");
    expect(map.get("alice")).toEqual({
      card_id: "DX-1",
      started_at: 1_700_000_001_000,
      dispatch_id: "uuid-1",
    });
    expect(map.get("bob")).toEqual({
      card_id: null,
      started_at: 1_700_000_002_000,
      dispatch_id: "uuid-2",
    });
    expect(map.size).toBe(2);
  });

  it("oldest dispatch wins when an agent has multiple in-flight rows", async () => {
    // Lock invariant says one-per-agent; defensive — rows arrive
    // oldest-first per ORDER BY, so the FIRST one we see for an agent
    // is the one we keep.
    mockQuery.mockResolvedValueOnce([
      {
        agent_name: "alice",
        issue_id: "DX-1",
        started_at: 1_000,
        id: "older",
      },
      {
        agent_name: "alice",
        issue_id: "DX-2",
        started_at: 2_000,
        id: "newer",
      },
    ]);
    const map = await agentBusyOn("danxbot");
    expect(map.get("alice")?.dispatch_id).toBe("older");
    expect(map.get("alice")?.card_id).toBe("DX-1");
    expect(map.size).toBe(1);
  });

  it("skips rows with empty agent_name", async () => {
    mockQuery.mockResolvedValueOnce([
      { agent_name: "", issue_id: "DX-1", started_at: 1, id: "x" },
    ]);
    const map = await agentBusyOn("danxbot");
    expect(map.size).toBe(0);
  });
});

describe("listDispatches", () => {
  it("selects all rows ordered by started_at DESC with default limit", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listDispatches({});

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("SELECT * FROM dispatches");
    expect(sql).toContain("ORDER BY started_at DESC");
    expect(sql).toContain("LIMIT");
  });

  it("adds trigger filter using double-quoted column", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listDispatches({ trigger: "slack" });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain('"trigger" = $1');
    expect(params).toContain("slack");
  });

  it("adds repo filter", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listDispatches({ repo: "platform" });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("repo_name = $1");
    expect(params).toContain("platform");
  });

  it("adds status filter using double-quoted column", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listDispatches({ status: "failed" });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain('"status" = $1');
    expect(params).toContain("failed");
  });

  it("adds since filter", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listDispatches({ since: 1_700_000_000_000 });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("started_at >= $1");
    expect(params).toContain(1_700_000_000_000);
  });

  it("adds full-text search on summary using LIKE", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listDispatches({ q: "deploy fix" });
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("summary LIKE $");
    expect(params).toContain("%deploy fix%");
  });

  it("returns parsed dispatches from result rows", async () => {
    mockQuery.mockResolvedValueOnce(      [
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
          agent_name: null,
        },
      ]);
    const result = await listDispatches({});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("j1");
  });
});

describe("deleteOldDispatches", () => {
  it("selects terminal dispatches older than cutoff and deletes them", async () => {
    mockPool.query.mockClear();
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: "old1", jsonl_path: "/tmp/j1.jsonl" },
        { id: "old2", jsonl_path: "/tmp/j2.jsonl" },
      ], rowCount: 0 });
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await deleteOldDispatches(1_000);

    // SELECT and DELETE both issued via getPool().query
    expect(mockPool.query.mock.calls.length).toBeGreaterThanOrEqual(2);
    const selectSql = mockPool.query.mock.calls[0][0] as string;
    const deleteSql = mockPool.query.mock.calls[1][0] as string;

    expect(selectSql).toContain("SELECT");
    expect(selectSql).toContain("started_at < $1");
    expect(selectSql).toContain('"status" IN');

    expect(deleteSql).toContain("DELETE FROM dispatches");
    expect(deleteSql).toContain("started_at < $1");
    expect(deleteSql).toContain('"status" IN');

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("old1");
    expect(result[0].jsonlPath).toBe("/tmp/j1.jsonl");
  });

  it("skips dispatches in non-terminal states (queued, running)", async () => {
    mockPool.query.mockClear();
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await deleteOldDispatches(1_000);
    const sql = mockPool.query.mock.calls[0][0] as string;
    // Only completed/failed/cancelled should be deletable
    expect(sql).toContain("'completed'");
    expect(sql).toContain("'failed'");
    expect(sql).toContain("'cancelled'");
    expect(sql).not.toContain("'running'");
    expect(sql).not.toContain("'queued'");
  });

  it("returns empty array when no old dispatches found", async () => {
    mockPool.query.mockClear();
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await deleteOldDispatches(1_000);
    expect(result).toEqual([]);
    // No DELETE issued when nothing to delete
    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it("handles null jsonl_path entries gracefully", async () => {
    mockPool.query.mockClear();
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: "old1", jsonl_path: null }], rowCount: 0 });
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await deleteOldDispatches(1_000);
    expect(result[0].jsonlPath).toBeNull();
  });
});

// ─── DX-84 Agent Chat helpers ──────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    repo_name: "danxbot",
    trigger: "trello",
    trigger_metadata: JSON.stringify(makeTrelloMeta()),
    slack_thread_ts: null,
    slack_channel_id: null,
    session_uuid: null,
    jsonl_path: null,
    parent_job_id: null,
    issue_id: null,
    status: "completed",
    started_at: 1000,
    completed_at: 2000,
    summary: null,
    error: null,
    runtime_mode: "docker",
    host_pid: null,
    host_pid_at: null,
    pid_terminated_at: null,
    tokens_total: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_write: 0,
    tool_call_count: 0,
    subagent_count: 0,
    nudge_count: 0,
    danxbot_commit: null,
    agent_name: null,
    ...overrides,
  };
}

describe("listDispatchesByIssueId", () => {
  it("filters by issue_id and orders newest-first", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listDispatchesByIssueId("DX-84");
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("FROM dispatches");
    expect(sql).toContain("issue_id = $1");
    expect(sql).toMatch(/ORDER BY started_at DESC/i);
    expect(params).toEqual(["DX-84"]);
  });

  it("hydrates rows via rowToDispatch", async () => {
    mockQuery.mockResolvedValueOnce([
      makeRow({ id: "job-2", issue_id: "DX-84" }),
    ]);
    const rows = await listDispatchesByIssueId("DX-84");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("job-2");
    expect(rows[0].issueId).toBe("DX-84");
  });
});

describe("listBoardChatDispatches", () => {
  it("filters api-trigger rows by repo + workspace=board-chat via JSONB key", async () => {
    // The JSONB filter is the contract that ties chat session list to the
    // board-chat workspace name. A regression that drops the filter would
    // leak every api-trigger dispatch (schema, manual `/api/launch`, etc.)
    // into the chat picker.
    mockQuery.mockResolvedValueOnce([]);
    await listBoardChatDispatches("danxbot");
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("repo_name = $1");
    expect(sql).toContain("\"trigger\" = 'api'");
    expect(sql).toContain("trigger_metadata->>'workspace' = 'board-chat'");
    expect(sql).toMatch(/ORDER BY started_at DESC/i);
    expect(params).toEqual(["danxbot"]);
  });
});

describe("getResumeChain", () => {
  it("issues a recursive CTE walking parent_job_id with a depth cap and oldest-first ordering", async () => {
    // ORDER BY depth DESC is what makes the chain return root-first; a
    // regression that flips it would render timelines in reverse.
    mockQuery.mockResolvedValueOnce([]);
    await getResumeChain("job-3");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/WITH RECURSIVE/i);
    expect(sql).toContain("parent_job_id");
    expect(sql).toMatch(/depth\s*<\s*32/);
    expect(sql).toMatch(/ORDER BY depth DESC/i);
    expect(mockQuery.mock.calls[0][1]).toEqual(["job-3"]);
  });

  it("returns rows hydrated via rowToDispatch", async () => {
    mockQuery.mockResolvedValueOnce([
      { ...makeRow({ id: "p1" }), depth: 1 },
      { ...makeRow({ id: "c1", parent_job_id: "p1" }), depth: 0 },
    ]);
    const chain = await getResumeChain("c1");
    expect(chain.map((d) => d.id)).toEqual(["p1", "c1"]);
  });
});
