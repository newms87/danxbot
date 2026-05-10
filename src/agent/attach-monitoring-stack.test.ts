/**
 * Unit tests for the Phase 2b extracted `attachMonitoringStack` helper.
 *
 * The full integration coverage lives in `launcher.test.ts` (111 tests
 * exercising the pre-extraction inline implementation, all passing
 * post-refactor — that's the primary behavior-preservation gate). These
 * tests target the helper directly with mocked watcher / queue / forwarder
 * so future maintainers can drive it without spinning up a full spawn.
 */

// Note: `./usage-accumulator.js` is intentionally NOT mocked. The
// dedup test exercises the real accumulator's messageId-set logic
// against the helper's `watcher.onEntry` wiring — that's the contract
// being verified end-to-end. If a maintainer adds a mock here, the
// dedup test silently degrades to a no-op.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    logsDir: "/tmp/danxbot-test-logs",
    isHost: false,
  },
}));

// Mock SessionLogWatcher — capture every onEntry callback so tests can
// emit synthetic JSONL entries through the helper's wiring.
const mockWatcherEntryCallbacks: Array<(entry: unknown) => void> = [];
vi.mock("./session-log-watcher.js", () => ({
  SessionLogWatcher: class {
    onEntry = vi.fn((cb: (entry: unknown) => void) => {
      mockWatcherEntryCallbacks.push(cb);
    });
    start = vi.fn().mockResolvedValue(undefined);
    drain = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    getSessionFilePath = vi.fn().mockReturnValue(null);
  },
  DISPATCH_TAG_PREFIX: "<!-- danxbot-dispatch:",
}));

// Mock the laravel forwarder factory so tests can assert call shape.
const mockForwarderConsume = vi.fn();
const mockForwarderFlush = vi.fn().mockResolvedValue(undefined);
const mockCreateLaravelForwarder = vi.fn().mockReturnValue({
  consume: mockForwarderConsume,
  flush: mockForwarderFlush,
});
vi.mock("./laravel-forwarder.js", () => ({
  createLaravelForwarder: (...args: unknown[]) =>
    mockCreateLaravelForwarder(...args),
  deriveQueuePath: vi.fn(
    (baseDir: string, dispatchId: string) => `${baseDir}/${dispatchId}.jsonl`,
  ),
}));

// EventQueue is constructed but never invoked in unit-test scope.
vi.mock("./event-queue.js", () => ({
  EventQueue: class {
    constructor(public path: string) {}
  },
}));

// Heartbeat / status PUTs are wired through agent-status — keep real impls
// out and assert via spies.
const mockStartHeartbeat = vi.fn();
const mockNotifyTerminalStatus = vi.fn();
vi.mock("./agent-status.js", () => ({
  startHeartbeat: (...args: unknown[]) => mockStartHeartbeat(...args),
  stopHeartbeat: vi.fn(),
  notifyTerminalStatus: (...args: unknown[]) =>
    mockNotifyTerminalStatus(...args),
  putStatus: vi.fn().mockResolvedValue(undefined),
}));

// Stop handler is exercised end-to-end in launcher.test.ts; stub it out
// here so the helper's `stop` return is observable as a callable.
vi.mock("./agent-stop.js", () => ({
  buildJobStopHandler: vi
    .fn()
    .mockReturnValue(vi.fn().mockResolvedValue(undefined)),
}));

// Cleanup builder is exercised end-to-end in launcher.test.ts; the helper
// only cares that the cached cleanup closure is plumbed through.
vi.mock("./agent-cleanup.js", () => ({
  buildCleanup: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(undefined)),
}));

vi.mock("./danxbot-commit.js", () => ({
  getDanxbotCommit: vi.fn().mockReturnValue("test-sha"),
}));

const mockDispatchTrackerFinalize = vi.fn().mockResolvedValue(undefined);
const mockStartDispatchTracking = vi.fn().mockResolvedValue({
  finalize: mockDispatchTrackerFinalize,
  recordNudge: vi.fn().mockResolvedValue(undefined),
});
vi.mock("../dashboard/dispatch-tracker.js", () => ({
  startDispatchTracking: (...args: unknown[]) =>
    mockStartDispatchTracking(...args),
}));

import { attachMonitoringStack } from "./attach-monitoring-stack.js";
import type { AgentJob, SpawnAgentOptions } from "./agent-types.js";

function createSkeletonJob(): AgentJob {
  return {
    id: "test-job-id",
    status: "running",
    summary: "",
    startedAt: new Date(),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    stop: async () => {
      throw new Error("placeholder");
    },
  };
}

function baseOptions(
  overrides: Partial<SpawnAgentOptions> = {},
): SpawnAgentOptions {
  return {
    prompt: "/danx-next",
    repoName: "platform",
    timeoutMs: 300_000,
    cwd: "/tmp/test-workspace",
    ...overrides,
  };
}

function emitWatcherEntry(entry: Record<string, unknown>): void {
  for (const cb of mockWatcherEntryCallbacks) cb(entry);
}

describe("attachMonitoringStack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWatcherEntryCallbacks.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accumulates per-turn usage with messageId-dedup across multi-block assistant entries", async () => {
    const job = createSkeletonJob();

    await attachMonitoringStack({
      job,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions(),
    });

    // First turn: two JSONL entries (text block + tool_use block) from a
    // multi-block response — both stamp the IDENTICAL message.usage on
    // the same message.id. Second occurrence MUST be deduped.
    emitWatcherEntry({
      type: "assistant",
      data: {
        messageId: "msg-1",
        content: [{ type: "text", text: "hello" }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    emitWatcherEntry({
      type: "assistant",
      data: {
        messageId: "msg-1",
        content: [{ type: "tool_use", name: "Read", input: {} }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });

    // Second turn: a fresh message id, must be added on top.
    emitWatcherEntry({
      type: "assistant",
      data: {
        messageId: "msg-2",
        content: [{ type: "text", text: "world" }],
        usage: {
          input_tokens: 200,
          output_tokens: 75,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 10,
        },
      },
    });

    expect(job.usage.input_tokens).toBe(300);
    expect(job.usage.output_tokens).toBe(125);
    expect(job.usage.cache_read_input_tokens).toBe(5);
    expect(job.usage.cache_creation_input_tokens).toBe(10);
  });

  it("resets the inactivity timer on every watcher entry — long tool-use streams without text count as alive", async () => {
    vi.useFakeTimers();
    const job = createSkeletonJob();
    job.handle = {
      pid: 4242,
      kill: vi.fn(),
      isAlive: vi.fn().mockReturnValue(true),
      onExit: vi.fn(),
      dispose: vi.fn(),
    };

    await attachMonitoringStack({
      job,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions({ timeoutMs: 30_000 }),
    });

    // Advance just under the timeout, then emit an entry — the timer
    // should reset and the kill MUST NOT have fired.
    vi.advanceTimersByTime(20_000);
    emitWatcherEntry({
      type: "assistant",
      data: { content: [{ type: "tool_use" }] },
    });
    vi.advanceTimersByTime(20_000);
    expect(job.handle.kill).not.toHaveBeenCalled();
    expect(job.status).toBe("running");

    // No more entries — the timer fires and kills.
    vi.advanceTimersByTime(15_000);
    expect(job.handle.kill).toHaveBeenCalledWith("SIGTERM");
    expect(job.status).toBe("timeout");
    expect(mockNotifyTerminalStatus).toHaveBeenCalledWith(
      job,
      expect.any(Object),
      "timeout",
      expect.any(String),
    );
  });

  it("Phase 2c seam: existingDispatchTracker bypasses startDispatchTracking and is stamped on job.dispatchTracker", async () => {
    const job = createSkeletonJob();
    const reattachedTracker = {
      finalize: vi.fn().mockResolvedValue(undefined),
      recordNudge: vi.fn().mockResolvedValue(undefined),
    } as never;

    const result = await attachMonitoringStack({
      job,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions({
        dispatch: { kind: "test", source: "test" } as never,
      }),
      existingDispatchTracker: reattachedTracker,
    });

    // The whole point of the seam: no new row inserted.
    expect(mockStartDispatchTracking).not.toHaveBeenCalled();
    // Caller's tracker is now the canonical reference for this spawn.
    expect(job.dispatchTracker).toBe(reattachedTracker);
    expect(result.dispatchTracker).toBe(reattachedTracker);
  });

  it("inserts a fresh dispatch row when options.dispatch is set and existingDispatchTracker is unset", async () => {
    const job = createSkeletonJob();
    const trigger = { kind: "test", source: "test" } as never;

    await attachMonitoringStack({
      job,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions({
        dispatch: trigger,
        repoName: "platform",
        parentJobId: "parent-id",
        issueId: "DX-208",
        agentName: "murphy",
        mcpSettingsPath: "/tmp/mcp.json",
      }),
    });

    expect(mockStartDispatchTracking).toHaveBeenCalledOnce();
    expect(mockStartDispatchTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "test-job-id",
        repoName: "platform",
        trigger,
        runtimeMode: "docker",
        parentJobId: "parent-id",
        issueId: "DX-208",
        agentName: "murphy",
        mcpSettingsPath: "/tmp/mcp.json",
      }),
    );
    expect(job.dispatchTracker).toBeDefined();
  });

  it("skips dispatch tracking entirely when neither options.dispatch nor existingDispatchTracker is set", async () => {
    const job = createSkeletonJob();

    const result = await attachMonitoringStack({
      job,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions(),
    });

    expect(mockStartDispatchTracking).not.toHaveBeenCalled();
    expect(job.dispatchTracker).toBeUndefined();
    expect(result.dispatchTracker).toBeUndefined();
  });

  it("starts the heartbeat only when both statusUrl and apiToken are provided", async () => {
    const noAuthJob = createSkeletonJob();
    await attachMonitoringStack({
      job: noAuthJob,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions(),
    });
    expect(mockStartHeartbeat).not.toHaveBeenCalled();

    const partialJob = createSkeletonJob();
    await attachMonitoringStack({
      job: partialJob,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions({ statusUrl: "https://laravel.test/api/status" }),
    });
    expect(mockStartHeartbeat).not.toHaveBeenCalled();

    const fullJob = createSkeletonJob();
    await attachMonitoringStack({
      job: fullJob,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions({
        statusUrl: "https://laravel.test/api/status",
        apiToken: "tok",
      }),
    });
    expect(mockStartHeartbeat).toHaveBeenCalledWith(fullJob, "tok");
  });

  it("max-runtime timer kills the job and signals timeout when the cap fires while running", async () => {
    vi.useFakeTimers();
    const job = createSkeletonJob();
    job.handle = {
      pid: 4242,
      kill: vi.fn(),
      isAlive: vi.fn().mockReturnValue(true),
      onExit: vi.fn(),
      dispose: vi.fn(),
    };

    await attachMonitoringStack({
      job,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions({
        timeoutMs: 600_000, // out of the way — we're testing the OTHER timer
        maxRuntimeMs: 60_000,
      }),
    });

    vi.advanceTimersByTime(60_001);
    expect(job.handle.kill).toHaveBeenCalledWith("SIGTERM");
    expect(job.status).toBe("timeout");
    expect(job.summary).toMatch(/exceeded max runtime/);
    expect(mockNotifyTerminalStatus).toHaveBeenCalledWith(
      job,
      expect.any(Object),
      "timeout",
      expect.stringMatching(/exceeded max runtime/),
    );
  });

  it("skips event forwarding setup when options.eventForwarding is undefined", async () => {
    const job = createSkeletonJob();

    await attachMonitoringStack({
      job,
      jobId: "test-job-id",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions(),
    });

    expect(mockCreateLaravelForwarder).not.toHaveBeenCalled();

    // Sanity: when forwarding IS configured the forwarder factory IS called.
    const trackedJob = createSkeletonJob();
    await attachMonitoringStack({
      job: trackedJob,
      jobId: "test-job-id-2",
      agentCwd: "/tmp/test-workspace",
      promptDir: null,
      options: baseOptions({
        eventForwarding: {
          statusUrl: "https://laravel.test/api/status",
          apiToken: "tok",
        },
      }),
    });
    expect(mockCreateLaravelForwarder).toHaveBeenCalledWith(
      "https://laravel.test/api/status",
      "tok",
      expect.objectContaining({ queue: expect.anything() }),
    );
  });
});
