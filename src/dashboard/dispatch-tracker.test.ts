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
  extractSessionUuidFromPath,
  startDispatchTracking,
  type FinalizeTokens,
} from "./dispatch-tracker.js";
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
      watcher: watcher as never,
      startedAtMs: 2000,
      parentJobId: "parent-aea75840",
    });

    expect(mockInsertDispatch).toHaveBeenCalledOnce();
    expect(mockInsertDispatch.mock.calls[0][0].parentJobId).toBe(
      "parent-aea75840",
    );
  });

  it("updates sessionUuid + jsonlPath on first entry after watcher attaches", async () => {
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "job-2",
      repoName: "platform",
      trigger: slackTrigger,
      runtimeMode: "host",
      danxbotCommit: null,
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

  it("finalize computes tokensTotal from the four component counters", async () => {
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-5",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
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

  it("finalize uses failed status with error string", async () => {
    const watcher = makeMockWatcher();
    const tracker = await startDispatchTracking({
      jobId: "job-6",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
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
      watcher: watcher as never,
    });

    await tracker.recordNudge(2);
    expect(mockUpdateDispatch).toHaveBeenLastCalledWith("job-7", {
      nudgeCount: 2,
    });
  });

  it("insert failure does not throw (agent run continues)", async () => {
    mockInsertDispatch.mockRejectedValueOnce(new Error("db down"));
    const watcher = makeMockWatcher();
    await expect(
      startDispatchTracking({
        jobId: "job-8",
        repoName: "r",
        trigger: slackTrigger,
        runtimeMode: "docker",
        danxbotCommit: null,
        watcher: watcher as never,
      }),
    ).resolves.toBeDefined();
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
      watcher: watcher as never,
      startedAtMs: 1000,
    });

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "dispatch:created", data: expect.objectContaining({ id: "job-ev1", status: "running" }) }),
    );
  });

  it("does NOT publish dispatch:created when insertDispatch throws", async () => {
    mockInsertDispatch.mockRejectedValueOnce(new Error("db down"));
    const watcher = makeMockWatcher();
    await startDispatchTracking({
      jobId: "job-ev2",
      repoName: "r",
      trigger: slackTrigger,
      runtimeMode: "docker",
      danxbotCommit: null,
      watcher: watcher as never,
    });

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
