/**
 * Tests for `reattachOrResolveDispatches` — the Phase 2c (DX-209) boot
 * pass that supersedes `reconcileOrphanedDispatches`. Mocks the DB +
 * filesystem helpers so the test suite stays Layer 1 (free, fast).
 *
 * Coverage:
 *   1. Dead-PID branch — same semantics as the legacy reconcile (rows
 *      with null/zero/dead PID get marked failed + `pid_terminated_at`
 *      stamped). This locks the regression-equivalence with the prior
 *      reconcile suite.
 *   2. Alive-PID branch — every alive non-terminal row is registered
 *      in activeJobs with handle + watcher + tracker; the dispatch is
 *      cancellable + status-queryable via the standard worker routes.
 *   3. JSONL-not-found branch — alive PID but no `jsonl_path` on the
 *      row → mark failed with a distinct summary.
 *   4. MCP settings rewrite — same-port restart skips rewrite;
 *      different-port restart triggers rewrite.
 *   5. Result shape parity with `ReconcileResult` (scanned/orphaned/alive)
 *      with the new `reattached` + `failedReattach` arrays.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dispatch } from "../dashboard/dispatches.js";

// Mock the DB layer: returning rows + capturing updates.
const mockFindNonTerminalDispatches = vi.fn();
const mockUpdateDispatch = vi.fn();
vi.mock("../dashboard/dispatches-db.js", () => ({
  findNonTerminalDispatches: (...args: unknown[]) =>
    mockFindNonTerminalDispatches(...args),
  updateDispatch: (...args: unknown[]) => mockUpdateDispatch(...args),
}));

// Mock liveness — the OS-level check is unit-test-noisy.
const mockIsPidAlive = vi.fn();
vi.mock("../agent/host-pid.js", async () => {
  const actual = await vi.importActual<
    typeof import("../agent/host-pid.js")
  >("../agent/host-pid.js");
  return {
    ...actual,
    isPidAlive: (...args: unknown[]) => mockIsPidAlive(...args),
  };
});

// Mock the activeJobs registration so we can observe what reattach
// pushes in without dragging the whole dispatch core under the test.
const mockRegisterActiveJob = vi.fn();
vi.mock("../dispatch/core.js", () => ({
  registerActiveJob: (...args: unknown[]) => mockRegisterActiveJob(...args),
}));

// Mock the dispatch/event-bus so the helper can subscribe without DB.
vi.mock("../dashboard/event-bus.js", () => ({
  eventBus: { publish: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

// Logger noop — keeps test output clean.
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// `src/config.ts` reads required DB env vars at import time. Mock the
// pieces reattach.ts touches (`config.isHost`, `config.dispatch.*`) so
// the test can run as Layer 1 (no `.env`).
vi.mock("../config.js", () => ({
  config: {
    isHost: false,
    dispatch: { agentTimeoutMs: 60_000 },
    logsDir: "/tmp/reattach-test-logs",
  },
}));

// Mock auto-resume policy module so tests cover the reattach-side
// wiring (autoResumed array, fall-through to orphan-mark) without
// dragging dispatch core under the suite. Default = refuses (returns
// resumed:false); individual tests override per-call.
const mockAttemptAutoResume = vi.fn();
vi.mock("./reattach-resume.js", () => ({
  attemptAutoResume: (...args: unknown[]) => mockAttemptAutoResume(...args),
}));

import {
  buildReattachTracker,
  buildToolCounterSubscriber,
  reattachOrResolveDispatches,
} from "./reattach.js";
import type { AgentLogEntry } from "../types.js";

let tempBase: string;

function makeRow(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "job-id",
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {
      cardId: "card-1",
      cardName: "Card",
      cardUrl: "https://trello.com/c/card-1",
      listId: "list-1",
      listName: "ToDo",
    },
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    issueId: null,
    status: "running",
    startedAt: 1000,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "host",
    hostPid: 12345,
    hostPidAt: 1000,
    pidTerminatedAt: null,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    agentName: null,
    mcpSettingsPath: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tempBase = mkdtempSync(join(tmpdir(), "reattach-test-"));
  mockFindNonTerminalDispatches.mockResolvedValue([]);
  mockUpdateDispatch.mockResolvedValue(undefined);
  mockIsPidAlive.mockReturnValue(false);
});

afterEach(() => {
  rmSync(tempBase, { recursive: true, force: true });
});

function writeJsonlFile(name: string): string {
  const dir = join(tempBase, "session-dir");
  rmSync(dir, { recursive: true, force: true });
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, ""); // empty — fromEof seeds offset to 0
  return path;
}

function writeMcpSettingsFile(stopUrl: string): string {
  const path = join(tempBase, "settings.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          danxbot: {
            command: "npx",
            args: ["tsx", "/x.ts"],
            env: { DANXBOT_STOP_URL: stopUrl },
          },
        },
      },
      null,
      2,
    ),
  );
  return path;
}

describe("reattachOrResolveDispatches — dead-PID branch (regression-equivalent of legacy reconcile)", () => {
  it("marks rows with a dead host_pid as failed + stamps pid_terminated_at", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "dead-1", hostPid: 999_999, hostPidAt: 1000 }),
    ]);
    mockIsPidAlive.mockReturnValue(false);

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
    });

    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    const [id, fields] = mockUpdateDispatch.mock.calls[0];
    expect(id).toBe("dead-1");
    expect(fields.status).toBe("failed");
    expect(fields.summary).toMatch(/orphan/i);
    expect(typeof fields.completedAt).toBe("number");
    expect(fields.pidTerminatedAt).toBe(fields.completedAt);
    expect(result.orphaned).toEqual(["dead-1"]);
    expect(result.alive).toEqual([]);
    expect(result.reattached).toEqual([]);
    expect(result.scanned).toBe(1);
  });

  it("marks legacy rows with null host_pid as orphaned without probing the kernel", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "legacy", hostPid: null }),
    ]);

    await reattachOrResolveDispatches("danxbot", { currentWorkerPort: 9300 });

    expect(mockIsPidAlive).not.toHaveBeenCalled();
    expect(mockUpdateDispatch.mock.calls[0][0]).toBe("legacy");
    expect(mockUpdateDispatch.mock.calls[0][1].status).toBe("failed");
  });

  it("treats non-positive host_pid (0, negative) as orphaned without probing the kernel", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "zero", hostPid: 0 }),
    ]);
    await reattachOrResolveDispatches("danxbot", { currentWorkerPort: 9300 });
    expect(mockIsPidAlive).not.toHaveBeenCalled();
    expect(mockUpdateDispatch.mock.calls[0][0]).toBe("zero");
  });

  it("partitions a mixed batch and survives a transient update error", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "dead-1", hostPid: 1 }),
      makeRow({ id: "dead-2", hostPid: null }),
    ]);
    mockIsPidAlive.mockReturnValue(false);
    mockUpdateDispatch.mockImplementationOnce(async () => {
      throw new Error("transient db");
    });

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
    });

    // Both dead rows must be attempted even though the first throws.
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(2);
    expect(result.orphaned).toEqual(["dead-2"]);
    expect(result.scanned).toBe(2);
  });
});

describe("reattachOrResolveDispatches — alive-PID branch (full reattach)", () => {
  it("registers an alive dispatch into activeJobs with handle + watcher + tracker (no DB write)", async () => {
    const jsonl = writeJsonlFile("d-alive");
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "d-alive",
        hostPid: process.pid,
        jsonlPath: jsonl,
        mcpSettingsPath: writeMcpSettingsFile(
          "http://localhost:9300/api/stop/d-alive",
        ),
      }),
    ]);
    mockIsPidAlive.mockReturnValue(true);

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
    });

    expect(result.reattached).toEqual(["d-alive"]);
    expect(result.alive).toEqual(["d-alive"]);
    expect(result.orphaned).toEqual([]);

    // No DB write for the alive case — the row stays in `running`.
    expect(mockUpdateDispatch).not.toHaveBeenCalled();

    // Registered into activeJobs with the correct shape.
    expect(mockRegisterActiveJob).toHaveBeenCalledTimes(1);
    const [jobId, job] = mockRegisterActiveJob.mock.calls[0];
    expect(jobId).toBe("d-alive");
    expect(job.id).toBe("d-alive");
    expect(job.status).toBe("running");
    // Handle is wired and reports the row's PID.
    expect(job.handle).toBeDefined();
    expect(job.handle.pid).toBe(process.pid);
    // Watcher attached + stop handler stamped (via attachMonitoringStack).
    expect(typeof job.stop).toBe("function");
    expect(job.watcher).toBeDefined();
  });

  it("seeds usage totals from the row so post-restart accumulation extends pre-restart counts", async () => {
    const jsonl = writeJsonlFile("d-seed");
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "d-seed",
        hostPid: process.pid,
        jsonlPath: jsonl,
        tokensIn: 11,
        tokensOut: 22,
        cacheRead: 33,
        cacheWrite: 44,
        mcpSettingsPath: writeMcpSettingsFile(
          "http://localhost:9300/api/stop/d-seed",
        ),
      }),
    ]);
    mockIsPidAlive.mockReturnValue(true);

    await reattachOrResolveDispatches("danxbot", { currentWorkerPort: 9300 });

    const [, job] = mockRegisterActiveJob.mock.calls[0];
    expect(job.usage.input_tokens).toBe(11);
    expect(job.usage.output_tokens).toBe(22);
    expect(job.usage.cache_read_input_tokens).toBe(33);
    expect(job.usage.cache_creation_input_tokens).toBe(44);
  });

  it("rewrites the per-dispatch MCP settings file when the worker restarts on a different port", async () => {
    const jsonl = writeJsonlFile("d-port");
    const settingsPath = writeMcpSettingsFile(
      "http://localhost:9300/api/stop/d-port",
    );
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "d-port",
        hostPid: process.pid,
        jsonlPath: jsonl,
        mcpSettingsPath: settingsPath,
      }),
    ]);
    mockIsPidAlive.mockReturnValue(true);

    await reattachOrResolveDispatches("danxbot", { currentWorkerPort: 9400 });

    const updated = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      mcpServers: { danxbot: { env: Record<string, string> } };
    };
    expect(updated.mcpServers.danxbot.env.DANXBOT_STOP_URL).toBe(
      "http://localhost:9400/api/stop/d-port",
    );
  });

  it("does NOT rewrite the MCP settings file when the worker comes back on the same port", async () => {
    const jsonl = writeJsonlFile("d-same");
    const settingsPath = writeMcpSettingsFile(
      "http://localhost:9300/api/stop/d-same",
    );
    const before = readFileSync(settingsPath, "utf-8");
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "d-same",
        hostPid: process.pid,
        jsonlPath: jsonl,
        mcpSettingsPath: settingsPath,
      }),
    ]);
    mockIsPidAlive.mockReturnValue(true);

    await reattachOrResolveDispatches("danxbot", { currentWorkerPort: 9300 });

    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("works for Slack + /api/launch dispatches (no issue-card YAML required)", async () => {
    // Slack and api dispatches do not stamp `issueId`; reattach must
    // still register them by row id alone. No YAML lookup, no
    // dispatch.kind branching.
    const slackJsonl = writeJsonlFile("slack-1");
    const apiJsonl = writeJsonlFile("api-1");
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "slack-1",
        hostPid: process.pid,
        jsonlPath: slackJsonl,
        trigger: "slack",
        triggerMetadata: {
          channelId: "C1",
          threadTs: "T1",
          messageTs: "M1",
          user: "U1",
          userName: "u",
          messageText: "hi",
        },
        issueId: null,
      }),
      makeRow({
        id: "api-1",
        hostPid: process.pid,
        jsonlPath: apiJsonl,
        trigger: "api",
        triggerMetadata: {
          endpoint: "/api/launch",
          callerIp: null,
          statusUrl: null,
          initialPrompt: "go",
        },
        issueId: null,
      }),
    ]);
    mockIsPidAlive.mockReturnValue(true);

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
    });

    expect(result.reattached).toEqual(["slack-1", "api-1"]);
    expect(mockRegisterActiveJob).toHaveBeenCalledTimes(2);
    expect(mockRegisterActiveJob.mock.calls.map((c) => c[0])).toEqual([
      "slack-1",
      "api-1",
    ]);
  });
});

describe("reattachOrResolveDispatches — JSONL-not-found branch", () => {
  it("marks the row failed with a distinct summary when jsonlPath is null on an alive row (cannot reattach without a session file)", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "no-jsonl",
        hostPid: process.pid,
        jsonlPath: null,
      }),
    ]);
    mockIsPidAlive.mockReturnValue(true);

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
    });

    expect(result.failedReattach).toEqual(["no-jsonl"]);
    expect(result.reattached).toEqual([]);
    expect(mockRegisterActiveJob).not.toHaveBeenCalled();
    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    const [id, fields] = mockUpdateDispatch.mock.calls[0];
    expect(id).toBe("no-jsonl");
    expect(fields.status).toBe("failed");
    expect(fields.summary).toMatch(/session log/i);
    expect(typeof fields.pidTerminatedAt).toBe("number");
  });
});

describe("reattachOrResolveDispatches — empty input", () => {
  it("returns scanned=0 when there are no non-terminal rows", async () => {
    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
    });
    expect(result).toEqual({
      scanned: 0,
      orphaned: [],
      alive: [],
      reattached: [],
      failedReattach: [],
      autoResumed: [],
    });
  });
});

// --- Direct tests of the testability seams extracted from reattachAlive.
// These pin the closure-based wiring that was the most-undertested code
// in the original PR (per code-reviewer + test-reviewer feedback).

describe("buildToolCounterSubscriber — counter wiring", () => {
  function asAssistant(content: Array<Record<string, unknown>>): AgentLogEntry {
    return {
      timestamp: Date.now(),
      type: "assistant",
      summary: "",
      data: { content, raw: {} },
    } as AgentLogEntry;
  }

  it("increments toolCallCount on each tool_use block, seeded from initial counts", () => {
    const counters = buildToolCounterSubscriber({
      toolCallCount: 7,
      subagentCount: 2,
    });
    counters.subscriber(
      asAssistant([
        { type: "text", text: "ok" },
        { type: "tool_use", name: "Read", id: "t1" },
        { type: "tool_use", name: "Bash", id: "t2" },
      ]),
    );
    expect(counters.getCounts()).toEqual({
      toolCallCount: 9, // 7 seed + 2 new
      subagentCount: 2, // unchanged — neither block was a sub-agent
    });
  });

  it("counts both Agent and Task tool names as sub-agents (current + legacy)", () => {
    const counters = buildToolCounterSubscriber({
      toolCallCount: 0,
      subagentCount: 0,
    });
    counters.subscriber(
      asAssistant([
        { type: "tool_use", name: "Agent", id: "a" },
        { type: "tool_use", name: "Task", id: "b" },
      ]),
    );
    expect(counters.getCounts()).toEqual({
      toolCallCount: 2,
      subagentCount: 2,
    });
  });

  it("ignores non-assistant entries", () => {
    const counters = buildToolCounterSubscriber({
      toolCallCount: 5,
      subagentCount: 1,
    });
    counters.subscriber({
      timestamp: 1,
      type: "user",
      summary: "",
      data: { content: [], raw: {} },
    } as AgentLogEntry);
    expect(counters.getCounts()).toEqual({
      toolCallCount: 5,
      subagentCount: 1,
    });
  });
});

describe("attachStallDetectorForReattach — host-mode stall recovery", () => {
  // Mock StallDetector + flip config.isHost so the host-only stall
  // attach path runs. Then synthetically fire `onStall` and assert
  // job.stop("failed", …) lands. This is the only stall-recovery path
  // for reattached jobs (the original spawn's StallDetector is gone
  // with the prior worker incarnation).
  let stallStartCalls: number;
  let capturedOnStall: (() => Promise<void> | void) | null;
  beforeEach(() => {
    stallStartCalls = 0;
    capturedOnStall = null;
  });

  it("attaches a StallDetector when config.isHost && watcher set, and onStall calls job.stop('failed', ...)", async () => {
    // Re-mock config + StallDetector for THIS test only.
    vi.doMock("../config.js", () => ({
      config: {
        isHost: true,
        dispatch: { agentTimeoutMs: 60_000 },
        logsDir: "/tmp/reattach-test-logs",
      },
    }));
    vi.doMock("../agent/stall-detector.js", () => {
      class FakeStallDetector {
        constructor(opts: { onStall: () => void | Promise<void> }) {
          capturedOnStall = opts.onStall;
        }
        start(): void {
          stallStartCalls++;
        }
        stop(): void {
          /* no-op */
        }
      }
      return { StallDetector: FakeStallDetector };
    });
    vi.resetModules();
    const { reattachOrResolveDispatches: reattachIsolated } = await import(
      "./reattach.js"
    );

    const jsonl = writeJsonlFile("d-stall");
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "d-stall",
        hostPid: process.pid,
        jsonlPath: jsonl,
      }),
    ]);
    mockIsPidAlive.mockReturnValue(true);

    await reattachIsolated("danxbot", { currentWorkerPort: 9300 });

    // The detector started.
    expect(stallStartCalls).toBe(1);
    // Capture the registered job and replace its `stop` with a spy so
    // we can observe what `onStall` invokes.
    const [, job] = mockRegisterActiveJob.mock.calls[0];
    const stopSpy = vi.fn().mockResolvedValue(undefined);
    job.stop = stopSpy;
    job.status = "running";

    // Fire the stall.
    expect(capturedOnStall).not.toBeNull();
    await capturedOnStall!();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy.mock.calls[0][0]).toBe("failed");
    expect(stopSpy.mock.calls[0][1]).toMatch(/stall/i);

    // Restore the default mocks for subsequent tests in this file.
    vi.doUnmock("../config.js");
    vi.doUnmock("../agent/stall-detector.js");
    vi.resetModules();
  });
});

describe("buildReattachTracker — finalize / SSE / nudges", () => {
  it("writes terminal updateDispatch with seeded + bumped counters and publishes dispatch:updated to eventBus", async () => {
    const row = makeRow({
      id: "tracker-fin",
      tokensIn: 10,
      tokensOut: 20,
      cacheRead: 30,
      cacheWrite: 40,
      toolCallCount: 5,
      subagentCount: 1,
      nudgeCount: 2,
    });
    let postRestartTools = 3;
    let postRestartSubs = 1;
    const tracker = buildReattachTracker(row, () => ({
      toolCallCount: row.toolCallCount + postRestartTools, // 5+3=8
      subagentCount: row.subagentCount + postRestartSubs, // 1+1=2
    }));

    const { eventBus } = await import("../dashboard/event-bus.js");

    await tracker.finalize("completed", {
      summary: "ok",
      tokens: {
        tokensIn: 100,
        tokensOut: 200,
        cacheRead: 300,
        cacheWrite: 400,
      },
    });

    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    const [id, fields] = mockUpdateDispatch.mock.calls[0];
    expect(id).toBe("tracker-fin");
    expect(fields).toMatchObject({
      status: "completed",
      summary: "ok",
      tokensIn: 100,
      tokensOut: 200,
      cacheRead: 300,
      cacheWrite: 400,
      tokensTotal: 1000,
      toolCallCount: 8,
      subagentCount: 2,
      nudgeCount: 2, // preserved from row when not supplied
    });
    expect(typeof fields.completedAt).toBe("number");
    expect(fields.pidTerminatedAt).toBe(fields.completedAt);

    // SSE parity with `startDispatchTracking` — terminal state visible
    // to the dashboard immediately, not on next poll cycle.
    const publish = vi.mocked(eventBus.publish);
    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0][0] as {
      topic: string;
      data: { id: string; status: string; tokensTotal: number };
    };
    expect(event.topic).toBe("dispatch:updated");
    expect(event.data.id).toBe("tracker-fin");
    expect(event.data.status).toBe("completed");
    expect(event.data.tokensTotal).toBe(1000);
  });

  it("recordNudge writes a nudgeCount-only update (mid-run signal from StallDetector)", async () => {
    const row = makeRow({ id: "tracker-nudge", nudgeCount: 0 });
    const tracker = buildReattachTracker(row, () => ({
      toolCallCount: row.toolCallCount,
      subagentCount: row.subagentCount,
    }));

    await tracker.recordNudge(2);

    expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
    expect(mockUpdateDispatch.mock.calls[0]).toEqual([
      "tracker-nudge",
      { nudgeCount: 2 },
    ]);
  });

  it("counter advancement flows end-to-end: subscriber bumps → getCounters() → tracker.finalize persists the bumped value", async () => {
    // The integration of the two helpers is what reattachAlive wires
    // together. This test drives the full closure chain so a
    // regression that breaks the wiring is caught regardless of
    // internal refactors.
    const row = makeRow({
      id: "tracker-flow",
      toolCallCount: 0,
      subagentCount: 0,
    });
    const counters = buildToolCounterSubscriber({
      toolCallCount: row.toolCallCount,
      subagentCount: row.subagentCount,
    });
    const tracker = buildReattachTracker(row, counters.getCounts);

    counters.subscriber({
      timestamp: 1,
      type: "assistant",
      summary: "",
      data: {
        content: [
          { type: "tool_use", name: "Read", id: "t1" },
          { type: "tool_use", name: "Agent", id: "a1" },
        ],
        raw: {},
      },
    } as AgentLogEntry);

    await tracker.finalize("completed", {
      summary: "done",
      tokens: { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0 },
    });

    const [, fields] = mockUpdateDispatch.mock.calls[0];
    expect(fields.toolCallCount).toBe(2);
    expect(fields.subagentCount).toBe(1);
  });
});

// --- Auto-resume on boot (extension): dead-PID + recoverable session
//     → spawn child via dispatch() with --resume.
//
// The branch lives in `reattachOrResolveDispatches`; the policy lives in
// `attemptAutoResume`. These tests stub the policy module to keep the
// reattach-side wiring covered (autoResumed array, parent row NOT
// marked failed, log path) without dragging dispatch core under the
// suite.

describe("reattachOrResolveDispatches — dead-PID auto-resume branch", () => {
  const fakeRepo = {
    name: "danxbot",
    localPath: "/tmp/x",
  } as unknown as import("../types.js").RepoContext;

  beforeEach(() => {
    mockAttemptAutoResume.mockReset();
  });

  it("does not call attemptAutoResume when opts.repo is omitted (legacy callers)", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "dead-no-repo",
        hostPid: 999_999,
        sessionUuid: "session-u",
        jsonlPath: "/tmp/x.jsonl",
      }),
    ]);
    mockIsPidAlive.mockReturnValue(false);

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
    });

    expect(mockAttemptAutoResume).not.toHaveBeenCalled();
    expect(result.orphaned).toEqual(["dead-no-repo"]);
    expect(result.autoResumed).toEqual([]);
  });

  it("passes the row's repoContext through to attemptAutoResume so the policy can paired-write the YAML", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "dead-needs-yaml-stamp",
        hostPid: 999_999,
        sessionUuid: "session-u",
        jsonlPath: "/tmp/x.jsonl",
      }),
    ]);
    mockIsPidAlive.mockReturnValue(false);
    mockAttemptAutoResume.mockResolvedValue({
      resumed: true,
      childDispatchId: "child-yaml",
    });

    await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
      repo: fakeRepo,
    });

    // The reattach helper MUST hand the full repo to the policy — the
    // paired-write callback needs `repo.localPath` + `repo.issuePrefix`
    // to locate the In Progress YAML and stamp the new child's
    // dispatch{} block. Without this, the YAML keeps advertising the
    // dead parent's PID and the poller's `tryResumeOrphan` re-spawns
    // a duplicate on the next tick (the exact regression observed
    // 2026-05-10 21:13 BRT).
    const [, repoArg] = mockAttemptAutoResume.mock.calls[0];
    expect(repoArg).toBe(fakeRepo);
  });

  it("auto-resumes when attemptAutoResume returns resumed:true — orphaned stays empty, autoResumed gets the id", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({
        id: "dead-resumable",
        hostPid: 999_999,
        sessionUuid: "session-u",
        jsonlPath: "/tmp/x.jsonl",
      }),
    ]);
    mockIsPidAlive.mockReturnValue(false);
    mockAttemptAutoResume.mockResolvedValue({
      resumed: true,
      childDispatchId: "child-1",
    });

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
      repo: fakeRepo,
    });

    expect(mockAttemptAutoResume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dead-resumable" }),
      fakeRepo,
    );
    expect(result.autoResumed).toEqual(["dead-resumable"]);
    expect(result.orphaned).toEqual([]);
    // Caller (attemptAutoResume) owns the parent row's status write;
    // reattach must NOT also call markOrphaned on the same row.
    const markedFailedIds = mockUpdateDispatch.mock.calls
      .filter((call: unknown[]) => (call[1] as { status?: string }).status === "failed")
      .map((call: unknown[]) => call[0] as string);
    expect(markedFailedIds).not.toContain("dead-resumable");
  });

  it("falls back to orphan-mark when attemptAutoResume refuses (resumed:false)", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "dead-refused", hostPid: 999_999 }),
    ]);
    mockIsPidAlive.mockReturnValue(false);
    mockAttemptAutoResume.mockResolvedValue({
      resumed: false,
      refusalReason: "no-matching-yaml",
    });

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
      repo: fakeRepo,
    });

    expect(result.autoResumed).toEqual([]);
    expect(result.orphaned).toEqual(["dead-refused"]);
    expect(mockUpdateDispatch).toHaveBeenCalledWith(
      "dead-refused",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("falls back to orphan-mark when attemptAutoResume throws", async () => {
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "dead-throw", hostPid: 999_999 }),
    ]);
    mockIsPidAlive.mockReturnValue(false);
    mockAttemptAutoResume.mockRejectedValue(new Error("dispatch unavailable"));

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
      repo: fakeRepo,
    });

    expect(result.autoResumed).toEqual([]);
    expect(result.orphaned).toEqual(["dead-throw"]);
    expect(mockUpdateDispatch).toHaveBeenCalledWith(
      "dead-throw",
      expect.objectContaining({ status: "failed" }),
    );
  });
});
