import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Dispatch } from "./dispatches.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockListDispatches = vi.fn();
vi.mock("./dispatches-db.js", () => ({
  listDispatches: (...args: unknown[]) => mockListDispatches(...args),
}));

const mockPublish = vi.fn();
const mockSubscriberCount = vi.fn().mockReturnValue(1); // default: at least one subscriber
vi.mock("./event-bus.js", () => ({
  eventBus: {
    publish: (...args: unknown[]) => mockPublish(...args),
    subscriberCount: (...args: unknown[]) => mockSubscriberCount(...args),
  },
}));

const mockReadFile = vi.fn();
const mockOpen = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  open: (...args: unknown[]) => mockOpen(...args),
}));

const mockParseJsonlContent = vi.fn();
vi.mock("./jsonl-reader.js", () => ({
  parseJsonlContent: (...args: unknown[]) => mockParseJsonlContent(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import AFTER mocks.
import {
  startDbChangeDetector,
  stopDbChangeDetector,
  startJsonlWatcher,
  stopJsonlWatcher,
  _stopAll,
} from "./dispatch-stream.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "job-1",
    repoName: "danxbot",
    trigger: "api",
    triggerMetadata: {
      endpoint: "/api/launch",
      callerIp: null,
      statusUrl: null,
      initialPrompt: "test",
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
    ...overrides,
  };
}

/**
 * Flush pending microtasks. Since mocked Promises resolve immediately (in the
 * next microtask tick), a few cycles are sufficient to let async chains settle.
 * vi.useFakeTimers() only fakes timer APIs, not Promise microtasks.
 */
async function flushAsync(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i++) await Promise.resolve();
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  _stopAll();
  // Default: at least one subscriber (the normal case).
  mockSubscriberCount.mockReturnValue(1);
});

afterEach(() => {
  _stopAll();
  vi.useRealTimers();
});

// ─── DB change detector ───────────────────────────────────────────────────────

describe("DB change detector", () => {
  it("publishes dispatch:created for a new dispatch on the immediate startup tick", async () => {
    const d = makeDispatch({ id: "job-new" });
    mockListDispatches.mockResolvedValue([d]);

    startDbChangeDetector();
    await flushAsync();

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "dispatch:created", data: d }),
    );
  });

  it("does NOT re-publish a dispatch that hasn't changed on the next interval tick", async () => {
    const d = makeDispatch({ id: "job-stable" });
    mockListDispatches.mockResolvedValue([d]);

    startDbChangeDetector();
    await flushAsync(); // initial tick → created
    mockPublish.mockClear();

    // Second tick — same dispatch.
    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsync();

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("publishes dispatch:updated when a tracked dispatch changes status", async () => {
    const d = makeDispatch({ id: "job-change", status: "running" });
    mockListDispatches.mockResolvedValue([d]);

    startDbChangeDetector();
    await flushAsync(); // initial tick → created
    mockPublish.mockClear();

    mockListDispatches.mockResolvedValue([
      { ...d, status: "completed", completedAt: Date.now() },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsync();

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "dispatch:updated" }),
    );
    const call = mockPublish.mock.calls[0][0] as { topic: string; data: { id: string; status: string } };
    expect(call.data.id).toBe("job-change");
    expect(call.data.status).toBe("completed");
  });

  it("publishes dispatch:updated when tokensTotal changes", async () => {
    const d = makeDispatch({ id: "job-tokens", tokensTotal: 0 });
    mockListDispatches.mockResolvedValue([d]);

    startDbChangeDetector();
    await flushAsync();
    mockPublish.mockClear();

    mockListDispatches.mockResolvedValue([{ ...d, tokensTotal: 500 }]);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsync();

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "dispatch:updated" }),
    );
  });

  it("publishes dispatch:updated when error changes (dispatch fails with message)", async () => {
    const d = makeDispatch({ id: "job-err", status: "running", error: null });
    mockListDispatches.mockResolvedValue([d]);

    startDbChangeDetector();
    await flushAsync();
    mockPublish.mockClear();

    mockListDispatches.mockResolvedValue([
      { ...d, status: "failed", error: "Agent exceeded max runtime" },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsync();

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "dispatch:updated" }),
    );
    const call = mockPublish.mock.calls[0][0] as { topic: string; data: { id: string; error: string } };
    expect(call.data.id).toBe("job-err");
    expect(call.data.error).toBe("Agent exceeded max runtime");
  });

  it("is idempotent — calling startDbChangeDetector twice starts only one poller", async () => {
    const d = makeDispatch();
    mockListDispatches.mockResolvedValue([d]);

    startDbChangeDetector();
    startDbChangeDetector(); // no-op
    await flushAsync();

    // Only one immediate tick fired (not two, which would happen if two pollers started).
    expect(mockListDispatches).toHaveBeenCalledTimes(1);
  });

  it("swallows DB errors and continues polling on the next tick", async () => {
    mockListDispatches
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue([makeDispatch()]);

    startDbChangeDetector();
    await flushAsync(); // error tick — swallowed
    mockPublish.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsync();

    expect(mockPublish).toHaveBeenCalled();
  });

  it("stopDbChangeDetector stops the poller so no more ticks run", async () => {
    const d = makeDispatch();
    mockListDispatches.mockResolvedValue([d]);

    startDbChangeDetector();
    await flushAsync(); // initial tick
    mockPublish.mockClear();

    stopDbChangeDetector();
    await vi.advanceTimersByTimeAsync(4_000); // would normally fire two more ticks
    await flushAsync();

    expect(mockListDispatches).toHaveBeenCalledTimes(1); // no new ticks after stop
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

// ─── JSONL watcher ────────────────────────────────────────────────────────────

describe("JSONL watcher", () => {
  const JOB_ID = "job-jsonl";
  const JSONL_PATH = "/runs/job-jsonl/session.jsonl";

  function makeFhStub(fileSize: number) {
    return {
      stat: vi.fn().mockResolvedValue({ size: fileSize }),
      read: vi.fn().mockImplementation(
        async (buf: Buffer) => {
          buf.fill(97); // fill with 'a'
          return { bytesRead: buf.length };
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("hydrates existing content immediately on start", async () => {
    const existing = '{"type":"assistant"}\n';
    mockReadFile.mockResolvedValue(existing);
    mockParseJsonlContent.mockReturnValue({
      blocks: [{ type: "assistant_text", text: "hi", timestampMs: 0 }],
    });

    await startJsonlWatcher(JOB_ID, JSONL_PATH);

    expect(mockReadFile).toHaveBeenCalledWith(JSONL_PATH, "utf-8");
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: `dispatch:jsonl:${JOB_ID}` }),
    );
  });

  it("does NOT publish on hydration when there are no blocks", async () => {
    mockReadFile.mockResolvedValue("");
    mockParseJsonlContent.mockReturnValue({ blocks: [] });

    await startJsonlWatcher(JOB_ID, JSONL_PATH);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("polls for new blocks and publishes them on each tick", async () => {
    mockReadFile.mockResolvedValue(""); // empty initial
    mockParseJsonlContent.mockReturnValue({ blocks: [] });
    await startJsonlWatcher(JOB_ID, JSONL_PATH);
    mockPublish.mockClear();

    // File grew — next tick should publish.
    const fh = makeFhStub(100);
    mockOpen.mockResolvedValue(fh);
    mockParseJsonlContent.mockReturnValue({
      blocks: [{ type: "user", text: "test", timestampMs: 0 }],
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockOpen).toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ topic: `dispatch:jsonl:${JOB_ID}` }),
    );
  });

  it("does NOT publish when file has not grown since last tick", async () => {
    const initialContent = "initial content";
    mockReadFile.mockResolvedValue(initialContent);
    mockParseJsonlContent.mockReturnValue({ blocks: [] });
    await startJsonlWatcher(JOB_ID, JSONL_PATH);
    mockPublish.mockClear();

    // File size same as what was already read (no growth).
    const initialBytes = Buffer.byteLength(initialContent, "utf-8");
    const fh = makeFhStub(initialBytes);
    mockOpen.mockResolvedValue(fh);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(fh.read).not.toHaveBeenCalled(); // size check short-circuits
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("is idempotent — calling startJsonlWatcher twice for the same jobId starts only one watcher", async () => {
    mockReadFile.mockResolvedValue("");
    mockParseJsonlContent.mockReturnValue({ blocks: [] });

    await startJsonlWatcher(JOB_ID, JSONL_PATH);
    await startJsonlWatcher(JOB_ID, JSONL_PATH); // no-op

    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it("stopJsonlWatcher clears the poll interval", async () => {
    mockReadFile.mockResolvedValue("");
    mockParseJsonlContent.mockReturnValue({ blocks: [] });
    await startJsonlWatcher(JOB_ID, JSONL_PATH);
    mockPublish.mockClear();

    stopJsonlWatcher(JOB_ID);

    const fh = makeFhStub(50);
    mockOpen.mockResolvedValue(fh);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushAsync();

    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("closes the file handle in finally even when read throws", async () => {
    mockReadFile.mockResolvedValue("");
    mockParseJsonlContent.mockReturnValue({ blocks: [] });
    await startJsonlWatcher(JOB_ID, JSONL_PATH);
    mockPublish.mockClear();

    const fh = {
      stat: vi.fn().mockResolvedValue({ size: 100 }),
      read: vi.fn().mockRejectedValue(new Error("disk I/O error")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockOpen.mockResolvedValue(fh);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    // Even though read threw, close must have been called.
    expect(fh.close).toHaveBeenCalled();
  });

  it("swallows ENOENT when the file does not exist yet on a tick", async () => {
    mockReadFile.mockResolvedValue("");
    mockParseJsonlContent.mockReturnValue({ blocks: [] });
    await startJsonlWatcher(JOB_ID, JSONL_PATH);
    mockPublish.mockClear();

    mockOpen.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
    );

    // Should not throw.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("does not register the poll interval when all subscribers disconnect during readFile", async () => {
    // Simulate the early-disconnect race: the subscriber count drops to 0
    // before startJsonlWatcher finishes awaiting readFile.
    mockSubscriberCount.mockReturnValue(0);
    mockReadFile.mockResolvedValue("");
    mockParseJsonlContent.mockReturnValue({ blocks: [] });

    await startJsonlWatcher(JOB_ID, JSONL_PATH);

    // Verify no timer was registered by advancing time — publish should NOT be called.
    mockPublish.mockClear();
    const fh = {
      stat: vi.fn().mockResolvedValue({ size: 50 }),
      read: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockOpen.mockResolvedValue(fh);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
