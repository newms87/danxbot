import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeConfig,
  makeRepoContext,
  makeSlackMessage,
  makeSlackThreadReply,
  makeThreadState,
  makeRouterResult,
} from "../__tests__/helpers/fixtures.js";
import { createMockWebClient } from "../__tests__/helpers/slack-mock.js";

// --- Config mock (required before any src/slack/listener.js import chain) ---

const mockConfig = makeConfig();

vi.mock("../config.js", () => ({
  config: mockConfig,
}));

// --- Helper mocks ---

const mockSwapReaction = vi.fn();

vi.mock("./helpers.js", () => ({
  swapReaction: mockSwapReaction,
}));

// --- Router + agent mocks ---

const mockRunRouter = vi.fn();

vi.mock("../agent/router.js", () => ({
  runRouter: mockRunRouter,
}));

// --- Dispatch core mock (the Phase 4 workspace entry point) ---

// A list of every `dispatchWithWorkspace()` input observed in the test,
// plus the resolver that fires the `onComplete` callback with a fake
// AgentJob. Retained as `dispatchCalls` (not renamed) since
// orchestrating the call shape didn't change — only the callee name.
interface DispatchCall {
  input: Record<string, unknown>;
  complete: (job: {
    id: string;
    status: string;
    summary?: string | null;
  }) => void;
  reject: (err: Error) => void;
}

const dispatchCalls: DispatchCall[] = [];
const mockDispatch = vi.fn();

vi.mock("../dispatch/core.js", () => ({
  dispatchWithWorkspace: (...args: unknown[]) => mockDispatch(...args),
}));

// --- findLatestDispatchBySlackThread mock (thread continuity lookup) ---

const mockFindLatestDispatchBySlackThread = vi.fn().mockResolvedValue(null);

vi.mock("../dashboard/dispatches-db.js", () => ({
  findLatestDispatchBySlackThread: (...args: unknown[]) =>
    mockFindLatestDispatchBySlackThread(...args),
}));

// --- Thread + queue + user cache mocks ---

const mockGetOrCreateThread = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockIsBotParticipant = vi.fn();
const mockTrimThreadMessages = vi.fn().mockImplementation((msgs: unknown[]) => msgs);

vi.mock("../threads.js", () => ({
  getOrCreateThread: mockGetOrCreateThread,
  addMessageToThread: mockAddMessageToThread,
  isBotParticipant: mockIsBotParticipant,
  trimThreadMessages: (...args: unknown[]) => mockTrimThreadMessages(...args),
}));

const mockIsProcessing = vi.fn().mockReturnValue(false);
const mockMarkProcessing = vi.fn();
const mockMarkIdle = vi.fn();
const mockEnqueue = vi.fn();
const mockDequeue = vi.fn().mockReturnValue(undefined);
const mockResetQueue = vi.fn();

vi.mock("./message-queue.js", () => ({
  isProcessing: (...args: unknown[]) => mockIsProcessing(...args),
  markProcessing: (...args: unknown[]) => mockMarkProcessing(...args),
  markIdle: (...args: unknown[]) => mockMarkIdle(...args),
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  dequeue: (...args: unknown[]) => mockDequeue(...args),
  resetQueue: (...args: unknown[]) => mockResetQueue(...args),
  getQueueStats: vi.fn().mockReturnValue({}),
  getTotalQueuedCount: vi.fn().mockReturnValue(0),
}));

vi.mock("./user-cache.js", () => ({
  resolveUserName: vi.fn().mockResolvedValue("Test User"),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockNotifyError = vi.fn().mockResolvedValue(undefined);

vi.mock("../errors/trello-notifier.js", () => ({
  notifyError: (...args: unknown[]) => mockNotifyError(...args),
}));

const mockIsFeatureEnabled = vi.fn().mockReturnValue(true);

vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

// `@slack/bolt` — App must be a real class so `new App()` works.
let capturedMessageHandler: Function;

vi.mock("@slack/bolt", () => {
  return {
    App: class MockApp {
      client = {
        auth: {
          test: vi.fn().mockResolvedValue({ user_id: "BOT_USER_ID" }),
        },
      };
      message(handler: Function) {
        capturedMessageHandler = handler;
      }
      async start() {}
    },
  };
});

// Mock the slack allowlist profile via the real module (it's a pure
// data structure — no need to mock).

const { startSlackListener, stopSlackListener, resetListenerState } =
  await import("./listener.js");

let handler: (args: {
  message: Record<string, unknown>;
  client: ReturnType<typeof createMockWebClient>;
}) => Promise<void>;
let client: ReturnType<typeof createMockWebClient>;

/**
 * Configure `mockDispatch` so it resolves its returned promise and, on
 * the next microtask, invokes the stored `onComplete` with the supplied
 * terminal `AgentJob` shape. Tests that need to control the timing or
 * simulate a failure can grab the entry off `dispatchCalls` directly.
 */
function arrangeDispatchSuccess(finalJob: {
  id?: string;
  status?: string;
  summary?: string | null;
} = {}): void {
  mockDispatch.mockImplementation(async (input: Record<string, unknown>) => {
    const onComplete = input.onComplete as (job: unknown) => void;
    // Defer so the caller can `await dispatch(...).catch(...)` without
    // racing the onComplete — matches real `dispatch()` which returns
    // after spawnAgent and fires onComplete on a later terminal event.
    queueMicrotask(() => {
      onComplete({
        id: finalJob.id ?? "fake-dispatch-id",
        status: finalJob.status ?? "completed",
        summary: finalJob.summary ?? "Done.",
      });
    });
    return { dispatchId: finalJob.id ?? "fake-dispatch-id", job: {} };
  });
}

/**
 * Arrange `mockDispatch` to throw synchronously (e.g. MCP resolve error)
 * so the listener's try/catch exercises its spawn-error branch.
 */
function arrangeDispatchSpawnError(err: Error): void {
  mockDispatch.mockImplementation(async () => {
    throw err;
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  dispatchCalls.length = 0;
  mockIsProcessing.mockReturnValue(false);
  mockDequeue.mockReturnValue(undefined);
  mockIsFeatureEnabled.mockReturnValue(true);
  mockFindLatestDispatchBySlackThread.mockResolvedValue(null);
  mockTrimThreadMessages.mockImplementation((msgs: unknown[]) => msgs);

  // Reset listener state (shutdown flag and in-flight tracking)
  resetListenerState();

  // Re-register handler each test (startSlackListener calls app.message(handler))
  await startSlackListener(makeRepoContext());
  handler = capturedMessageHandler as typeof handler;
  client = createMockWebClient();

  // Default: thread setup returns a basic thread state
  mockGetOrCreateThread.mockResolvedValue(makeThreadState());
});

// ============================================================
// Filter tests
// ============================================================

describe("message filters", () => {
  it("ignores messages with a subtype", async () => {
    const message = makeSlackMessage({ subtype: "channel_join" });
    await handler({ message, client });
    expect(mockRunRouter).not.toHaveBeenCalled();
  });

  it("ignores messages with no text", async () => {
    const message = makeSlackMessage({ text: undefined });
    await handler({ message, client });
    expect(mockRunRouter).not.toHaveBeenCalled();
  });

  it("ignores messages from bots", async () => {
    const message = makeSlackMessage({ bot_id: "B-BOT" });
    await handler({ message, client });
    expect(mockRunRouter).not.toHaveBeenCalled();
  });

  it("ignores messages from the wrong channel", async () => {
    const message = makeSlackMessage({ channel: "C-OTHER" });
    await handler({ message, client });
    expect(mockRunRouter).not.toHaveBeenCalled();
  });
});

// ============================================================
// Router-only (no deep agent)
// ============================================================

describe("router-only responses", () => {
  it("posts the router's quickResponse and does not dispatch when needsAgent is false", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ quickResponse: "Hi there!", needsAgent: false }),
    );
    arrangeDispatchSuccess();

    await handler({ message: makeSlackMessage(), client });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hi there!" }),
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

// ============================================================
// Deep agent dispatch (the Phase 2 migration core)
// ============================================================

describe("deep agent dispatch", () => {
  beforeEach(() => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true, quickResponse: "" }),
    );
  });

  it("calls dispatchWithWorkspace with workspace='slack-worker' and DANXBOT_WORKER_PORT in overlay; slack URLs auto-injected by the dispatch core", async () => {
    arrangeDispatchSuccess();

    await handler({ message: makeSlackMessage({ ts: "555.111" }), client });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const input = mockDispatch.mock.calls[0][0] as Record<string, unknown>;

    // P4 contract: the slack listener names the workspace and supplies
    // the port placeholder only. The dispatch core auto-injects
    // `DANXBOT_STOP_URL` + `DANXBOT_SLACK_*_URL` from the dispatchId
    // (callers can't pre-compute them). Tool allowlist is NOT a caller
    // concern anymore — the workspace's `allowed-tools.txt` owns it, and
    // the workspace gate controls whether this dispatch runs at all.
    expect(input.workspace).toBe("slack-worker");
    expect(input).not.toHaveProperty("allowTools");
    const overlay = input.overlay as Record<string, string>;
    expect(overlay.DANXBOT_WORKER_PORT).toBe(
      String((input.repo as Record<string, unknown>).workerPort),
    );
    // The listener MUST NOT pre-inject slack URL placeholders — that is
    // the dispatch core's responsibility (URLs are dispatchId-derived).
    expect(overlay.DANXBOT_SLACK_REPLY_URL).toBeUndefined();
    expect(overlay.DANXBOT_SLACK_UPDATE_URL).toBeUndefined();

    // apiDispatchMeta carries the Slack trigger + full metadata. Still
    // persisted on the dispatch row so the dashboard can filter by
    // trigger; no longer drives tool resolution.
    const meta = input.apiDispatchMeta as {
      trigger: string;
      metadata: Record<string, unknown>;
    };
    expect(meta.trigger).toBe("slack");
    expect(meta.metadata).toMatchObject({
      channelId: "C-TEST",
      threadTs: "555.111",
      messageTs: "555.111",
      user: "U-HUMAN",
      messageText: "Hello danxbot",
    });

    // repo carries into dispatch for settings-file + workerPort lookups.
    expect((input.repo as Record<string, unknown>).name).toBe("test-repo");
  });

  it("prepends [Thread context] to the prompt when there's no prior completed dispatch and the thread has >1 messages", async () => {
    mockGetOrCreateThread.mockResolvedValue(
      makeThreadState({
        messages: [
          { user: "U1", text: "first", ts: "1", isBot: false },
          { user: "U1", text: "second", ts: "2", isBot: false },
        ],
      }),
    );
    arrangeDispatchSuccess();

    await handler({
      message: makeSlackMessage({ text: "latest question" }),
      client,
    });

    const input = mockDispatch.mock.calls[0][0] as Record<string, unknown>;
    const task = input.task as string;
    expect(task).toContain("[Thread context]");
    expect(task).toContain("[Current message]");
    expect(task).toContain("latest question");
    // Resume is NOT set since there's no prior dispatch
    expect(input.resumeSessionId).toBeUndefined();
    expect(input.parentJobId).toBeUndefined();
  });

  it("passes resumeSessionId + parentJobId when a prior completed dispatch exists for the thread", async () => {
    mockFindLatestDispatchBySlackThread.mockResolvedValue({
      id: "prior-dispatch-123",
      sessionUuid: "session-uuid-prior",
      status: "completed",
    });
    arrangeDispatchSuccess();
    mockIsBotParticipant.mockResolvedValue(true);

    await handler({
      message: makeSlackThreadReply({ text: "follow-up" }),
      client,
    });

    const input = mockDispatch.mock.calls[0][0] as Record<string, unknown>;
    expect(input.resumeSessionId).toBe("session-uuid-prior");
    expect(input.parentJobId).toBe("prior-dispatch-123");
    // When resuming, we do NOT prepend thread history — the Claude
    // session already has it.
    expect(input.task).toBe("follow-up");
  });

  it("does NOT set parentJobId when the prior dispatch has a null sessionUuid (can't resume -> no lineage claim)", async () => {
    // A completed prior dispatch can legitimately have `sessionUuid: null`
    // — e.g. the JSONL was purged under retention, or the prior dispatch
    // finalized before the watcher resolved a session UUID. In that case
    // the new dispatch must NOT set `parentJobId` either: that would be
    // an inconsistent state (dispatches row claims a parent, but claude
    // runs fresh because there is no `resumeSessionId`).
    mockFindLatestDispatchBySlackThread.mockResolvedValue({
      id: "prior-no-session",
      sessionUuid: null,
      status: "completed",
    });
    arrangeDispatchSuccess();
    mockIsBotParticipant.mockResolvedValue(true);

    await handler({
      message: makeSlackThreadReply({ text: "follow-up" }),
      client,
    });

    const input = mockDispatch.mock.calls[0][0] as Record<string, unknown>;
    expect(input.resumeSessionId).toBeUndefined();
    expect(input.parentJobId).toBeUndefined();
  });

  it("posts the brain reaction while working and swaps to :white_check_mark: on successful completion", async () => {
    arrangeDispatchSuccess({ status: "completed" });

    await handler({ message: makeSlackMessage({ ts: "777.333" }), client });

    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "brain", timestamp: "777.333" }),
    );
    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "777.333",
      "brain",
      "white_check_mark",
    );
  });

  it("swaps to :x: and posts a failure line into the thread when the agent exits failed", async () => {
    arrangeDispatchSuccess({
      status: "failed",
      summary: "Ran out of memory",
    });

    await handler({ message: makeSlackMessage({ ts: "888.444" }), client });

    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "888.444",
      "brain",
      "x",
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Ran out of memory"),
      }),
    );
    expect(mockNotifyError).toHaveBeenCalled();
  });

  it("handles dispatch spawn errors (MCP resolve / infrastructure) with :x: + failure line + Trello notify", async () => {
    arrangeDispatchSpawnError(
      new Error("unknown MCP server \"nope\" in allow_tools"),
    );

    await handler({ message: makeSlackMessage({ ts: "999.555" }), client });

    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "999.555",
      "brain",
      "x",
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("couldn't launch the agent"),
      }),
    );
    expect(mockNotifyError).toHaveBeenCalled();
  });

  it("does NOT notify Trello when a transient network error breaks the dispatch spawn (ETIMEDOUT, ECONNREFUSED, etc.)", async () => {
    // Transient errors shouldn't create Trello noise — the retry/back-
    // pressure path handles them. The listener still reacts :x: and
    // posts a failure line, but stays quiet on the Trello side.
    arrangeDispatchSpawnError(new Error("ETIMEDOUT"));

    await handler({ message: makeSlackMessage({ ts: "t.1" }), client });

    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "t.1",
      "brain",
      "x",
    );
    expect(mockNotifyError).not.toHaveBeenCalled();
  });

  it("uses a status-specific failure phrase when the agent terminates non-completed", async () => {
    arrangeDispatchSuccess({ status: "timeout", summary: "no activity" });

    await handler({ message: makeSlackMessage({ ts: "to.1" }), client });

    const postCalls = client.chat.postMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as Record<string, string>).text,
    );
    expect(
      postCalls.some((t: string) => t.includes("Timed out")),
    ).toBe(true);
  });

  it("does NOT Trello-notify user-cancelled dispatches (operator action, not an error)", async () => {
    arrangeDispatchSuccess({ status: "canceled", summary: null });

    await handler({ message: makeSlackMessage({ ts: "c.1" }), client });

    expect(mockSwapReaction).toHaveBeenCalledWith(
      client,
      "C-TEST",
      "c.1",
      "brain",
      "x",
    );
    expect(mockNotifyError).not.toHaveBeenCalled();
  });

  it("marks thread idle and drains the queue after dispatch completes (happy path)", async () => {
    arrangeDispatchSuccess();

    await handler({ message: makeSlackMessage({ ts: "abc.1" }), client });

    expect(mockMarkProcessing).toHaveBeenCalledWith("abc.1");
    expect(mockMarkIdle).toHaveBeenCalledWith("abc.1");
    expect(mockDequeue).toHaveBeenCalledWith("abc.1");
  });

  it("marks thread idle after a spawn error too (no leaked processing state)", async () => {
    arrangeDispatchSpawnError(new Error("boom"));

    await handler({ message: makeSlackMessage({ ts: "abc.2" }), client });

    expect(mockMarkIdle).toHaveBeenCalledWith("abc.2");
  });

  it("does not call dispatch when a dispatch is already in flight for the thread — enqueues instead", async () => {
    mockIsProcessing.mockReturnValue(true);

    await handler({ message: makeSlackMessage({ ts: "q.1" }), client });

    expect(mockEnqueue).toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("I'll get to this"),
      }),
    );
  });
});

// ============================================================
// Thread handling
// ============================================================

describe("thread handling", () => {
  it("processes thread reply when bot is participating", async () => {
    mockIsBotParticipant.mockResolvedValue(true);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: false, quickResponse: "OK" }),
    );

    await handler({ message: makeSlackThreadReply(), client });

    expect(mockRunRouter).toHaveBeenCalled();
  });

  it("ignores thread reply when bot is NOT participating", async () => {
    mockIsBotParticipant.mockResolvedValue(false);
    await handler({ message: makeSlackThreadReply(), client });
    expect(mockRunRouter).not.toHaveBeenCalled();
  });
});

// ============================================================
// Feature toggle
// ============================================================

describe("Slack feature toggle via settings.json", () => {
  it("reacts :no_entry_sign: and posts the disabled message when Slack is disabled for this repo", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);

    await handler({ message: makeSlackMessage(), client });

    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "no_entry_sign" }),
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("currently disabled"),
      }),
    );
    expect(mockRunRouter).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("runs the normal handler when Slack is enabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: false, quickResponse: "Hi!" }),
    );

    await handler({ message: makeSlackMessage(), client });

    expect(mockRunRouter).toHaveBeenCalled();
  });
});

// ============================================================
// Router error routing
// ============================================================

describe("router error paths", () => {
  it("routes operational router errors to Needs Help list", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({
        needsAgent: false,
        quickResponse: "",
        error: "billing_error: limit exceeded",
        isOperational: true,
      }),
    );

    await handler({ message: makeSlackMessage(), client });

    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.any(Object),
      "Router Error",
      expect.stringContaining("billing_error"),
      expect.any(Object),
      expect.objectContaining({
        listId: "test-needs-help-list-id",
        labelId: "test-needs-help-label-id",
      }),
    );
  });

  it("routes non-operational router errors to the default list (no overrides)", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({
        needsAgent: false,
        quickResponse: "",
        error: "unexpected error",
        isOperational: false,
      }),
    );

    await handler({ message: makeSlackMessage(), client });

    const args = mockNotifyError.mock.calls[0];
    expect(args[1]).toBe("Router Error");
    expect(args.length).toBe(4); // No overrides argument
  });
});

// ============================================================
// Handler top-level error
// ============================================================

describe("top-level handler errors", () => {
  it("reacts :x: and notifies Trello when a non-transient top-level error fires", async () => {
    mockGetOrCreateThread.mockRejectedValue(new Error("thread db crashed"));

    await handler({ message: makeSlackMessage(), client });

    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
    );
    expect(mockNotifyError).toHaveBeenCalledWith(
      expect.any(Object),
      "Handler Error",
      expect.stringContaining("thread db crashed"),
      expect.any(Object),
    );
  });

  it("does not notify Trello for transient network errors at the top level", async () => {
    mockGetOrCreateThread.mockRejectedValue(new Error("ETIMEDOUT"));

    await handler({ message: makeSlackMessage(), client });

    expect(mockNotifyError).not.toHaveBeenCalled();
  });
});

// ============================================================
// Shutdown sanity
// ============================================================

describe("shutdown", () => {
  it("stopSlackListener blocks further dispatches", async () => {
    stopSlackListener();
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: true }),
    );
    arrangeDispatchSuccess();

    await handler({ message: makeSlackMessage(), client });

    expect(mockRunRouter).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
