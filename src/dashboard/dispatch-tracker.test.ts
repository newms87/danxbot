import { describe, it, expect, beforeEach, vi } from "vitest";

const mockInsertDispatch = vi.fn();
const mockUpdateDispatch = vi.fn();

vi.mock("./dispatches-db.js", () => ({
  insertDispatch: (...args: unknown[]) => mockInsertDispatch(...args),
  updateDispatch: (...args: unknown[]) => mockUpdateDispatch(...args),
}));

const mockPublish = vi.fn();
vi.mock("./event-bus.js", () => ({
  eventBus: { publish: (...args: unknown[]) => mockPublish(...args) },
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
  applyStrike,
  extractSessionUuidFromPath,
  startDispatchTracking,
  type FinalizeTokens,
} from "./dispatch-tracker.js";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  _resetForTesting,
  readSettings,
  settingsFilePath,
  type AgentRecord,
  type AgentStrikeEntry,
  type Settings,
} from "../settings-file.js";
import { afterEach } from "vitest";
import type { DispatchTriggerMetadata } from "./dispatches.js";
import type { AgentLogEntry } from "../types.js";

interface MockWatcher {
  entryHandlers: Array<(entry: AgentLogEntry) => Promise<void> | void>;
  onEntry: (fn: (entry: AgentLogEntry) => Promise<void> | void) => void;
  getSessionFilePath: () => string | null;
  sessionPath: string | null;
}

function makeMockWatcher(): MockWatcher {
  const state: MockWatcher = {
    entryHandlers: [],
    sessionPath: null,
    onEntry(fn) {
      state.entryHandlers.push(fn);
    },
    getSessionFilePath() {
      return state.sessionPath;
    },
  };
  return state;
}

async function emitEntry(w: MockWatcher, entry: AgentLogEntry): Promise<void> {
  for (const h of w.entryHandlers) {
    await h(entry);
  }
}

const slackTrigger: DispatchTriggerMetadata = {
  trigger: "slack",
  metadata: {
    channelId: "C123",
    threadTs: "1",
    messageTs: "1",
    user: "U1",
    userName: "Dan",
    messageText: "hi",
  },
};

const noTokens: FinalizeTokens = {
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertDispatch.mockResolvedValue(undefined);
  mockUpdateDispatch.mockResolvedValue(undefined);
});

describe("extractSessionUuidFromPath", () => {
  it("extracts UUID from a canonical session path", () => {
    const p = "/home/newms/.claude/projects/-foo/12345678-90ab-cdef-1234-567890abcdef.jsonl";
    expect(extractSessionUuidFromPath(p)).toBe(
      "12345678-90ab-cdef-1234-567890abcdef",
    );
  });

  it("returns null when the path does not contain a UUID", () => {
    expect(extractSessionUuidFromPath("/tmp/weird.jsonl")).toBeNull();
  });
});

describe("startDispatchTracking", () => {
  it("inserts a running dispatch row at start", async () => {
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "job-1",
      repoName: "danxbot",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: "abc123",
      agentName: null,
      watcher: watcher as never,
      startedAtMs: 1000,
    });

    expect(mockInsertDispatch).toHaveBeenCalledOnce();
    const inserted = mockInsertDispatch.mock.calls[0][0];
    expect(inserted.id).toBe("job-1");
    expect(inserted.repoName).toBe("danxbot");
    expect(inserted.trigger).toBe("slack");
    expect(inserted.triggerMetadata).toEqual(slackTrigger.metadata);
    expect(inserted.status).toBe("running");
    expect(inserted.runtimeMode).toBe("docker");
    expect(inserted.danxbotCommit).toBe("abc123");
    expect(inserted.startedAt).toBe(1000);
    expect(inserted.sessionUuid).toBeNull();
    expect(inserted.jsonlPath).toBeNull();
    // Launch (no resume) → parentJobId defaults to null
    expect(inserted.parentJobId).toBeNull();
  });

  it("inserts the row with host_pid + host_pid_at + pid_terminated_at all NULL (DX-140 paired-write fills them post-spawn)", async () => {
    // Pre-DX-140 the row was inserted with `hostPid: process.pid` (the
    // worker's PID). DX-140 retired that contract — `host_pid` now
    // means "the agent script PID" (the only process whose lifetime
    // outlives the worker via PID-1 reparenting). The agent PID is
    // not yet resolved at insert time; `spawnAgent` calls
    // `pairedWriteHostPid` AFTER the runtime fork resolves it. Until
    // that fires, all three lifecycle columns stay NULL.
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "pid-stamp-job",
      repoName: "danxbot",
      trigger: slackTrigger,
      runtimeMode: "host",
      danxbotCommit: "abc",
      agentName: null,
      watcher: watcher as never,
    });
    const inserted = mockInsertDispatch.mock.calls[0][0];
    expect(inserted.hostPid).toBeNull();
    expect(inserted.hostPidAt).toBeNull();
    expect(inserted.pidTerminatedAt).toBeNull();
  });

  it("denormalizes slack thread + channel into dedicated columns when trigger is slack (Phase 1 of kMQ170Ea)", async () => {
    // Phase 2's thread-continuity lookup queries `slack_thread_ts` via
    // a real index — it cannot afford a JSON path scan. Phase 1's job
    // is to populate the dedicated columns on insert so Phase 2 starts
    // with consistent data. Without this assertion a refactor that
    // dropped the column mapping would silently pass every JSON-based
    // test and quietly break thread continuity.
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "slack-job-id",
      repoName: "danxbot",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: "abc",
      agentName: null,
      watcher: watcher as never,
    });
    const inserted = mockInsertDispatch.mock.calls[0][0];
    expect(inserted.slackThreadTs).toBe(slackTrigger.metadata.threadTs);
    expect(inserted.slackChannelId).toBe(slackTrigger.metadata.channelId);
  });

  it("leaves slack_thread_ts + slack_channel_id NULL on non-Slack dispatches", async () => {
    const apiTrigger: DispatchTriggerMetadata = {
      trigger: "api",
      metadata: {
        endpoint: "/api/launch",
        callerIp: "127.0.0.1",
        statusUrl: null,
        initialPrompt: "task",
      },
    };
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "api-job-id",
      repoName: "danxbot",
      trigger: apiTrigger,
      runtimeMode: "docker",
      danxbotCommit: "abc",
      agentName: null,
      watcher: watcher as never,
    });
    const inserted = mockInsertDispatch.mock.calls[0][0];
    expect(inserted.slackThreadTs).toBeNull();
    expect(inserted.slackChannelId).toBeNull();
  });

  it("persists parentJobId on the inserted row when the dispatch is a resume child", async () => {
    // The chain handleResume → spawnAgent → startDispatchTracking → insertDispatch
    // must preserve the parent lineage end-to-end. This is the single point of
    // durability — without a positive assertion here, a refactor that drops the
    // field silently passes all other tests.
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "resume-child-id",
      repoName: "danxbot",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: "abc123",
      agentName: null,
      watcher: watcher as never,
      startedAtMs: 2000,
      parentJobId: "parent-aea75840",
    });

    expect(mockInsertDispatch).toHaveBeenCalledOnce();
    expect(mockInsertDispatch.mock.calls[0][0].parentJobId).toBe(
      "parent-aea75840",
    );
  });

  it("persists issueId on the inserted row when the dispatch is poller-driven (DX-84)", async () => {
    // Mirror of the parentJobId durability test for the issue-id column.
    // The poller chain is dispatchStamp.issueId → dispatch() → spawnAgent
    // → startDispatchTracking → insertDispatch; this asserts the final
    // hop. A regression that drops the field silently un-stamps every
    // poller-driven dispatch row, which would break the chat list
    // endpoint without breaking any other test.
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "poller-job-1",
      repoName: "danxbot",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: "abc123",
      agentName: null,
      watcher: watcher as never,
      startedAtMs: 2000,
      issueId: "DX-84",
    });

    expect(mockInsertDispatch).toHaveBeenCalledOnce();
    expect(mockInsertDispatch.mock.calls[0][0].issueId).toBe("DX-84");
  });

  it("persists mcpSettingsPath on the inserted row when the dispatch was launched with a per-dispatch MCP file (DX-207)", async () => {
    // Locks the dispatch() → spawnAgent → startDispatchTracking →
    // insertDispatch chain for the new column. Without this assertion a
    // refactor that drops the field silently un-stamps every dispatch
    // row, leaving Phase 2c (DX-209) reattach unable to locate the per-
    // dispatch MCP settings file when the worker restarts on a different
    // port — every reattach would fall through to mark-failed.
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "mcp-path-job",
      repoName: "danxbot",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: "abc123",
      agentName: null,
      mcpSettingsPath: "/tmp/danxbot-mcp-Z9z9z9/settings.json",
      watcher: watcher as never,
      startedAtMs: 2000,
    });

    expect(mockInsertDispatch).toHaveBeenCalledOnce();
    expect(mockInsertDispatch.mock.calls[0][0].mcpSettingsPath).toBe(
      "/tmp/danxbot-mcp-Z9z9z9/settings.json",
    );
  });

  it("defaults mcpSettingsPath to null when caller did not pass one (no per-dispatch MCP file written)", async () => {
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "mcp-path-null-job",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    expect(mockInsertDispatch.mock.calls[0][0].mcpSettingsPath).toBeNull();
  });

  it("defaults recoverCount to 0 + parentRecoverId to null on every fresh insert (DX-259)", async () => {
    // Phase 1 starts every dispatch chain at zero recovers / no parent
    // recover. Phase 2 stamps positive values on the *new* row written by
    // /api/resume when the launcher's recover handler fires; this test
    // pins the steady-state default so a regression in the row builder
    // doesn't silently un-stamp the cap-decision input.
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "recover-defaults-job",
      repoName: "danxbot",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    expect(mockInsertDispatch).toHaveBeenCalledOnce();
    const inserted = mockInsertDispatch.mock.calls[0][0];
    expect(inserted.recoverCount).toBe(0);
    expect(inserted.parentRecoverId).toBeNull();
  });

  it("defaults issueId to null on launches that did not pass it (Slack, ideator, board-chat, external API)", async () => {
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "non-card-job",
      repoName: "danxbot",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    expect(mockInsertDispatch.mock.calls[0][0].issueId).toBeNull();
  });

  it("updates sessionUuid + jsonlPath on first entry after watcher attaches", async () => {
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "job-2",
      repoName: "platform",
      trigger: slackTrigger,
      runtimeMode: "host",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    // Watcher not yet attached → entry before attach is a no-op for session path
    await emitEntry(watcher, {
      timestamp: 1,
      type: "assistant",
      summary: "",
      data: { content: [] },
    });
    // No session update yet
    const updatesBefore = mockUpdateDispatch.mock.calls.filter(
      (c) => (c[1] as { sessionUuid?: string }).sessionUuid !== undefined,
    );
    expect(updatesBefore).toHaveLength(0);

    // Attach
    watcher.sessionPath =
      "/home/newms/.claude/projects/-danxbot/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
    await emitEntry(watcher, {
      timestamp: 2,
      type: "assistant",
      summary: "",
      data: { content: [] },
    });

    const sessionUpdate = mockUpdateDispatch.mock.calls.find(
      (c) => (c[1] as { sessionUuid?: string }).sessionUuid !== undefined,
    );
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate![0]).toBe("job-2");
    expect(sessionUpdate![1]).toEqual({
      sessionUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      jsonlPath:
        "/home/newms/.claude/projects/-danxbot/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
    });
  });

  it("records session update only once", async () => {
    const watcher = makeMockWatcher();
    watcher.sessionPath =
      "/tmp/x/11111111-2222-3333-4444-555555555555.jsonl";

    await startDispatchTracking({
      jobId: "job-3",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    await emitEntry(watcher, {
      timestamp: 1,
      type: "assistant",
      summary: "",
      data: { content: [] },
    });
    await emitEntry(watcher, {
      timestamp: 2,
      type: "assistant",
      summary: "",
      data: { content: [] },
    });

    const sessionUpdates = mockUpdateDispatch.mock.calls.filter(
      (c) => (c[1] as { sessionUuid?: string }).sessionUuid !== undefined,
    );
    expect(sessionUpdates).toHaveLength(1);
  });

  it("counts tool_use and Task sub-agent blocks across entries", async () => {
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-4",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    await emitEntry(watcher, {
      timestamp: 1,
      type: "assistant",
      summary: "",
      data: {
        content: [
          { type: "tool_use", name: "Read" },
          { type: "tool_use", name: "Task" },
        ],
      },
    });
    await emitEntry(watcher, {
      timestamp: 2,
      type: "assistant",
      summary: "",
      data: {
        content: [
          { type: "text", text: "done" },
          { type: "tool_use", name: "Grep" },
        ],
      },
    });

    await tracker.finalize("completed", {
      summary: "done",
      tokens: noTokens,
    });

    const finalCall = mockUpdateDispatch.mock.calls.at(-1);
    expect(finalCall![1]).toMatchObject({
      status: "completed",
      toolCallCount: 3,
      subagentCount: 1,
    });
  });

  it("counts both Agent and Task as sub-agent invocations", async () => {
    // Current Claude Code emits `tool_use.name === "Agent"` for sub-agent
    // launches; older captures used "Task". `.claude/rules/agent-dispatch.md`
    // requires readers to accept both. Without this the dispatch row's
    // `subagent_count` reads zero on every modern dispatch.
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-agent-task",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    await emitEntry(watcher, {
      timestamp: 1,
      type: "assistant",
      summary: "",
      data: {
        content: [
          { type: "tool_use", name: "Agent" },
          { type: "tool_use", name: "Task" },
          { type: "tool_use", name: "Read" },
        ],
      },
    });

    await tracker.finalize("completed", {
      summary: "done",
      tokens: noTokens,
    });

    const finalCall = mockUpdateDispatch.mock.calls.at(-1);
    expect(finalCall![1]).toMatchObject({
      status: "completed",
      toolCallCount: 3,
      subagentCount: 2,
    });
  });

  it("finalize computes tokensTotal from the four component counters", async () => {
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-5",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    await tracker.finalize("completed", {
      summary: "ok",
      tokens: {
        tokensIn: 100,
        tokensOut: 40,
        cacheRead: 200,
        cacheWrite: 20,
      },
    });

    const args = mockUpdateDispatch.mock.calls.at(-1)![1];
    expect(args.tokensTotal).toBe(360);
    expect(args.tokensIn).toBe(100);
    expect(args.tokensOut).toBe(40);
    expect(args.cacheRead).toBe(200);
    expect(args.cacheWrite).toBe(20);
  });

  it("finalize stamps pidTerminatedAt equal to completedAt on every terminal status (DX-140 lifecycle close)", async () => {
    // The finalize() path is the in-memory writer for `pid_terminated_at`
    // — every successful agent exit, every job.stop("completed"|"failed"),
    // every cancelJob() flows through here. Without this assertion a
    // refactor that drops the stamp passes every other test.
    const watcher = makeMockWatcher();
    const trackerCompleted = await startDispatchTracking({
      jobId: "job-pid-term-completed",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });
    await trackerCompleted.finalize("completed", {
      summary: "ok",
      tokens: noTokens,
    });
    const completedArgs = mockUpdateDispatch.mock.calls.at(-1)![1];
    expect(typeof completedArgs.pidTerminatedAt).toBe("number");
    expect(completedArgs.pidTerminatedAt).toBe(completedArgs.completedAt);

    // Same stamp on the failed branch — `pidTerminatedAt` records the
    // moment the PID stopped owning the row, not the completion outcome.
    const trackerFailed = await startDispatchTracking({
      jobId: "job-pid-term-failed",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });
    await trackerFailed.finalize("failed", {
      error: "boom",
      tokens: noTokens,
    });
    const failedArgs = mockUpdateDispatch.mock.calls.at(-1)![1];
    expect(typeof failedArgs.pidTerminatedAt).toBe("number");
    expect(failedArgs.pidTerminatedAt).toBe(failedArgs.completedAt);
  });

  it("finalize uses failed status with error string", async () => {
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-6",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    await tracker.finalize("failed", {
      error: "oops",
      tokens: noTokens,
    });

    const args = mockUpdateDispatch.mock.calls.at(-1)![1];
    expect(args.status).toBe("failed");
    expect(args.error).toBe("oops");
    expect(args.summary).toBeNull();
  });

  it("recordNudge updates nudgeCount", async () => {
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-7",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });

    await tracker.recordNudge(2);
    expect(mockUpdateDispatch).toHaveBeenLastCalledWith("job-7", {
      nudgeCount: 2,
    });
  });

  it("insert failure throws (fail loudly — agent run aborts; CRITICAL_FAILURE flag halts the poller)", async () => {
    // Prior behavior swallowed the insert error and continued the spawn, which
    // produced an infinite spawn/reap loop in prod (the orphan-reaper joins
    // live scope units against the dispatches table and SIGTERMs every PID
    // whose row is absent; the picker then re-picked the same card every
    // tick). The fix in `startDispatchTracking` re-throws so the spawn aborts
    // at the source; the caller's repoLocalPath argument (when present) gets
    // a CRITICAL_FAILURE flag written so the poller halts on its next tick.
    mockInsertDispatch.mockRejectedValueOnce(new Error("db down"));
    const watcher = makeMockWatcher();
    await expect(
      startDispatchTracking({
        jobId: "job-8",
        repoName: "r",
        trigger: slackTrigger,
        runtimeMode: "docker",
        danxbotCommit: null,
        agentName: null,
        watcher: watcher as never,
      }),
    ).rejects.toThrow("db down");
  });

  describe("Tier 4 retry envelope (DX-637)", () => {
    it("retries a transient pg error and proceeds without CRITICAL_FAILURE", async () => {
      // First call throws transient connection-terminated; second call
      // succeeds. The retry wrapper keeps the blip from reaching the
      // handler's CRITICAL_FAILURE branch.
      mockInsertDispatch
        .mockRejectedValueOnce(
          new Error("Connection terminated due to connection timeout"),
        )
        .mockResolvedValueOnce(undefined);

      const watcher = makeMockWatcher();
      await startDispatchTracking({
        jobId: "job-tier4",
        repoName: "danxbot",
        trigger: slackTrigger,
        runtimeMode: "docker",
        danxbotCommit: "abc",
        agentName: null,
        watcher: watcher as never,
      });

      expect(mockInsertDispatch).toHaveBeenCalledTimes(2);
      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({ topic: "dispatch:created" }),
      );
    });

    it("does not retry a non-transient insert error — fails fast as before", async () => {
      mockInsertDispatch.mockRejectedValueOnce(
        Object.assign(new Error("unique_violation"), { code: "23505" }),
      );
      const watcher = makeMockWatcher();
      await expect(
        startDispatchTracking({
          jobId: "job-fatal",
          repoName: "r",
          trigger: slackTrigger,
          runtimeMode: "docker",
          danxbotCommit: null,
          agentName: null,
          watcher: watcher as never,
        }),
      ).rejects.toThrow("unique_violation");

      expect(mockInsertDispatch).toHaveBeenCalledOnce();
    });
  });
});

// ─── EventBus publishing ──────────────────────────────────────────────────────

describe("startDispatchTracking — EventBus publishing", () => {
  it("publishes dispatch:created with the full dispatch row on successful insert", async () => {
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "job-ev1",
      repoName: "danxbot",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: "abc",
      agentName: null,
      watcher: watcher as never,
      startedAtMs: 1000,
    });

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "dispatch:created", data: expect.objectContaining({ id: "job-ev1", status: "running" }) }),
    );
  });

  it("does NOT publish dispatch:created when insertDispatch throws (fail loud — call rejects)", async () => {
    mockInsertDispatch.mockRejectedValueOnce(new Error("db down"));
    const watcher = makeMockWatcher();
    await expect(
      startDispatchTracking({
        jobId: "job-ev2",
        repoName: "r",
        trigger: slackTrigger,
        runtimeMode: "docker",
        danxbotCommit: null,
        agentName: null,
        watcher: watcher as never,
      }),
    ).rejects.toThrow("db down");

    expect(mockPublish).not.toHaveBeenCalledWith(
      expect.objectContaining({ topic: "dispatch:created" }),
    );
  });

  it("publishes dispatch:updated on finalize with correct payload fields", async () => {
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-ev3",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });
    mockPublish.mockClear();

    await tracker.finalize("completed", {
      summary: "all done",
      tokens: { tokensIn: 10, tokensOut: 5, cacheRead: 2, cacheWrite: 1 },
    });

    const call = mockPublish.mock.calls[0][0] as { topic: string; data: Record<string, unknown> };
    expect(call.topic).toBe("dispatch:updated");
    expect(call.data.id).toBe("job-ev3");
    expect(call.data.status).toBe("completed");
    expect(call.data.summary).toBe("all done");
    expect(call.data.error).toBeNull();
    expect(call.data.tokensTotal).toBe(18); // 10+5+2+1
    expect(call.data.completedAt).toBeTypeOf("number");
  });

  it("does NOT publish dispatch:updated when updateDispatch throws on finalize", async () => {
    mockUpdateDispatch.mockRejectedValueOnce(new Error("db down"));
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-ev4",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });
    mockPublish.mockClear();

    await tracker.finalize("completed", {
      summary: "done",
      tokens: noTokens,
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("publishes error field and null summary on failed finalize", async () => {
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-ev5",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      agentName: null,
      watcher: watcher as never,
    });
    mockPublish.mockClear();

    await tracker.finalize("failed", {
      error: "Agent timed out",
      tokens: noTokens,
    });

    const call = mockPublish.mock.calls[0][0] as { topic: string; data: Record<string, unknown> };
    expect(call.topic).toBe("dispatch:updated");
    expect(call.data.id).toBe("job-ev5");
    expect(call.data.status).toBe("failed");
    expect(call.data.error).toBe("Agent timed out");
    expect(call.data.summary).toBeNull();
  });
});

// =============================================================================
// DX-604 — applyStrike branches: failed-class strikes, completed resets,
// cancelled is a true no-op
// =============================================================================

function setupRepoDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "danxbot-applystrike-test-"));
  mkdirSync(resolve(dir, ".danxbot"), { recursive: true });
  return dir;
}

function validAgentRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    type: "agent",
    bio: "apply-strike test bio.",
    capabilities: ["issue-worker"],
    schedule: {
      tz: "UTC",
      always_on: true,
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    },
    enabled: true,
    broken: null,
    strikes: { count: 0, history: [] },
    created_at: "2026-05-14T00:00:00Z",
    updated_at: "2026-05-14T00:00:00Z",
    ...over,
  };
}

function seedAgent(localPath: string, name: string, over?: Partial<AgentRecord>): void {
  const settings: Settings = {
    overrides: {
      slack: { enabled: null },
      issuePoller: { enabled: null },
      dispatchApi: { enabled: null },
      ideator: { enabled: null },
      autoTriage: { enabled: null },
      trelloSync: { enabled: null },
    },
    display: {},
    agents: { [name]: validAgentRecord(over) },
    agentDefaults: { prepMode: "combined" },
    meta: { updatedAt: "2026-05-14T00:00:00Z", updatedBy: "worker" },
  };
  writeFileSync(
    settingsFilePath(localPath),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );
}

function strikeEntry(over: Partial<AgentStrikeEntry> = {}): AgentStrikeEntry {
  return {
    dispatch_id: over.dispatch_id ?? "d1",
    issue_id: over.issue_id ?? "DX-1",
    terminal_status: over.terminal_status ?? "failed",
    timestamp: over.timestamp ?? "2026-05-14T00:00:01Z",
    raw_error: over.raw_error ?? "",
  };
}

describe("applyStrike — DX-604 reset on completed", () => {
  let localPath: string;

  beforeEach(() => {
    _resetForTesting();
    localPath = setupRepoDir();
  });

  afterEach(() => {
    rmSync(localPath, { recursive: true, force: true });
  });

  it("resets strikes.count + history to zero on terminal status 'completed'", async () => {
    seedAgent(localPath, "alice", {
      strikes: {
        count: 2,
        history: [
          strikeEntry({ dispatch_id: "d1" }),
          strikeEntry({ dispatch_id: "d2", timestamp: "2026-05-14T00:00:02Z" }),
        ],
      },
    });

    await applyStrike({
      status: "completed",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "completion-1",
      issueId: "DX-9",
      rawError: null,
      timestampIso: "2026-05-14T10:00:00Z",
    });

    const after = readSettings(localPath).agents?.alice;
    expect(after?.strikes.count).toBe(0);
    expect(after?.strikes.history).toEqual([]);
    expect(after?.updated_at).toBe("2026-05-14T10:00:00Z");
  });

  it("failures still increment strikes — reset path does NOT capture failed-class statuses", async () => {
    seedAgent(localPath, "alice", {
      strikes: { count: 1, history: [strikeEntry({ dispatch_id: "prior" })] },
    });

    await applyStrike({
      status: "failed",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "fail-1",
      issueId: "DX-9",
      rawError: "boom",
      timestampIso: "2026-05-14T10:00:00Z",
    });

    const after = readSettings(localPath).agents?.alice;
    expect(after?.strikes.count).toBe(2);
    expect(after?.strikes.history).toHaveLength(2);
    expect(after?.strikes.history[1].dispatch_id).toBe("fail-1");
  });

  it("cancelled neither strikes nor resets (operator interrupt)", async () => {
    const seedHistory = [strikeEntry({ dispatch_id: "prior" })];
    seedAgent(localPath, "alice", {
      strikes: { count: 1, history: seedHistory },
    });

    await applyStrike({
      status: "cancelled",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "cancel-1",
      issueId: "DX-9",
      rawError: null,
      timestampIso: "2026-05-14T10:00:00Z",
    });

    const after = readSettings(localPath).agents?.alice;
    // Counter preserved exactly — neither incremented nor cleared.
    expect(after?.strikes.count).toBe(1);
    expect(after?.strikes.history).toHaveLength(1);
    expect(after?.strikes.history[0].dispatch_id).toBe("prior");
    // updated_at also untouched — applyStrike returned without any write.
    expect(after?.updated_at).toBe("2026-05-14T00:00:00Z");
  });

  it("recovered + throttled still strike (DX-365 contract preserved); next completed clears", async () => {
    seedAgent(localPath, "alice");

    await applyStrike({
      status: "recovered",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "rec-1",
      issueId: "DX-9",
      rawError: null,
      timestampIso: "2026-05-14T10:00:00Z",
    });
    await applyStrike({
      status: "throttled",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "thr-1",
      issueId: "DX-9",
      rawError: null,
      timestampIso: "2026-05-14T10:00:01Z",
    });
    let after = readSettings(localPath).agents?.alice;
    expect(after?.strikes.count).toBe(2);

    await applyStrike({
      status: "completed",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "ok-1",
      issueId: "DX-9",
      rawError: null,
      timestampIso: "2026-05-14T10:00:02Z",
    });
    after = readSettings(localPath).agents?.alice;
    expect(after?.strikes.count).toBe(0);
    expect(after?.strikes.history).toEqual([]);
  });

  it("3 consecutive failures still trip the broken-flag (no completion between them)", async () => {
    seedAgent(localPath, "alice");

    for (let i = 1; i <= 3; i++) {
      await applyStrike({
        status: "failed",
        repoLocalPath: localPath,
        repoName: "myrepo",
        agentName: "alice",
        dispatchId: `fail-${i}`,
        issueId: "DX-9",
        rawError: "boom",
        timestampIso: `2026-05-14T10:00:0${i}Z`,
      });
    }

    const after = readSettings(localPath).agents?.alice;
    expect(after?.strikes.count).toBe(3);
    expect(after?.broken).not.toBeNull();
  });

  it("doom-loop fixed: 2 failed → completed → 2 more failed does NOT trip broken at the old 3-consecutive threshold", async () => {
    seedAgent(localPath, "alice");

    // First two failures accumulate against an old-style durable counter.
    for (const i of [1, 2]) {
      await applyStrike({
        status: "failed",
        repoLocalPath: localPath,
        repoName: "myrepo",
        agentName: "alice",
        dispatchId: `pre-fail-${i}`,
        issueId: "DX-9",
        rawError: "boom",
        timestampIso: `2026-05-14T09:00:0${i}Z`,
      });
    }
    expect(readSettings(localPath).agents?.alice.strikes.count).toBe(2);

    // A productive completion lands — DX-604 says this clears the counter.
    await applyStrike({
      status: "completed",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "productive-1",
      issueId: "DX-9",
      rawError: null,
      timestampIso: "2026-05-14T10:00:00Z",
    });
    expect(readSettings(localPath).agents?.alice.strikes.count).toBe(0);

    // Two more transient failures — pre-DX-604 these would have been the
    // 3rd + 4th strike against a durable counter and tripped broken.
    // Post-DX-604 they're 1 + 2 against a freshly-cleared counter.
    for (const i of [1, 2]) {
      await applyStrike({
        status: "failed",
        repoLocalPath: localPath,
        repoName: "myrepo",
        agentName: "alice",
        dispatchId: `post-fail-${i}`,
        issueId: "DX-9",
        rawError: "boom",
        timestampIso: `2026-05-14T11:00:0${i}Z`,
      });
    }

    const after = readSettings(localPath).agents?.alice;
    expect(after?.strikes.count).toBe(2);
    // Critical: broken-flag NOT tripped. This is the load-bearing
    // assertion the card was filed to deliver — flaky-but-productive
    // agents survive transient instability between completions.
    expect(after?.broken).toBeNull();
  });

  it("completed on already-broken agent: count resets to 0, broken record preserved", async () => {
    const preExistingBroken = {
      reason: "manual operator flag",
      suggested_steps: ["check logs"],
      set_at: "2026-05-14T00:00:00Z",
      evaluator_status: "completed" as const,
      evaluator_dispatch_id: null,
    };
    seedAgent(localPath, "alice", {
      strikes: { count: 3, history: [strikeEntry({ dispatch_id: "prior" })] },
      broken: preExistingBroken,
    });

    await applyStrike({
      status: "completed",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "ok-1",
      issueId: "DX-9",
      rawError: null,
      timestampIso: "2026-05-14T10:00:00Z",
    });

    const after = readSettings(localPath).agents?.alice;
    expect(after?.strikes.count).toBe(0);
    expect(after?.strikes.history).toEqual([]);
    // Broken stays — the dashboard banner is dismissed only by operator
    // action, not by a single successful completion.
    expect(after?.broken).not.toBeNull();
    expect(after?.broken?.reason).toBe("manual operator flag");
  });

  it("resetStrikes failure (missing agent) is swallowed — applyStrike resolves without throwing", async () => {
    seedAgent(localPath, "alice");
    // Reference a name not in the roster — resetStrikes will throw inside,
    // applyStrike's try/catch must keep the dispatch finalize path clean.
    await expect(
      applyStrike({
        status: "completed",
        repoLocalPath: localPath,
        repoName: "myrepo",
        agentName: "ghost",
        dispatchId: "ok-1",
        issueId: "DX-9",
        rawError: null,
        timestampIso: "2026-05-14T10:00:00Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("guard short-circuits when repoLocalPath / agentName / issueId is missing — no write", async () => {
    seedAgent(localPath, "alice", {
      strikes: { count: 1, history: [strikeEntry({ dispatch_id: "prior" })] },
    });

    // null repoLocalPath
    await applyStrike({
      status: "completed",
      repoLocalPath: null,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "x",
      issueId: "DX-9",
      rawError: null,
      timestampIso: "2026-05-14T10:00:00Z",
    });
    // null agentName
    await applyStrike({
      status: "completed",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: null,
      dispatchId: "x",
      issueId: "DX-9",
      rawError: null,
      timestampIso: "2026-05-14T10:00:00Z",
    });
    // null issueId
    await applyStrike({
      status: "completed",
      repoLocalPath: localPath,
      repoName: "myrepo",
      agentName: "alice",
      dispatchId: "x",
      issueId: null,
      rawError: null,
      timestampIso: "2026-05-14T10:00:00Z",
    });

    const after = readSettings(localPath).agents?.alice;
    // All three guards short-circuited — counter unchanged.
    expect(after?.strikes.count).toBe(1);
    expect(after?.strikes.history[0].dispatch_id).toBe("prior");
  });
});
