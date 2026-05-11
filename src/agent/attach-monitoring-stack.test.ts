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

// DX-260 (Phase 2 of DX-246) — recover handler writes the per-repo
// CRITICAL_FAILURE flag on the cap-exhausted path. Mock so the test
// can assert the call without touching the real fs path.
const mockWriteFlag = vi.fn();
vi.mock("../critical-failure.js", () => ({
  writeFlag: (...args: unknown[]) => mockWriteFlag(...args),
}));

const mockDispatchTrackerFinalize = vi.fn().mockResolvedValue(undefined);
const mockDispatchTrackerRecordRecoverCount = vi.fn().mockResolvedValue(undefined);
const mockStartDispatchTracking = vi.fn().mockResolvedValue({
  finalize: mockDispatchTrackerFinalize,
  recordNudge: vi.fn().mockResolvedValue(undefined),
  recordRecoverCount: mockDispatchTrackerRecordRecoverCount,
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
    recoverCount: 0,
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

  // ── DX-260 (Phase 2 of DX-246) — API-error recover handler ─────────────
  //
  // The handler is wired by attachMonitoringStack as an `ApiErrorDetector`
  // `onApiError` callback. The detector arms a 5s confirmation window on
  // the synthetic JSONL pair Claude Code emits when the Anthropic stream
  // times out mid-turn. These two tests exercise the recover-ok branch
  // (count <= MAX_RECOVERS) and the cap-exhausted branch (count >
  // MAX_RECOVERS) end-to-end through the helper's wiring.

  describe("API-error recover handler (DX-260)", () => {
    function emitSyntheticApiError(): void {
      // Surface form 1 — `isApiErrorMessage: true` flag. See
      // `api-error-detector.ts` for the second accepted form.
      emitWatcherEntry({
        timestamp: Date.now(),
        type: "assistant",
        summary: "synthetic-api-error",
        data: {
          messageId: "msg-err",
          content: [{ type: "text", text: "API Error: Stream idle timeout" }],
          raw: {
            isApiErrorMessage: true,
            message: {
              model: "<synthetic>",
              stop_reason: "stop_sequence",
              content: [
                {
                  type: "text",
                  text: "API Error: Stream idle timeout - partial response received",
                },
              ],
            },
          },
        },
      });
    }

    it("recover-ok path: persists incremented count, calls job.stop('api_error_recover'), POSTs /api/resume with chain bookkeeping", async () => {
      vi.useFakeTimers();
      // Stub fetch so the recover handler's `/api/resume` POST resolves
      // without hitting the network. Returns a fake 200 — the handler
      // only checks `response.ok`.
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ job_id: "child-id" }), {
            status: 200,
          }) as unknown as Response,
        );

      const job = createSkeletonJob();
      await attachMonitoringStack({
        job,
        jobId: "test-job-id",
        agentCwd: "/tmp/test-workspace",
        promptDir: null,
        options: baseOptions({
          // Required for the dispatch tracker — without it
          // recordRecoverCount has nowhere to persist.
          dispatch: { kind: "test", source: "test" } as never,
          apiToken: "test-bearer",
          recoverContext: {
            originalTask: "Process card DX-260",
            workspace: "issue-worker",
            workerPort: 9009,
            repoLocalPath: "/tmp/repo",
          },
        }),
      });

      emitSyntheticApiError();
      // Detector arms a 5s timer; advance past it so onApiError fires.
      // `advanceTimersByTimeAsync` flushes microtasks between ticks so
      // the handler's awaits resolve before our assertions run.
      await vi.advanceTimersByTimeAsync(5_001);

      expect(job.recoverCount).toBe(1);
      expect(mockDispatchTrackerRecordRecoverCount).toHaveBeenCalledWith(1);
      // Type assertion: the mock factory replaces `job.stop` with a
      // vitest mock function; vitest's matchers read its `.mock` slot.
      expect(job.stop as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "api_error_recover",
        expect.stringMatching(/recover 1\/3/),
      );
      // Cap-exhausted path is NOT taken: no flag, no api_error_failed.
      expect(mockWriteFlag).not.toHaveBeenCalled();
      // /api/resume POSTed with the right URL + body shape.
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://localhost:9009/api/resume",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
      const callArgs = fetchSpy.mock.calls[0][1] as RequestInit;
      const parsedBody = JSON.parse(callArgs.body as string);
      expect(parsedBody).toEqual({
        repo: "platform",
        job_id: "test-job-id",
        task: "Process card DX-260",
        workspace: "issue-worker",
        recover_count: 1,
        parent_recover_id: "test-job-id",
        api_token: "test-bearer",
      });

      fetchSpy.mockRestore();
    });

    it("cap-exhausted path: writes CRITICAL_FAILURE flag, calls job.stop('api_error_failed'), does NOT POST /api/resume", async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("{}", { status: 200 }) as unknown as Response,
      );

      const job = createSkeletonJob();
      // Seed the in-memory counter so the next increment puts it OVER
      // the cap. `initialRecoverCount=3` → increment → 4 > MAX_RECOVERS.
      await attachMonitoringStack({
        job,
        jobId: "test-job-id",
        agentCwd: "/tmp/test-workspace",
        promptDir: null,
        options: baseOptions({
          dispatch: { kind: "test", source: "test" } as never,
          apiToken: "test-bearer",
          initialRecoverCount: 3,
          recoverContext: {
            originalTask: "Process card DX-260",
            workspace: "issue-worker",
            workerPort: 9009,
            repoLocalPath: "/tmp/repo",
          },
        }),
      });
      expect(job.recoverCount).toBe(3);

      emitSyntheticApiError();
      await vi.advanceTimersByTimeAsync(5_001);

      // Counter persisted post-increment so operators looking at the
      // dispatches row see exactly how many recoveries the chain ran
      // before the cap fired.
      expect(job.recoverCount).toBe(4);
      expect(mockDispatchTrackerRecordRecoverCount).toHaveBeenCalledWith(4);
      // CRITICAL_FAILURE flag written into the right repo dir with the
      // synthetic error text as detail.
      expect(mockWriteFlag).toHaveBeenCalledWith(
        "/tmp/repo",
        expect.objectContaining({
          source: "agent",
          dispatchId: "test-job-id",
          reason: "API-error recover cap exhausted",
          detail: expect.stringMatching(/API Error: Stream idle timeout/),
        }),
      );
      // Cap-exhausted signaling — NOT api_error_recover.
      expect(job.stop as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "api_error_failed",
        expect.stringMatching(/recover 4\/3/),
      );
      // No /api/resume — chain ends here pending operator clear.
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it("early-returns when job.status is already non-running by the time the 5s window fires (sibling teardown already won)", async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const job = createSkeletonJob();
      await attachMonitoringStack({
        job,
        jobId: "test-job-id",
        agentCwd: "/tmp/test-workspace",
        promptDir: null,
        options: baseOptions({
          dispatch: { kind: "test", source: "test" } as never,
          apiToken: "test-bearer",
          recoverContext: {
            originalTask: "task",
            workspace: "issue-worker",
            workerPort: 9009,
            repoLocalPath: "/tmp/repo",
          },
        }),
      });

      emitSyntheticApiError();
      // Stall detector / cancel / inactivity timer already terminated
      // the job before the detector's confirmation window fired.
      job.status = "canceled";
      await vi.advanceTimersByTimeAsync(5_001);

      // Recover handler observed non-running and bailed: counter
      // never incremented, no flag, no stop call, no /api/resume POST.
      expect(job.recoverCount).toBe(0);
      expect(mockDispatchTrackerRecordRecoverCount).not.toHaveBeenCalled();
      expect(mockWriteFlag).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it("/api/resume HTTP failure does NOT escalate to CRITICAL_FAILURE — transient resume errors are recoverable on the next poller tick", async () => {
      vi.useFakeTimers();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("ECONNREFUSED"));

      const job = createSkeletonJob();
      await attachMonitoringStack({
        job,
        jobId: "test-job-id",
        agentCwd: "/tmp/test-workspace",
        promptDir: null,
        options: baseOptions({
          dispatch: { kind: "test", source: "test" } as never,
          apiToken: "test-bearer",
          recoverContext: {
            originalTask: "task",
            workspace: "issue-worker",
            workerPort: 9009,
            repoLocalPath: "/tmp/repo",
          },
        }),
      });

      emitSyntheticApiError();
      await vi.advanceTimersByTimeAsync(5_001);

      // Pre-conditions still hold: the recover-ok branch ran, the
      // counter incremented, job.stop was called.
      expect(job.recoverCount).toBe(1);
      expect(job.stop as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "api_error_recover",
        expect.any(String),
      );
      // Network/HTTP failure is logged but NOT promoted to the
      // cap-exhausted halt — persisting a CRITICAL_FAILURE for a
      // transient connection refused would defeat the whole recover
      // feature. The poller's next tick will re-pick the card up.
      expect(mockWriteFlag).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
    });

    it("recoverContext absent on recover-ok path: collapses to api_error_failed (NOT recovered) so the row doesn't leak in 'recovered' state with no resume-child to back it up", async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const job = createSkeletonJob();
      await attachMonitoringStack({
        job,
        jobId: "test-job-id",
        agentCwd: "/tmp/test-workspace",
        promptDir: null,
        options: baseOptions({
          dispatch: { kind: "test", source: "test" } as never,
          apiToken: "test-bearer",
          // recoverContext intentionally absent — tests + ad-hoc
          // spawns that bypass dispatch() reach this branch.
        }),
      });

      emitSyntheticApiError();
      await vi.advanceTimersByTimeAsync(5_001);

      expect(job.recoverCount).toBe(1);
      // Without context, the recover-ok branch fails-loud to
      // `api_error_failed` BEFORE `job.stop` finalizes the row —
      // otherwise the dashboard would show a `recovered` row with
      // no resume-child to continue the chain. The Slack listener's
      // short-circuit on `recovered` would also wait for a
      // recover-child that never arrives.
      expect(job.stop as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "api_error_failed",
        expect.any(String),
      );
      expect(job.stop as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(
        "api_error_recover",
        expect.anything(),
      );
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });
  });
});
