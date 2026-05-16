import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";

// --- Mocks ---

const mockSpawnAgent = vi.fn();
const mockCancelJob = vi.fn();
const mockGetJobStatus = vi.fn();
// terminateWithGrace records the jobs it's asked to kill so tests can assert
// the stall-recovery contract (uses it instead of ChildProcess.kill).
const mockTerminateWithGrace = vi.fn().mockResolvedValue(undefined);

vi.mock("../agent/launcher.js", () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  cancelJob: (...args: unknown[]) => mockCancelJob(...args),
  getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  buildCompletionInstruction: () => " [completion-instruction]",
  terminateWithGrace: (...args: unknown[]) => mockTerminateWithGrace(...args),
}));

/**
 * Phase 2 of XCptaJ34 moved `buildMcpSettings` into `src/dispatch/core.ts`
 * (which writes a real settings.json via the resolver). Tests that used to
 * assert on `mockBuildMcpSettings.toHaveBeenCalledWith(...)` now read the
 * settings file written at `mcpConfigPath` — asserting the same env values
 * at the observable boundary (what claude sees) rather than the intermediate
 * call. `mockSettingsRead(spawnOpts)` centralizes the read for terse asserts.
 */
import { readFileSync } from "node:fs";
function mockSettingsRead(spawnOpts: Record<string, unknown> | undefined): {
  mcpServers: Record<string, { env: Record<string, string> }>;
} {
  const p = spawnOpts?.mcpConfigPath as string;
  return JSON.parse(readFileSync(p, "utf-8"));
}

// Use vi.hoisted so these mocks are available inside the vi.mock factories (which are hoisted)
const {
  mockTerminalWatcherStart,
  mockTerminalWatcherStop,
  mockTerminalOutputWatcherCtor,
  mockStallDetectorStart,
  mockStallDetectorStop,
  mockStallDetectorGetNudgeCount,
  mockStallDetectorCtor,
} = vi.hoisted(() => {
  const mockTerminalWatcherStart = vi.fn();
  const mockTerminalWatcherStop = vi.fn();
  const mockTerminalOutputWatcherCtor = vi.fn().mockImplementation(function () {
    return {
      start: mockTerminalWatcherStart,
      stop: mockTerminalWatcherStop,
    };
  });
  const mockStallDetectorStart = vi.fn();
  const mockStallDetectorStop = vi.fn();
  const mockStallDetectorGetNudgeCount = vi.fn().mockReturnValue(0);
  const mockStallDetectorCtor = vi.fn().mockImplementation(function () {
    return {
      start: mockStallDetectorStart,
      stop: mockStallDetectorStop,
      getNudgeCount: mockStallDetectorGetNudgeCount,
    };
  });
  return {
    mockTerminalWatcherStart,
    mockTerminalWatcherStop,
    mockTerminalOutputWatcherCtor,
    mockStallDetectorStart,
    mockStallDetectorStop,
    mockStallDetectorGetNudgeCount,
    mockStallDetectorCtor,
  };
});

vi.mock("../agent/terminal-output-watcher.js", () => ({
  TerminalOutputWatcher: function TerminalOutputWatcher(...args: unknown[]) {
    mockTerminalOutputWatcherCtor(...args);
    return { start: mockTerminalWatcherStart, stop: mockTerminalWatcherStop };
  },
}));

vi.mock("../agent/stall-detector.js", () => ({
  StallDetector: function StallDetector(...args: unknown[]) {
    mockStallDetectorCtor(...args);
    return {
      start: mockStallDetectorStart,
      stop: mockStallDetectorStop,
      getNudgeCount: mockStallDetectorGetNudgeCount,
    };
  },
  DEFAULT_MAX_NUDGES: 3,
}));

vi.mock("../poller/constants.js", () => ({
  getReposBase: () => "/test/repos",
}));

const mockFindSessionFileByDispatchId = vi.fn();
// Capture the cwd passed into deriveSessionDir so tests can verify that
// `resolveParentSessionId` derives the projects directory from the
// workspace path — not the bare repo root (the Phase 3 spawn-cwd switch;
// see the agent-isolation epic Trello `7ha2CSpc`). Without this spy, a
// regression that reverts the call to `repo.localPath` leaves every
// resume test green because the fake session dir resolves identically
// for both inputs.
const mockDeriveSessionDir = vi.fn(
  (cwd: string) => `/fake/projects${cwd.replace(/\//g, "-")}`,
);
vi.mock("../agent/session-log-watcher.js", () => ({
  deriveSessionDir: (cwd: string) => mockDeriveSessionDir(cwd),
  findSessionFileByDispatchId: (...args: unknown[]) =>
    mockFindSessionFileByDispatchId(...args),
}));

// Default: the fake session dir appears to exist as a directory so
// resolveParentSessionId proceeds to findSessionFileByDispatchId. Tests that
// want to exercise the "no-session-dir" → 500 branch override this per-test.
// Typed as accepting the path so TS doesn't complain about the forwarded arg.
const mockStat = vi.fn(async (_path: unknown) => ({ isDirectory: () => true }));
vi.mock("node:fs/promises", () => ({
  stat: (path: unknown) => mockStat(path),
}));

// Plural-workspace dispatch (workspace-dispatch cleanup): resolveParentSessionId
// enumerates `<repo>/.danxbot/workspaces/<name>/` to find the parent's
// session JSONL across every workspace cwd. Stub the sync fs helpers so
// the lookup finds at least one workspace ("system-test") that the test
// fixtures use as the parent dispatch's workspace.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (path: unknown) =>
      typeof path === "string" && path.includes("/.danxbot/workspaces"),
    readdirSync: (path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith("/.danxbot/workspaces")) return ["system-test"];
      return [];
    },
    statSync: () => ({ isDirectory: () => true }),
  };
});

const { mockDispatchConfig } = vi.hoisted(() => {
  const mockDispatchConfig = {
    isHost: false,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 3600000,
    },
    logsDir: "/test/logs",
  };
  return { mockDispatchConfig };
});

vi.mock("../config.js", () => ({ config: mockDispatchConfig }));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockIsFeatureEnabled = vi.fn().mockReturnValue(true);
vi.mock("../settings-file.js", async () => {
  const actual =
    await vi.importActual<typeof import("../settings-file.js")>(
      "../settings-file.js",
    );
  return {
    ...actual,
    isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
  };
});

const mockGetActiveJob = vi.fn();
const mockListActiveJobs = vi.fn(() => [] as unknown[]);
const mockDispatchFn = vi.fn();
vi.mock("../dispatch/core.js", async () => {
  const actual = await vi.importActual<typeof import("../dispatch/core.js")>(
    "../dispatch/core.js",
  );
  return {
    ...actual,
    dispatch: (...args: unknown[]) => mockDispatchFn(...args),
    getActiveJob: (id: string) => mockGetActiveJob(id),
    listActiveJobs: () => mockListActiveJobs(),
  };
});

// handleSlackReply / handleSlackUpdate (Phase 1) import getSlackClientForRepo
// from `../slack/listener.js`. That listener transitively imports the
// heartbeat manager → `@anthropic-ai/sdk`, which reads `config.anthropic.apiKey`
// at module load. This mock decouples the worker dispatch tests from the Slack
// listener entirely — the slack-endpoints.test.ts file is the dedicated home
// for those handlers.
vi.mock("../slack/listener.js", () => ({
  getSlackClientForRepo: vi.fn(),
}));
const mockGetDispatchById = vi.fn();
const mockUpdateDispatch = vi.fn().mockResolvedValue(undefined);
vi.mock("../dashboard/dispatches-db.js", () => ({
  getDispatchById: (...args: unknown[]) => mockGetDispatchById(...args),
  insertDispatch: vi.fn(),
  updateDispatch: (...args: unknown[]) => mockUpdateDispatch(...args),
}));

// Mock the critical-failure module so handleStop's writeFlag path doesn't
// touch the real filesystem. Tests assert on the mock args to verify the
// agent-signal payload shape.
const mockWriteFlag = vi
  .fn()
  .mockImplementation((_lp: string, payload: unknown) => ({
    timestamp: "2026-04-21T00:00:00.000Z",
    ...(payload as object),
  }));
vi.mock("../critical-failure.js", () => ({
  writeFlag: (...args: unknown[]) => mockWriteFlag(...args),
  readFlag: vi.fn().mockReturnValue(null),
  clearFlag: vi.fn().mockReturnValue(false),
  flagPath: (localPath: string) => `${localPath}/.danxbot/CRITICAL_FAILURE`,
}));

// Phase 3 of tracker-agnostic-agents (Trello wsb4TVNT): handleStop calls
// `autoSyncTrackedIssue(jobId, repo)` BEFORE `job.stop` for the
// completed/failed path so an agent that edited the local YAML and
// called `danxbot_complete` gets its YAML pushed to the tracker
// immediately (rather than waiting up to ~30-60s for the next poller
// tick to mirror it). Critical-failure short-circuits BEFORE this call.
// Mock records call order against `mockStop` so assertions pin the
// before-stop sequence.
const mockAutoSyncTrackedIssue = vi.fn().mockResolvedValue(undefined);
vi.mock("./auto-sync.js", () => ({
  autoSyncTrackedIssue: (...args: unknown[]) =>
    mockAutoSyncTrackedIssue(...args),
}));

// agent_blocked status (Phase A of dispatched-agent epic): handleStop
// stamps Blocked on the candidate YAML BEFORE finalizing the dispatch
// row. Mock the helper so we can assert call shape without touching the
// real filesystem.
const mockStampIssueBlocked = vi.fn();
vi.mock("../issue/stamp-blocked.js", () => ({
  stampIssueBlocked: (...args: unknown[]) => mockStampIssueBlocked(...args),
}));

// DX-559: handleStop runs the commits-shipped enforcement before the
// existing status branches. Mock it so tests can drive the violation /
// no-violation path without setting up a real git repo per case (that
// coverage lives in `enforce-commits-shipped.test.ts`).
const mockEnforceCommitsShipped = vi.fn().mockResolvedValue(null);
vi.mock("../issue/enforce-commits-shipped.js", () => ({
  enforceCommitsShipped: (...args: unknown[]) =>
    mockEnforceCommitsShipped(...args),
}));

// DX-365: handleStopFromDb fires `applyStrike` after each updateDispatch
// branch (critical_failure → mapped failed, agent_blocked → mapped failed,
// normal terminal). Mock the helper to assert call args without touching
// settings.json or the strike module's internal mutateAgents lock.
const mockApplyStrike = vi.fn().mockResolvedValue(undefined);
vi.mock("../dashboard/dispatch-tracker.js", async () => {
  const actual =
    await vi.importActual<typeof import("../dashboard/dispatch-tracker.js")>(
      "../dashboard/dispatch-tracker.js",
    );
  return {
    ...actual,
    applyStrike: (...args: unknown[]) => mockApplyStrike(...args),
  };
});

import {
  handleLaunch,
  handleResume,
  handleFleshOut,
  handleTriage,
  buildTriageTaskBody,
  handleChat,
  handleCancel,
  handleListJobs,
  handleStatus,
  handleStop,
  clearJobCleanupIntervals,
} from "./dispatch.js";

// `handleChat` reads + writes <repoRoot>/.danxbot/chat-sessions/<id>.json
// to decide fresh-vs-resume. Mock the storage helper so tests can drive
// every branch without touching disk.
const mockReadChatSession = vi.fn();
const mockWriteChatSession = vi.fn();
vi.mock("../issue/chat-sessions.js", () => ({
  readChatSession: (...args: unknown[]) => mockReadChatSession(...args),
  writeChatSession: (...args: unknown[]) => mockWriteChatSession(...args),
}));

const MOCK_REPO = makeRepoContext();

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFeatureEnabled.mockReturnValue(true);
  mockGetActiveJob.mockReset();
  mockListActiveJobs.mockReset().mockReturnValue([]);
  mockDispatchFn.mockReset();
  mockGetDispatchById.mockReset();
  mockUpdateDispatch.mockReset().mockResolvedValue(undefined);
  mockEnforceCommitsShipped.mockReset().mockResolvedValue(null);
  // Cross-test isolation: tests that exercise the stamp-throws path
  // attach a throwing mockImplementation that survives clearAllMocks (only
  // call history is cleared). Reset explicitly so the next test starts
  // with the default no-op implementation.
  mockStampIssueBlocked.mockReset();
});

describe("handleLaunch — dispatchApi feature toggle", () => {
  it("returns 503 with the documented body when dispatchApi is disabled", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "dispatchApi",
    );
    const req = createMockReqWithBody("POST", {
      workspace: "any",
      task: "Do work",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "dispatchApi",
    );
    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getBody())).toEqual({
      error: `Dispatch API is disabled for repo ${MOCK_REPO.name}`,
    });
    // No spawn occurred — the 503 short-circuits before any bookkeeping.
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

describe("handleStatus", () => {
  it("returns 404 for unknown job", () => {
    const res = createMockRes();

    handleStatus(res, "nonexistent-job");

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Job not found" });
  });

  it("returns job status for active job", () => {
    const mockJob = {
      id: "job-status-test",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockGetActiveJob.mockReturnValue(mockJob);
    mockGetJobStatus.mockReturnValue({
      id: "job-status-test",
      status: "running",
    });

    const res = createMockRes();
    handleStatus(res, "test-dispatch-id");

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      id: "job-status-test",
      status: "running",
    });
  });

  it("passes token usage fields from getJobStatus straight through to the HTTP body", () => {
    const mockJob = {
      id: "job-tokens",
      status: "completed",
      summary: "done",
      startedAt: new Date(),
    };
    mockGetActiveJob.mockReturnValue(mockJob);
    mockGetJobStatus.mockReturnValue({
      job_id: "job-tokens",
      status: "completed",
      summary: "done",
      started_at: "2026-04-17T00:00:00.000Z",
      completed_at: "2026-04-17T00:00:05.000Z",
      elapsed_seconds: 5,
      input_tokens: 300,
      output_tokens: 130,
      cache_read_input_tokens: 1024,
      cache_creation_input_tokens: 2048,
    });

    const res = createMockRes();
    handleStatus(res, "test-dispatch-id");

    const body = JSON.parse(res._getBody());
    expect(body).toMatchObject({
      input_tokens: 300,
      output_tokens: 130,
      cache_read_input_tokens: 1024,
      cache_creation_input_tokens: 2048,
    });
  });
});

describe("handleListJobs", () => {
  beforeEach(async () => {
    // Sibling describes in this file launch real dispatches that land in
    // the module-level `activeJobs` map. `vi.clearAllMocks()` only resets
    // mock call history, not module state, so we explicitly drain the map
    // before each list-jobs test to avoid asserting against unrelated
    // leftover entries.
    const core = await import("../dispatch/core.js");
    core._resetForTesting();
  });

  it("returns an empty array when no dispatches are tracked", () => {
    const res = createMockRes();
    handleListJobs(res);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ jobs: [] });
  });

  it("returns every active job in the activeJobs map", () => {
    const mockJobA = {
      id: "job-list-A",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    const mockJobB = {
      id: "job-list-B",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    let getCount = 0;
    mockGetJobStatus.mockImplementation(() => {
      getCount++;
      return getCount === 1
        ? { job_id: "dispatch-A", status: "running" }
        : { job_id: "dispatch-B", status: "running" };
    });
    mockListActiveJobs.mockReturnValue([mockJobA, mockJobB]);

    const res = createMockRes();
    handleListJobs(res);

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "running" }),
        expect.objectContaining({ status: "running" }),
      ]),
    );
  });
});

describe("handleCancel", () => {
  it("returns 404 for unknown job", async () => {
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleCancel(req, res, "nonexistent-job");

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Job not found" });
  });

  it("returns 409 for non-running job", async () => {
    const mockJob = {
      id: "job-completed",
      status: "completed",
      summary: "Done",
      startedAt: new Date(),
      completedAt: new Date(),
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const cancelReq = createMockReqWithBody("POST", { api_token: "tok-123" });
    const cancelRes = createMockRes();
    await handleCancel(cancelReq, cancelRes, "test-dispatch-id");

    expect(cancelRes._getStatusCode()).toBe(409);
  });

  it("returns 200 on successful cancel", async () => {
    const mockJob = {
      id: "job-to-cancel",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockGetActiveJob.mockReturnValue(mockJob);
    mockCancelJob.mockResolvedValue(undefined);

    const cancelReq = createMockReqWithBody("POST", {
      api_token: "tok-cancel",
    });
    const cancelRes = createMockRes();
    await handleCancel(cancelReq, cancelRes, "test-dispatch-id");

    expect(cancelRes._getStatusCode()).toBe(200);
    expect(JSON.parse(cancelRes._getBody())).toEqual({ status: "canceled" });
    expect(mockCancelJob).toHaveBeenCalledWith(mockJob, "tok-cancel");
  });
});

describe("handleStop", () => {
  it("returns 404 for unknown job", async () => {
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleStop(req, res, "nonexistent-job", MOCK_REPO);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Job not found" });
  });

  it("returns 409 for non-running job", async () => {
    const mockJob = {
      id: "job-stopped",
      status: "completed",
      summary: "Done",
      startedAt: new Date(),
      completedAt: new Date(),
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "test-dispatch-id", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(409);
  });

  it("returns 500 when job has no stop method", async () => {
    const mockJob = {
      id: "job-no-stop",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "test-dispatch-id", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(500);
    expect(JSON.parse(stopRes._getBody())).toEqual({
      error: "Job does not support agent-initiated stop",
    });
  });

  it("returns 200 and calls job.stop on success", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = {
      id: "job-stoppable",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", {
      status: "completed",
      summary: "All done",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "test-dispatch-id", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(200);
    expect(JSON.parse(stopRes._getBody())).toEqual({ status: "completed" });
    expect(mockStop).toHaveBeenCalledWith("completed", "All done");
  });

  it("returns 400 when status is explicitly null — same fail-loud path as undefined", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = {
      id: "job-null-status",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", { status: null });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "test-dispatch-id", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(400);
    expect(JSON.parse(stopRes._getBody()).error).toMatch(
      /Missing required field: status/,
    );
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("returns 400 when status is an empty string — explicit invalid-status path", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = {
      id: "job-empty-status",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", { status: "" });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "test-dispatch-id", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(400);
    expect(JSON.parse(stopRes._getBody()).error).toMatch(/Invalid status/);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("returns 400 when status is missing — fail-loud, no lenient default", async () => {
    // The MCP tool schema marks `status` as required, so a call without
    // it is a caller bug. Silent defaulting to "completed" (the old
    // behavior) could let stuck agents finalize jobs as successes.
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = {
      id: "job-no-status",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "test-dispatch-id", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(400);
    expect(JSON.parse(stopRes._getBody()).error).toMatch(
      /Missing required field: status/,
    );
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("passes failed status when specified", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = {
      id: "job-fail-stop",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", {
      status: "failed",
      summary: "Something went wrong",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "test-dispatch-id", MOCK_REPO);

    expect(mockStop).toHaveBeenCalledWith("failed", "Something went wrong");
  });

  it("Phase 3 AC #4: calls autoSyncTrackedIssue BEFORE job.stop for status=completed", async () => {
    mockAutoSyncTrackedIssue.mockClear();
    const callOrder: string[] = [];
    const mockStop = vi.fn().mockImplementation(async () => {
      callOrder.push("stop");
    });
    mockAutoSyncTrackedIssue.mockImplementation(async () => {
      callOrder.push("autoSync");
    });
    mockGetActiveJob.mockReturnValue({
      id: "job-1",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    });

    const stopReq = createMockReqWithBody("POST", {
      status: "completed",
      summary: "ok",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "job-1", MOCK_REPO);

    expect(mockAutoSyncTrackedIssue).toHaveBeenCalledTimes(1);
    expect(mockAutoSyncTrackedIssue).toHaveBeenCalledWith("job-1", MOCK_REPO);
    expect(callOrder).toEqual(["autoSync", "stop"]);
  });

  it("Phase 3 AC #4: calls autoSyncTrackedIssue for status=failed (same path as completed)", async () => {
    mockAutoSyncTrackedIssue.mockClear();
    mockAutoSyncTrackedIssue.mockResolvedValue(undefined);
    const mockStop = vi.fn().mockResolvedValue(undefined);
    mockGetActiveJob.mockReturnValue({
      id: "job-2",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    });
    const stopReq = createMockReqWithBody("POST", {
      status: "failed",
      summary: "broke",
    });
    await handleStop(stopReq, createMockRes(), "job-2", MOCK_REPO);
    expect(mockAutoSyncTrackedIssue).toHaveBeenCalledTimes(1);
    expect(mockAutoSyncTrackedIssue).toHaveBeenCalledWith("job-2", MOCK_REPO);
  });

  it("Phase 3 AC #4: SKIPS autoSyncTrackedIssue for status=critical_failure (env blocker, agent did no real work)", async () => {
    mockAutoSyncTrackedIssue.mockClear();
    mockAutoSyncTrackedIssue.mockResolvedValue(undefined);
    const mockStop = vi.fn().mockResolvedValue(undefined);
    mockGetActiveJob.mockReturnValue({
      id: "job-cf",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    });
    const stopReq = createMockReqWithBody("POST", {
      status: "critical_failure",
      summary: "MCP failed to load",
    });
    await handleStop(stopReq, createMockRes(), "job-cf", MOCK_REPO);
    expect(mockAutoSyncTrackedIssue).not.toHaveBeenCalled();
  });

  it("writes the critical-failure flag and finalizes as failed when status=critical_failure", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = {
      id: "job-critical",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", {
      status: "critical_failure",
      summary: "MCP server failed to load Trello tools",
    });
    const stopRes = createMockRes();
    const dispatchId = "test-dispatch-id";
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(200);
    expect(JSON.parse(stopRes._getBody())).toEqual({
      status: "critical_failure",
    });
    expect(mockWriteFlag).toHaveBeenCalledWith(MOCK_REPO.localPath, {
      source: "agent",
      dispatchId,
      reason: "Agent-signaled critical failure",
      detail: "MCP server failed to load Trello tools",
    });
    // AgentJob.stop only knows about completed/failed — the halt behavior
    // lives in the flag file, not the job status.
    expect(mockStop).toHaveBeenCalledWith(
      "failed",
      "MCP server failed to load Trello tools",
    );
  });

  it("agent_blocked: stamps Blocked on candidate YAML, then job.stop(failed, summary)", async () => {
    mockStampIssueBlocked.mockClear();
    mockAutoSyncTrackedIssue.mockClear();
    mockGetDispatchById.mockResolvedValue({
      id: "job-ab-1",
      status: "running",
      issueId: "DX-42",
    });
    const callOrder: string[] = [];
    const mockStop = vi.fn().mockImplementation(async () => {
      callOrder.push("stop");
    });
    mockStampIssueBlocked.mockImplementation(() => {
      callOrder.push("stamp");
    });
    mockAutoSyncTrackedIssue.mockImplementation(async () => {
      callOrder.push("autoSync");
    });
    mockGetActiveJob.mockReturnValue({
      id: "job-ab-1",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    });

    const stopReq = createMockReqWithBody("POST", {
      status: "agent_blocked",
      summary: "Rebase conflict in src/foo.ts:42 — cannot reconcile",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "job-ab-1", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(200);
    expect(JSON.parse(stopRes._getBody())).toEqual({ status: "agent_blocked" });
    expect(mockStampIssueBlocked).toHaveBeenCalledWith({
      repoLocalPath: MOCK_REPO.localPath,
      candidateId: "DX-42",
      expectedPrefix: MOCK_REPO.issuePrefix,
      reason: "Rebase conflict in src/foo.ts:42 — cannot reconcile",
      timestamp: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
      ),
    });
    // YAML stamp → autoSync (tracker push) → job.stop. Ordering is
    // load-bearing: the auto-sync must see the Blocked YAML so the
    // tracker reflects Blocked immediately after the agent self-blocks.
    expect(callOrder).toEqual(["stamp", "autoSync", "stop"]);
    expect(mockStop).toHaveBeenCalledWith(
      "failed",
      "Rebase conflict in src/foo.ts:42 — cannot reconcile",
    );
  });

  it("agent_blocked: returns 400 when the dispatch row has no issue_id", async () => {
    mockStampIssueBlocked.mockClear();
    mockGetDispatchById.mockResolvedValue({
      id: "job-ab-2",
      status: "running",
      issueId: null,
    });
    const mockStop = vi.fn().mockResolvedValue(undefined);
    mockGetActiveJob.mockReturnValue({
      id: "job-ab-2",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    });

    const stopReq = createMockReqWithBody("POST", {
      status: "agent_blocked",
      summary: "self-block w/o card",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "job-ab-2", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(400);
    expect(JSON.parse(stopRes._getBody()).error).toMatch(
      /requires the dispatch row to carry issue_id/,
    );
    expect(mockStampIssueBlocked).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("agent_blocked: returns 400 when summary is missing", async () => {
    mockStampIssueBlocked.mockClear();
    mockGetDispatchById.mockResolvedValue({
      id: "job-ab-3",
      status: "running",
      issueId: "DX-42",
    });
    const mockStop = vi.fn().mockResolvedValue(undefined);
    mockGetActiveJob.mockReturnValue({
      id: "job-ab-3",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    });

    const stopReq = createMockReqWithBody("POST", { status: "agent_blocked" });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "job-ab-3", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(400);
    expect(JSON.parse(stopRes._getBody()).error).toMatch(
      /Missing required field: summary/,
    );
    expect(mockStampIssueBlocked).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("returns 400 when status=critical_failure but summary is missing — operator needs actionable info", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = {
      id: "job-critical-no-summary",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", {
      status: "critical_failure",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "test-dispatch-id", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(400);
    expect(JSON.parse(stopRes._getBody()).error).toMatch(
      /Missing required field: summary/,
    );
    expect(mockWriteFlag).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  // ISS-68: DB fallback for /api/stop/:jobId after worker restart.
  // activeJobs is in-memory only; a worker restart clears it. Long-lived
  // claude processes (parent is `script -q -f`, not the worker daemon)
  // survive the restart and call `danxbot_complete` against a worker that
  // has no record of them. Without DB fallback, the agent gets 404 and
  // dies without finalizing the dispatch row or syncing the YAML.
  describe("ISS-68: DB fallback when activeJobs misses", () => {
    it("falls back to DB and finalizes a running dispatch as completed", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-dispatch",
        status: "running",
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "ok across restart",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-dispatch", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({ status: "completed" });
      expect(mockGetDispatchById).toHaveBeenCalledWith("ghost-dispatch");
      expect(mockAutoSyncTrackedIssue).toHaveBeenCalledWith("ghost-dispatch", MOCK_REPO);
      expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
      const [updateId, updates] = mockUpdateDispatch.mock.calls[0];
      expect(updateId).toBe("ghost-dispatch");
      expect(updates.status).toBe("completed");
      expect(updates.summary).toBe("ok across restart");
      expect(typeof updates.completedAt).toBe("number");
      // DX-140: every danxbot_complete-driven terminal stamp also closes
      // the host_pid lifecycle by setting pid_terminated_at to the same
      // timestamp as completedAt. Without it, an operator sees "PID was
      // bound at T" in the row but no end-of-life timestamp.
      expect(typeof updates.pidTerminatedAt).toBe("number");
      expect(updates.pidTerminatedAt).toBe(updates.completedAt);
    });

    it("falls back to DB and finalizes as failed when status=failed", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-fail",
        status: "running",
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "failed",
        summary: "boom",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-fail", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({ status: "failed" });
      expect(mockAutoSyncTrackedIssue).toHaveBeenCalledWith("ghost-fail", MOCK_REPO);
      expect(mockUpdateDispatch.mock.calls[0][1].status).toBe("failed");
      expect(mockUpdateDispatch.mock.calls[0][1].summary).toBe("boom");
    });

    it("critical_failure on DB-fallback writes flag, marks failed, and skips autoSync", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-crit",
        status: "running",
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "critical_failure",
        summary: "MCP failed to load",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-crit", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({
        status: "critical_failure",
      });
      expect(mockWriteFlag).toHaveBeenCalledWith(MOCK_REPO.localPath, {
        source: "agent",
        dispatchId: "ghost-crit",
        reason: "Agent-signaled critical failure",
        detail: "MCP failed to load",
      });
      expect(mockAutoSyncTrackedIssue).not.toHaveBeenCalled();
      expect(mockUpdateDispatch.mock.calls[0][1].status).toBe("failed");
      expect(mockUpdateDispatch.mock.calls[0][1].summary).toBe(
        "MCP failed to load",
      );
    });

    it("returns 404 when neither activeJobs nor DB has the row", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue(null);
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "no row",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "missing", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(404);
      expect(JSON.parse(stopRes._getBody())).toEqual({ error: "Job not found" });
      expect(mockUpdateDispatch).not.toHaveBeenCalled();
      expect(mockAutoSyncTrackedIssue).not.toHaveBeenCalled();
    });

    it("is idempotent on already-terminal rows — returns 200 with existing status, no double-update", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "already-done",
        status: "completed",
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "racy duplicate signal",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "already-done", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({ status: "completed" });
      expect(mockUpdateDispatch).not.toHaveBeenCalled();
      expect(mockAutoSyncTrackedIssue).not.toHaveBeenCalled();
      expect(mockWriteFlag).not.toHaveBeenCalled();
    });

    it("idempotent on already-failed rows preserves the original terminal reason", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "already-failed",
        status: "failed",
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "agent thinks it won",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "already-failed", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({ status: "failed" });
      expect(mockUpdateDispatch).not.toHaveBeenCalled();
    });

    it("idempotent on already-cancelled rows", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "already-cancelled",
        status: "cancelled",
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "late signal",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "already-cancelled", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({ status: "cancelled" });
      expect(mockUpdateDispatch).not.toHaveBeenCalled();
    });

    it("DB-fallback path validates body — invalid status returns 400, no DB update", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-bad",
        status: "running",
      });
      const stopReq = createMockReqWithBody("POST", { status: "bogus" });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-bad", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(400);
      expect(JSON.parse(stopRes._getBody()).error).toMatch(/Invalid status/);
      expect(mockUpdateDispatch).not.toHaveBeenCalled();
    });

    // DX-365: applyStrike fires after each updateDispatch branch in
    // handleStopFromDb. The strike call sites are:
    //   - critical_failure → mapped to `failed` (strike-eligible)
    //   - agent_blocked   → mapped to `failed` (strike-eligible)
    //   - normal terminal → status as supplied (strike-eligible iff
    //     failed/recovered/throttled; completed/cancelled skip via
    //     applyStrike's internal guard)
    // Tests assert applyStrike is invoked with the row's agent_name +
    // issueId + the mapped DispatchStatus + the repo localPath. The
    // helper's own skip-condition tree is covered by
    // dispatch-tracker.applystrike.test.ts; here we verify the worker
    // route hands it the right args.
    describe("DX-365: applyStrike call sites", () => {
      beforeEach(() => {
        mockApplyStrike.mockClear();
        mockApplyStrike.mockResolvedValue(undefined);
      });

      it("normal failed terminal → applyStrike fires with agent_name + issueId + mapped status", async () => {
        mockGetActiveJob.mockReturnValue(undefined);
        mockGetDispatchById.mockResolvedValue({
          id: "ghost-strike",
          status: "running",
          agentName: "alice",
          issueId: "DX-100",
        });
        const stopReq = createMockReqWithBody("POST", {
          status: "failed",
          summary: "boom",
        });
        await handleStop(
          stopReq,
          createMockRes(),
          "ghost-strike",
          MOCK_REPO,
        );
        expect(mockApplyStrike).toHaveBeenCalledTimes(1);
        const args = mockApplyStrike.mock.calls[0][0];
        expect(args).toMatchObject({
          status: "failed",
          repoLocalPath: MOCK_REPO.localPath,
          repoName: MOCK_REPO.name,
          agentName: "alice",
          dispatchId: "ghost-strike",
          issueId: "DX-100",
          rawError: "boom",
        });
        expect(typeof args.timestampIso).toBe("string");
      });

      it("normal completed terminal → applyStrike fires (helper skips internally on non-strike status)", async () => {
        mockGetActiveJob.mockReturnValue(undefined);
        mockGetDispatchById.mockResolvedValue({
          id: "ghost-ok",
          status: "running",
          agentName: "alice",
          issueId: "DX-100",
        });
        const stopReq = createMockReqWithBody("POST", {
          status: "completed",
          summary: "ok",
        });
        await handleStop(stopReq, createMockRes(), "ghost-ok", MOCK_REPO);
        // applyStrike is called regardless of status — the helper owns
        // the eligibility decision so the call sites stay uniform.
        // Internal skip is covered by the wrapper's own test file.
        expect(mockApplyStrike).toHaveBeenCalledTimes(1);
        expect(mockApplyStrike.mock.calls[0][0].status).toBe("completed");
      });

      it("critical_failure → applyStrike fires with mapped status `failed`", async () => {
        mockGetActiveJob.mockReturnValue(undefined);
        mockGetDispatchById.mockResolvedValue({
          id: "ghost-crit",
          status: "running",
          agentName: "alice",
          issueId: "DX-100",
        });
        const stopReq = createMockReqWithBody("POST", {
          status: "critical_failure",
          summary: "MCP gone",
        });
        await handleStop(stopReq, createMockRes(), "ghost-crit", MOCK_REPO);
        expect(mockApplyStrike).toHaveBeenCalledTimes(1);
        // critical_failure agent-side maps to `failed` row status — the
        // strike helper sees the mapped value, not the agent's original
        // signal, so the strike contract follows the row.
        expect(mockApplyStrike.mock.calls[0][0]).toMatchObject({
          status: "failed",
          dispatchId: "ghost-crit",
          rawError: "MCP gone",
        });
      });

      it("agent_blocked → applyStrike fires with mapped status `failed`", async () => {
        mockGetActiveJob.mockReturnValue(undefined);
        mockGetDispatchById.mockResolvedValue({
          id: "ghost-blocked",
          status: "running",
          agentName: "alice",
          issueId: "DX-100",
        });
        mockStampIssueBlocked.mockReturnValue(undefined);
        const stopReq = createMockReqWithBody("POST", {
          status: "agent_blocked",
          summary: "spec ambiguous",
        });
        await handleStop(
          stopReq,
          createMockRes(),
          "ghost-blocked",
          MOCK_REPO,
        );
        expect(mockApplyStrike).toHaveBeenCalledTimes(1);
        expect(mockApplyStrike.mock.calls[0][0]).toMatchObject({
          status: "failed",
          dispatchId: "ghost-blocked",
          issueId: "DX-100",
          rawError: "spec ambiguous",
        });
      });

      it("non-agent dispatch (agent_name=null on row) — applyStrike still called; helper short-circuits internally", async () => {
        mockGetActiveJob.mockReturnValue(undefined);
        mockGetDispatchById.mockResolvedValue({
          id: "ghost-noagent",
          status: "running",
          agentName: null,
          issueId: null,
        });
        const stopReq = createMockReqWithBody("POST", {
          status: "failed",
          summary: "boom",
        });
        await handleStop(
          stopReq,
          createMockRes(),
          "ghost-noagent",
          MOCK_REPO,
        );
        expect(mockApplyStrike).toHaveBeenCalledTimes(1);
        const args = mockApplyStrike.mock.calls[0][0];
        expect(args.agentName).toBeNull();
        expect(args.issueId).toBeNull();
      });

      it("idempotent already-terminal row → applyStrike NOT called (no double-strike on duplicate signal)", async () => {
        mockGetActiveJob.mockReturnValue(undefined);
        mockGetDispatchById.mockResolvedValue({
          id: "already-failed",
          status: "failed",
          agentName: "alice",
          issueId: "DX-100",
        });
        const stopReq = createMockReqWithBody("POST", {
          status: "failed",
          summary: "racy duplicate",
        });
        await handleStop(
          stopReq,
          createMockRes(),
          "already-failed",
          MOCK_REPO,
        );
        expect(mockApplyStrike).not.toHaveBeenCalled();
      });
    });

    it("queued (non-terminal, not running) row finalizes the same as running", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-queued",
        status: "queued",
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "queued→completed",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-queued", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({ status: "completed" });
      expect(mockUpdateDispatch.mock.calls[0][1].status).toBe("completed");
    });

    it("DB-fallback path returns 400 when status is missing — fail-loud, no lenient default", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-no-status",
        status: "running",
      });
      const stopReq = createMockReqWithBody("POST", {});
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-no-status", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(400);
      expect(JSON.parse(stopRes._getBody()).error).toMatch(
        /Missing required field: status/,
      );
      expect(mockUpdateDispatch).not.toHaveBeenCalled();
    });

    it("DB-fallback completed without summary still updates row (summary undefined) and 200s", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-no-summary",
        status: "running",
      });
      const stopReq = createMockReqWithBody("POST", { status: "completed" });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-no-summary", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(200);
      expect(mockUpdateDispatch).toHaveBeenCalledTimes(1);
      expect(mockUpdateDispatch.mock.calls[0][1].status).toBe("completed");
      expect(mockUpdateDispatch.mock.calls[0][1].summary).toBeUndefined();
    });

    it("DB-fallback returns 500 when updateDispatch rejects (outer try/catch covers it)", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-throw",
        status: "running",
      });
      mockUpdateDispatch.mockRejectedValueOnce(new Error("db down"));
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "ok",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-throw", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(500);
      expect(JSON.parse(stopRes._getBody()).error).toMatch(/db down/);
    });

    it("DX-559: DB-fallback runs enforcement on status=completed + issueId; null violation proceeds normally", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-559-clean",
        status: "running",
        issueId: "DX-700",
      });
      mockEnforceCommitsShipped.mockResolvedValue(null);
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "clean across restart",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-559-clean", MOCK_REPO);

      expect(mockEnforceCommitsShipped).toHaveBeenCalledWith({
        repoLocalPath: MOCK_REPO.localPath,
        candidateId: "DX-700",
        expectedPrefix: MOCK_REPO.issuePrefix,
      });
      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({ status: "completed" });
      expect(mockUpdateDispatch.mock.calls[0][1].status).toBe("completed");
    });

    it("DX-559: DB-fallback overrides status=completed → agent_blocked when commits are not on origin/main", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-559-violation",
        status: "running",
        issueId: "DX-800",
      });
      mockEnforceCommitsShipped.mockResolvedValue({
        missingShas: ["abc123"],
        unresolvedShas: [],
        reason:
          "DX-559 enforcement: commits in retro.commits[] are not on origin/main. Missing shas: abc123.",
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "lying about success",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-559-violation", MOCK_REPO);

      // Response surfaces the override so the agent learns.
      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({
        status: "agent_blocked",
      });
      // YAML stamped Blocked with the violation reason, NOT the agent's
      // misleading summary.
      expect(mockStampIssueBlocked).toHaveBeenCalledWith({
        repoLocalPath: MOCK_REPO.localPath,
        candidateId: "DX-800",
        expectedPrefix: MOCK_REPO.issuePrefix,
        reason: expect.stringContaining("DX-559 enforcement"),
        timestamp: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
        ),
      });
      // Dispatch row terminates as failed (agent_blocked collapses to
      // failed via mapCompleteToDispatchStatus).
      expect(mockUpdateDispatch.mock.calls[0][1].status).toBe("failed");
      expect(mockUpdateDispatch.mock.calls[0][1].summary).toContain(
        "DX-559 enforcement",
      );
    });

    it("DX-559: DB-fallback skips enforcement when the dispatch row has no issueId", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-559-no-issue",
        status: "running",
        issueId: null,
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "slack reply",
      });

      await handleStop(
        stopReq,
        createMockRes(),
        "ghost-559-no-issue",
        MOCK_REPO,
      );

      expect(mockEnforceCommitsShipped).not.toHaveBeenCalled();
      expect(mockUpdateDispatch.mock.calls[0][1].status).toBe("completed");
    });

    it("DB-fallback critical_failure without summary returns 400 and does not write the flag", async () => {
      mockGetActiveJob.mockReturnValue(undefined);
      mockGetDispatchById.mockResolvedValue({
        id: "ghost-nosummary",
        status: "running",
      });
      const stopReq = createMockReqWithBody("POST", {
        status: "critical_failure",
      });
      const stopRes = createMockRes();

      await handleStop(stopReq, stopRes, "ghost-nosummary", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(400);
      expect(JSON.parse(stopRes._getBody()).error).toMatch(
        /Missing required field: summary/,
      );
      expect(mockWriteFlag).not.toHaveBeenCalled();
      expect(mockUpdateDispatch).not.toHaveBeenCalled();
    });
  });

  it("returns 400 when the status field is present but not one of the three valid values", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    const mockJob = {
      id: "job-bad-status",
      status: "running",
      summary: "",
      startedAt: new Date(),
      stop: mockStop,
    };
    mockGetActiveJob.mockReturnValue(mockJob);

    const stopReq = createMockReqWithBody("POST", {
      status: "bogus",
      summary: "whatever",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, "test-dispatch-id", MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(400);
    expect(JSON.parse(stopRes._getBody()).error).toMatch(/Invalid status/);
    expect(mockStop).not.toHaveBeenCalled();
    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  describe("DX-559: commits-shipped enforcement on status=completed", () => {
    function makeRunningJob(id: string, mockStop: ReturnType<typeof vi.fn>) {
      return {
        id,
        status: "running",
        summary: "",
        startedAt: new Date(),
        stop: mockStop,
      };
    }

    it("skips enforcement when status=completed but the dispatch row has no issueId (Slack / ideator / api/launch)", async () => {
      mockGetDispatchById.mockResolvedValue({
        id: "job-559-no-issue",
        status: "running",
        issueId: null,
      });
      const mockStop = vi.fn().mockResolvedValue(undefined);
      mockGetActiveJob.mockReturnValue(
        makeRunningJob("job-559-no-issue", mockStop),
      );

      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "no card",
      });
      const stopRes = createMockRes();
      await handleStop(stopReq, stopRes, "job-559-no-issue", MOCK_REPO);

      expect(mockEnforceCommitsShipped).not.toHaveBeenCalled();
      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({ status: "completed" });
      expect(mockStop).toHaveBeenCalledWith("completed", "no card");
    });

    it("runs enforcement for status=completed + issueId, then proceeds normally when no violation", async () => {
      mockGetDispatchById.mockResolvedValue({
        id: "job-559-clean",
        status: "running",
        issueId: "DX-100",
      });
      mockEnforceCommitsShipped.mockResolvedValue(null);
      const mockStop = vi.fn().mockResolvedValue(undefined);
      mockGetActiveJob.mockReturnValue(
        makeRunningJob("job-559-clean", mockStop),
      );

      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "all green",
      });
      const stopRes = createMockRes();
      await handleStop(stopReq, stopRes, "job-559-clean", MOCK_REPO);

      expect(mockEnforceCommitsShipped).toHaveBeenCalledWith({
        repoLocalPath: MOCK_REPO.localPath,
        candidateId: "DX-100",
        expectedPrefix: MOCK_REPO.issuePrefix,
      });
      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({ status: "completed" });
      expect(mockStop).toHaveBeenCalledWith("completed", "all green");
      expect(mockStampIssueBlocked).not.toHaveBeenCalled();
    });

    it("overrides status=completed → agent_blocked when retro.commits[] is not on origin/main", async () => {
      mockGetDispatchById.mockResolvedValue({
        id: "job-559-violation",
        status: "running",
        issueId: "DX-200",
      });
      mockEnforceCommitsShipped.mockResolvedValue({
        missingShas: ["abc123"],
        unresolvedShas: [],
        reason:
          "DX-559 enforcement: commits in retro.commits[] are not on origin/main. Missing shas: abc123.",
      });
      const mockStop = vi.fn().mockResolvedValue(undefined);
      mockGetActiveJob.mockReturnValue(
        makeRunningJob("job-559-violation", mockStop),
      );

      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "all good (lying)",
      });
      const stopRes = createMockRes();
      await handleStop(stopReq, stopRes, "job-559-violation", MOCK_REPO);

      // Response reflects the override so the agent learns its completion
      // was rejected.
      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({
        status: "agent_blocked",
      });
      // Candidate YAML gets stamped with the missing-shas reason — the
      // agent's misleading `summary` is dropped.
      expect(mockStampIssueBlocked).toHaveBeenCalledWith({
        repoLocalPath: MOCK_REPO.localPath,
        candidateId: "DX-200",
        expectedPrefix: MOCK_REPO.issuePrefix,
        reason: expect.stringContaining("DX-559 enforcement"),
        timestamp: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
        ),
      });
      // Dispatch row terminates as `failed` (the agent_blocked branch's
      // documented mapping). The mocked `stamp-blocked` does not throw,
      // so the agent_blocked branch reaches job.stop("failed", reason).
      expect(mockStop).toHaveBeenCalledWith(
        "failed",
        expect.stringContaining("DX-559 enforcement"),
      );
      // autoSync still fires (push Blocked to tracker) — same ordering as
      // the regular agent_blocked path.
      expect(mockAutoSyncTrackedIssue).toHaveBeenCalledWith("job-559-violation", MOCK_REPO);
    });

    it("does NOT run enforcement for status=failed (agent already failed; check is for completed-only)", async () => {
      mockGetDispatchById.mockResolvedValue({
        id: "job-559-failed",
        status: "running",
        issueId: "DX-300",
      });
      const mockStop = vi.fn().mockResolvedValue(undefined);
      mockGetActiveJob.mockReturnValue(
        makeRunningJob("job-559-failed", mockStop),
      );

      const stopReq = createMockReqWithBody("POST", {
        status: "failed",
        summary: "tests broke",
      });
      await handleStop(stopReq, createMockRes(), "job-559-failed", MOCK_REPO);

      expect(mockEnforceCommitsShipped).not.toHaveBeenCalled();
    });

    it("does NOT run enforcement for status=critical_failure (env blocker; check is for completed-only)", async () => {
      mockGetDispatchById.mockResolvedValue({
        id: "job-559-cf",
        status: "running",
        issueId: "DX-400",
      });
      const mockStop = vi.fn().mockResolvedValue(undefined);
      mockGetActiveJob.mockReturnValue(makeRunningJob("job-559-cf", mockStop));

      const stopReq = createMockReqWithBody("POST", {
        status: "critical_failure",
        summary: "MCP failed",
      });
      await handleStop(stopReq, createMockRes(), "job-559-cf", MOCK_REPO);

      expect(mockEnforceCommitsShipped).not.toHaveBeenCalled();
    });

    it("DX-559 override survives stampIssueBlocked throwing — same 500 path as the regular agent_blocked branch", async () => {
      mockGetDispatchById.mockResolvedValue({
        id: "job-559-stamp-throws",
        status: "running",
        issueId: "DX-600",
      });
      mockEnforceCommitsShipped.mockResolvedValue({
        missingShas: ["abc123"],
        unresolvedShas: [],
        reason: "DX-559 enforcement: missing abc123",
      });
      mockStampIssueBlocked.mockImplementation(() => {
        throw new Error("filesystem read-only");
      });
      const mockStop = vi.fn().mockResolvedValue(undefined);
      mockGetActiveJob.mockReturnValue(
        makeRunningJob("job-559-stamp-throws", mockStop),
      );

      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
        summary: "ignored",
      });
      const stopRes = createMockRes();
      await handleStop(stopReq, stopRes, "job-559-stamp-throws", MOCK_REPO);

      // Falls into the in-memory agent_blocked branch which lets the throw
      // bubble to the outer try/catch — 500 with the underlying error.
      expect(stopRes._getStatusCode()).toBe(500);
      expect(JSON.parse(stopRes._getBody()).error).toMatch(
        /filesystem read-only/,
      );
      expect(mockStop).not.toHaveBeenCalled();
    });

    it("DX-559 override never produces an empty summary (violation.reason is the source of truth)", async () => {
      mockGetDispatchById.mockResolvedValue({
        id: "job-559-no-summary",
        status: "running",
        issueId: "DX-650",
      });
      // Reason is non-empty per the contract — assert call-site shape.
      mockEnforceCommitsShipped.mockResolvedValue({
        missingShas: ["abc123"],
        unresolvedShas: [],
        reason:
          "DX-559 enforcement: commits not on origin/main. Missing shas: abc123.",
      });
      const mockStop = vi.fn().mockResolvedValue(undefined);
      mockGetActiveJob.mockReturnValue(
        makeRunningJob("job-559-no-summary", mockStop),
      );

      // Agent sent NO summary on the original `completed` signal — the
      // override fills it from violation.reason instead of inheriting the
      // empty value, so the agent_blocked branch's "missing summary" 400
      // gate cannot trigger via this path.
      const stopReq = createMockReqWithBody("POST", {
        status: "completed",
      });
      const stopRes = createMockRes();
      await handleStop(stopReq, stopRes, "job-559-no-summary", MOCK_REPO);

      expect(stopRes._getStatusCode()).toBe(200);
      expect(JSON.parse(stopRes._getBody())).toEqual({
        status: "agent_blocked",
      });
      expect(mockStampIssueBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.stringContaining("DX-559 enforcement"),
        }),
      );
      expect(mockStop).toHaveBeenCalledWith(
        "failed",
        expect.stringContaining("DX-559 enforcement"),
      );
    });

    it("does NOT run enforcement for status=agent_blocked (agent already self-blocked)", async () => {
      mockGetDispatchById.mockResolvedValue({
        id: "job-559-ab",
        status: "running",
        issueId: "DX-500",
      });
      const mockStop = vi.fn().mockResolvedValue(undefined);
      mockGetActiveJob.mockReturnValue(makeRunningJob("job-559-ab", mockStop));

      const stopReq = createMockReqWithBody("POST", {
        status: "agent_blocked",
        summary: "ambiguous spec",
      });
      await handleStop(stopReq, createMockRes(), "job-559-ab", MOCK_REPO);

      expect(mockEnforceCommitsShipped).not.toHaveBeenCalled();
      // Existing agent_blocked path still fires.
      expect(mockStampIssueBlocked).toHaveBeenCalled();
    });
  });
});

describe("clearJobCleanupIntervals", () => {
  it("is safe to call when no intervals are tracked", () => {
    expect(() => clearJobCleanupIntervals()).not.toThrow();
  });
});

/**
 * P5 cutover (workspace-dispatch epic, card mGrHNHWM).
 *
 * The new contract: `/api/launch` and `/api/resume` accept ONLY
 * `{repo, workspace, task, overlay?, ...}`. Legacy body fields
 * (`schema_*`, `allow_tools`, `agents`, `api_url`) are rejected at the
 * boundary with `400 { error: "Legacy dispatch body shape rejected",
 * offendingFields: [...] }`. Missing `workspace` returns a separate
 * `400 { error: "Missing workspace" }`. There is no adapter, no
 * deprecation header, no fallback — see the operator directives on the
 * P5 card.
 *
 * These tests exercise the rejection branches at the handler boundary;
 * they don't reach `dispatch()` and don't need a workspace fixture on
 * disk. The new-shape happy path is covered in `core.test.ts` (the
 * collapsed `dispatch()` integration tests).
 */
describe("handleLaunch — P5 cutover (workspace required, legacy fields rejected)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it.each([
    ["schema_definition_id", { schema_definition_id: "abc" }],
    ["schema_role", { schema_role: "reviewer" }],
    ["api_url", { api_url: "https://example.com/api" }],
    ["allow_tools", { allow_tools: ["Read"] }],
    ["agents", { agents: { foo: { description: "x" } } }],
  ])(
    "returns 400 with offendingFields=[%s] when body carries that legacy field",
    async (fieldName, legacyField) => {
      const req = createMockReqWithBody("POST", {
        repo: MOCK_REPO.name,
        workspace: "issue-worker",
        task: "Do something",
        ...legacyField,
      });
      const res = createMockRes();

      await handleLaunch(req, res, MOCK_REPO);

      expect(res._getStatusCode()).toBe(400);
      const body = JSON.parse(res._getBody());
      expect(body.error).toBe("Legacy dispatch body shape rejected");
      expect(body.offendingFields).toEqual([fieldName]);
      expect(typeof body.message).toBe("string");
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    },
  );

  it("returns 400 listing every offending field when multiple legacy fields are present", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do something",
      schema_definition_id: "abc",
      allow_tools: ["Read"],
      agents: { foo: { description: "x" } },
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    const body = JSON.parse(res._getBody());
    expect(body.error).toBe("Legacy dispatch body shape rejected");
    // Order is the canonical detection order on the handler — schema first,
    // then allow_tools, then agents. Lock the order so the surface is
    // deterministic for callers grepping the response.
    expect(body.offendingFields).toEqual([
      "schema_definition_id",
      "allow_tools",
      "agents",
    ]);
  });

  it("returns 400 'Missing workspace' when body has no legacy fields and no workspace", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      task: "Do something",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing workspace",
    });
  });

  it("returns 400 'Missing workspace' when workspace is a whitespace-only string", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "   ",
      task: "Do something",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing workspace",
    });
  });

  it("returns 400 'Missing workspace' when workspace is not a string", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: 42,
      task: "Do something",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing workspace",
    });
  });

  it("returns 400 when staged_files is not an array", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do something",
      staged_files: { path: "/tmp/x", content: "y" },
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /staged_files must be an array/,
    );
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when staged_files entry is missing path", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do something",
      staged_files: [{ content: "y" }],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/staged_files\[0\]\.path/);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when staged_files entry has non-string content", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do something",
      staged_files: [{ path: "/tmp/x", content: 42 }],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /staged_files\[0\]\.content/,
    );
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("legacy-field rejection precedes missing-workspace check (legacy body without workspace produces the legacy error, not Missing workspace)", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      task: "Do something",
      allow_tools: ["Read"],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    const body = JSON.parse(res._getBody());
    expect(body.error).toBe("Legacy dispatch body shape rejected");
    expect(body.offendingFields).toEqual(["allow_tools"]);
  });
});

describe("handleResume — P5 cutover (workspace required, legacy fields rejected)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it.each([
    ["schema_definition_id", { schema_definition_id: "abc" }],
    ["schema_role", { schema_role: "reviewer" }],
    ["api_url", { api_url: "https://example.com/api" }],
    ["allow_tools", { allow_tools: ["Read"] }],
    ["agents", { agents: { foo: { description: "x" } } }],
  ])(
    "returns 400 with offendingFields=[%s] when body carries that legacy field on resume",
    async (fieldName, legacyField) => {
      const req = createMockReqWithBody("POST", {
        repo: MOCK_REPO.name,
        workspace: "issue-worker",
        job_id: "parent-123",
        task: "Continue",
        ...legacyField,
      });
      const res = createMockRes();

      await handleResume(req, res, MOCK_REPO);

      expect(res._getStatusCode()).toBe(400);
      const body = JSON.parse(res._getBody());
      expect(body.error).toBe("Legacy dispatch body shape rejected");
      expect(body.offendingFields).toEqual([fieldName]);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    },
  );

  it("returns 400 'Missing workspace' on resume when workspace is absent", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      job_id: "parent-123",
      task: "Continue",
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing workspace",
    });
  });
});

/**
 * Caller apps (gpt-manager) dispatch from the host's perspective and send
 * `http://localhost:<port>` URLs in `body.overlay` (e.g. `SCHEMA_API_URL`).
 * In docker runtime those resolve to the worker container itself, so every
 * tool call from the dispatched agent that hits the overlay URL fails with
 * `fetch failed`. Empirical reproducer: gpt-manager AgentDispatch row
 * AGD-29 — every `mcp__schema__*` tool result was
 * `{"content":"fetch failed","is_error":true}`.
 *
 * `body.status_url` was already rewritten via `normalizeCallbackUrl(...,
 * config.isHost)` in `parseSharedRequestFields`. Overlay values were
 * forwarded verbatim, which is the bug. The fix runs every overlay value
 * through the SAME helper after `validateOverlayBody` accepts it. The
 * helper is a no-op for non-localhost URLs and for non-URL strings (tokens,
 * numeric IDs), so it is safe to apply uniformly.
 */
describe("handleLaunch — overlay localhost normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    mockDispatchFn.mockResolvedValue({ dispatchId: "test-dispatch-1" });
  });

  it("rewrites localhost overlay URLs to host.docker.internal in docker runtime (isHost=false)", async () => {
    mockDispatchConfig.isHost = false;

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do something",
      overlay: {
        SCHEMA_API_URL: "http://localhost:80",
        SCHEMA_API_TOKEN: "secret-token-1234",
        SCHEMA_DEFINITION_ID: "25",
      },
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(mockDispatchFn).toHaveBeenCalledTimes(1);
    const dispatchInput = mockDispatchFn.mock.calls[0][0] as {
      overlay: Record<string, string>;
    };
    // Loopback URL rewritten to the docker-host alias.
    expect(dispatchInput.overlay.SCHEMA_API_URL).toBe(
      "http://host.docker.internal",
    );
    // Non-URL strings (tokens, numeric IDs) pass through untouched — the
    // normalizer must not throw or mutate them.
    expect(dispatchInput.overlay.SCHEMA_API_TOKEN).toBe("secret-token-1234");
    expect(dispatchInput.overlay.SCHEMA_DEFINITION_ID).toBe("25");
  });

  it("rewrites 127.0.0.1 in overlay values (parity with status_url normalization)", async () => {
    mockDispatchConfig.isHost = false;

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do something",
      overlay: {
        SCHEMA_API_URL: "http://127.0.0.1:8080/api",
      },
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const dispatchInput = mockDispatchFn.mock.calls[0][0] as {
      overlay: Record<string, string>;
    };
    expect(dispatchInput.overlay.SCHEMA_API_URL).toBe(
      "http://host.docker.internal:8080/api",
    );
  });

  it("preserves localhost overlay URLs in host runtime (isHost=true) so the host can reach its own services", async () => {
    mockDispatchConfig.isHost = true;
    try {
      const req = createMockReqWithBody("POST", {
        repo: MOCK_REPO.name,
        workspace: "issue-worker",
        task: "Do something",
        overlay: {
          SCHEMA_API_URL: "http://localhost:80",
        },
      });
      const res = createMockRes();

      await handleLaunch(req, res, MOCK_REPO);

      expect(res._getStatusCode()).toBe(200);
      const dispatchInput = mockDispatchFn.mock.calls[0][0] as {
        overlay: Record<string, string>;
      };
      expect(dispatchInput.overlay.SCHEMA_API_URL).toBe("http://localhost:80");
    } finally {
      // Restore the shared module-level config flag so subsequent describes
      // (which assume isHost=false) keep working.
      mockDispatchConfig.isHost = false;
    }
  });

  it("leaves non-loopback overlay URLs untouched in docker runtime", async () => {
    mockDispatchConfig.isHost = false;

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do something",
      overlay: {
        SCHEMA_API_URL: "https://gpt-manager-laravel.test-1:80/api",
      },
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const dispatchInput = mockDispatchFn.mock.calls[0][0] as {
      overlay: Record<string, string>;
    };
    expect(dispatchInput.overlay.SCHEMA_API_URL).toBe(
      "https://gpt-manager-laravel.test-1:80/api",
    );
  });
});

/**
 * `apiDispatchMeta` is the dispatch-row trigger payload — built inside
 * handleLaunch / handleResume from the parsed body and passed verbatim to
 * `dispatch()` via `buildDispatchInput`. The dispatch row's `trigger` and
 * `triggerMetadata` columns are populated from this struct, so the contract
 * is what the dashboard, the Laravel forwarder, and the resume protocol all
 * read back. Without unit coverage at this boundary, a refactor that drops
 * `endpoint` or `initialPrompt` would only surface as a missing column in a
 * production dispatch row — silent until someone clicks the dispatch in the
 * dashboard.
 */

// Shared shape narrowing. The handlers pass the body verbatim to
// `dispatch()` (mocked here as `mockDispatchFn`); each test reads the
// captured arg through this type so the inline `as { ... }` casts don't
// rot when fields are added or removed from `DispatchInput`.
type CapturedDispatchInput = {
  apiDispatchMeta: {
    trigger: "api";
    metadata: {
      endpoint: string;
      callerIp: string | null;
      statusUrl: string | null;
      initialPrompt: string;
    };
  };
  parentJobId?: string;
  resumeSessionId?: string;
  recoverCount?: number;
  parentRecoverId?: string | null;
};

function capturedInput(callIdx = 0): CapturedDispatchInput {
  return mockDispatchFn.mock.calls[callIdx][0] as CapturedDispatchInput;
}

describe("handleLaunch — apiDispatchMeta build", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    mockDispatchFn.mockResolvedValue({ dispatchId: "test-dispatch-1" });
  });

  it("builds the FULL apiDispatchMeta.metadata object on /api/launch — every key (endpoint, initialPrompt, statusUrl, callerIp) is recorded", async () => {
    // `toEqual` on the whole metadata block (not `toMatchObject`) means a
    // future refactor that drops a key on the new dispatch row gets caught
    // right here rather than at the dashboard render step.
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Investigate the deploy failure",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(mockDispatchFn).toHaveBeenCalledTimes(1);
    const meta = capturedInput().apiDispatchMeta;
    expect(meta.trigger).toBe("api");
    expect(meta.metadata).toEqual({
      endpoint: "/api/launch",
      initialPrompt: "Investigate the deploy failure",
      // No status_url in body → null. No socket / X-Forwarded-For on the
      // mock req → null.
      statusUrl: null,
      callerIp: null,
      // DX-84 — the workspace name is recorded so the chat list can
      // filter board-chat dispatches via `triggerMetadata->>'workspace'`.
      workspace: "issue-worker",
    });
  });

  it("propagates the normalized status_url into apiDispatchMeta.metadata.statusUrl (not the raw body value)", async () => {
    // Loopback rewrite happens in `parseSharedRequestFields` and the
    // resulting URL must be the one persisted on the dispatch row — a row
    // that records the raw `localhost` URL would mislead anyone reading the
    // audit trail.
    mockDispatchConfig.isHost = false;
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do work",
      status_url: "http://localhost:8080/agent/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(capturedInput().apiDispatchMeta.metadata.statusUrl).toBe(
      "http://host.docker.internal:8080/agent/status",
    );
  });

  it("records initialPrompt as the raw `task` body field — NOT the spawn prompt with the completion instruction appended", async () => {
    // The completion instruction is appended inside `dispatch()` via
    // `buildCompletionInstruction()`. The dispatch row should record what
    // the caller asked for, not the runtime augmentation, so audit logs +
    // the resume protocol's "what did the human originally request" view
    // stay clean. A refactor that builds the meta from
    // `taskWithInstruction` would silently pollute every dispatch row
    // with the boilerplate suffix.
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Investigate the deploy failure",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const meta = capturedInput().apiDispatchMeta;
    expect(meta.metadata.initialPrompt).toBe("Investigate the deploy failure");
    expect(meta.metadata.initialPrompt).not.toMatch(/completion-instruction/);
    expect(meta.metadata.initialPrompt).not.toMatch(/danxbot_complete/);
  });
});

describe("handleResume — apiDispatchMeta build", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    mockDispatchFn.mockResolvedValue({ dispatchId: "test-resume-1" });
    // Parent-session lookup must succeed so the dispatch path is reached.
    mockFindSessionFileByDispatchId.mockResolvedValueOnce(
      "/fake/projects/parent.jsonl",
    );
  });

  it("builds apiDispatchMeta with endpoint=/api/resume so the dispatch row distinguishes resumes from launches", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      job_id: "parent-job-abc",
      task: "Continue from prior turn",
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(mockDispatchFn).toHaveBeenCalledTimes(1);
    const input = capturedInput();
    expect(input.apiDispatchMeta.trigger).toBe("api");
    expect(input.apiDispatchMeta.metadata.endpoint).toBe("/api/resume");
    expect(input.apiDispatchMeta.metadata.initialPrompt).toBe(
      "Continue from prior turn",
    );
    // Resume-specific extras flow alongside the meta — without them the
    // dispatch is indistinguishable from a fresh launch downstream.
    expect(input.parentJobId).toBe("parent-job-abc");
    expect(input.resumeSessionId).toBe("parent");
  });

  // DX-260 (Phase 2 of DX-246) — the API-error recover handler POSTs
  // /api/resume with `recover_count` and `parent_recover_id` on top of
  // the regular resume body. The worker MUST thread those into
  // DispatchInput so the new dispatch row inherits the chain's count
  // and references its parent — silent loss of either field breaks the
  // cap check across rows AND the dashboard's recover-chain view.
  it("threads recover_count + parent_recover_id from the body into the DispatchInput (recover-spawned resume)", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      job_id: "parent-job-abc",
      task: "Continue from prior turn",
      recover_count: 2,
      parent_recover_id: "prior-dispatch-id",
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const input = capturedInput();
    expect(input.recoverCount).toBe(2);
    expect(input.parentRecoverId).toBe("prior-dispatch-id");
  });

  it("defaults recoverCount=undefined + parentRecoverId=null when the resume body omits them (operator-initiated, non-recover resume)", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      job_id: "parent-job-abc",
      task: "Continue from prior turn",
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const input = capturedInput();
    // Missing → undefined so dispatch-tracker falls back to the row's
    // default (0 / null) at insert. Forwarding `0` here would silently
    // shadow that fallback for any future caller that relies on it.
    expect(input.recoverCount).toBeUndefined();
    expect(input.parentRecoverId).toBeNull();
  });

  it("ignores recover_count when body sends a non-number (e.g. the field arrives as a string '2')", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      job_id: "parent-job-abc",
      task: "Continue from prior turn",
      recover_count: "2",
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    // Coercion is deliberately off — the recover handler MUST send a
    // real integer; accepting strings here would mask a producer bug
    // and let `NaN` reach the row's `recover_count` column. Defaults
    // to undefined.
    expect(res._getStatusCode()).toBe(200);
    expect(capturedInput().recoverCount).toBeUndefined();
  });
});

/**
 * `parseSharedRequestFields` derives `callerIp` from a 2-step fallback:
 * `req.socket.remoteAddress` first, then `req.headers["x-forwarded-for"]`,
 * then `null`. Each rung is a different production scenario:
 *   - direct connection from a worker on `danxbot-net` → `socket.remoteAddress`
 *   - dashboard proxy forwarded request → `X-Forwarded-For`
 *   - synthetic / test request without either → `null`
 * The fallback chain is what populates `apiDispatchMeta.metadata.callerIp`,
 * which the dashboard renders in the dispatch detail header. A refactor that
 * collapses to one source would break the production scenario that doesn't
 * use it.
 */
describe("handleLaunch — callerIp extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    mockDispatchFn.mockResolvedValue({ dispatchId: "test-callerip" });
  });

  it("uses req.socket.remoteAddress when present", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do work",
    });
    // The default mock has socket=null. Setting a real-ish socket
    // exercises the first rung of the fallback. Cast via `unknown` because
    // IncomingMessage.socket is typed as the real `Socket` and we only
    // need the one field the parser reads.
    (req as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress: "10.0.0.42",
    };
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(capturedInput().apiDispatchMeta.metadata.callerIp).toBe("10.0.0.42");
  });

  it("falls back to X-Forwarded-For when req.socket.remoteAddress is missing", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do work",
    });
    // socket present, remoteAddress undefined — exercises ?. on the
    // first rung specifically (not the absence of socket entirely).
    (req as unknown as { socket: object }).socket = {};
    req.headers["x-forwarded-for"] = "203.0.113.7";
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(capturedInput().apiDispatchMeta.metadata.callerIp).toBe(
      "203.0.113.7",
    );
  });

  it("joins X-Forwarded-For with commas when Node parses it as a string array (multi-proxy chain)", async () => {
    // Node types `headers["x-forwarded-for"]` as `string | string[]`.
    // Multi-hop reverse proxies can produce the array form. The current
    // code calls `.toString()` which joins arrays with commas — locking
    // that behavior here means a refactor that picks just the first
    // element (often the right call for trust-boundary reasons) is a
    // visible decision, not a silent change.
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do work",
    });
    (req as unknown as { socket: object }).socket = {};
    // Node's IncomingHttpHeaders types this as string|string[]; assigning
    // an array directly is well-supported at runtime even though the
    // typings prefer string.
    (req.headers as Record<string, unknown>)["x-forwarded-for"] = [
      "203.0.113.7",
      "10.0.0.1",
    ];
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(capturedInput().apiDispatchMeta.metadata.callerIp).toBe(
      "203.0.113.7,10.0.0.1",
    );
  });

  it("returns null when neither socket.remoteAddress nor X-Forwarded-For is present", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      workspace: "issue-worker",
      task: "Do work",
    });
    // Default mock socket is null and headers has no x-forwarded-for —
    // exercises the `?? null` terminal of the chain.
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(capturedInput().apiDispatchMeta.metadata.callerIp).toBeNull();
  });
});

/**
 * `handleFleshOut` — DX-348 Phase 1 (DX-349). Async card flesh-out route.
 * The handler validates the body (`issue_id` required + format-checked),
 * then forwards to `dispatch()` with a hard-coded `workspace: "issue-worker"`,
 * `task: "/danx-flesh-out <issue_id>"`, and `issueId` set so the dispatch
 * row links to the card.
 *
 * Test surface:
 *   - 503 when dispatchApi is toggled off (same shape as handleLaunch).
 *   - 400 on missing / blank / malformed issue_id.
 *   - 400 when body.repo names a different worker.
 *   - 200 happy path — captured dispatch() call carries the right workspace,
 *     task, issueId, and apiDispatchMeta endpoint.
 *   - ProjectsDirError / WorkspaceCallerError map to the same status codes
 *     as `handleLaunch` (test pins ProjectsDirError → 503 + MCP resolve → 400
 *     so the error-mapping chain doesn't silently drop a branch).
 */
describe("handleFleshOut — body validation + dispatch wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    mockDispatchFn.mockResolvedValue({ dispatchId: "test-flesh-out-1" });
  });

  it("returns 503 when dispatchApi is disabled (mirrors /api/launch contract)", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "dispatchApi",
    );
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-349",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getBody())).toEqual({
      error: `Dispatch API is disabled for repo ${MOCK_REPO.name}`,
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when body.repo names a different worker (cross-worker safety)", async () => {
    const req = createMockReqWithBody("POST", {
      repo: "some-other-repo",
      issue_id: "DX-349",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /This worker manages "[^"]+", not "some-other-repo"/,
    );
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when issue_id is missing", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or blank required field: issue_id",
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when issue_id is whitespace-only", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "   ",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or blank required field: issue_id",
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["lowercase prefix", "dx-349"],
    ["digit-only prefix", "12-349"],
    ["no dash", "DX349"],
    ["dash but no number", "DX-"],
    ["trailing junk", "DX-349x"],
    ["embedded space", "DX 349"],
  ])("returns 400 on malformed issue_id (%s: %j)", async (_label, raw) => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: raw,
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /^Invalid issue_id ".*" — must match <PREFIX>-N/,
    );
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 200 + spawns dispatch with the correct task / workspace / issueId on happy path", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-349",
      api_token: "secret-bearer",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      job_id: "test-flesh-out-1",
      status: "launched",
    });
    expect(mockDispatchFn).toHaveBeenCalledTimes(1);

    type FleshOutDispatchInput = CapturedDispatchInput & {
      workspace: string;
      task: string;
      apiToken?: string;
      overlay: Record<string, string>;
      issueId?: string;
    };
    const input = mockDispatchFn.mock.calls[0][0] as FleshOutDispatchInput;
    expect(input.workspace).toBe("issue-worker");
    expect(input.task).toBe("/danx-flesh-out DX-349");
    expect(input.issueId).toBe("DX-349");
    expect(input.apiToken).toBe("secret-bearer");
    expect(input.overlay).toEqual({});
    expect(input.apiDispatchMeta).toEqual({
      trigger: "api",
      metadata: {
        endpoint: "/api/flesh-out",
        callerIp: null,
        statusUrl: null,
        initialPrompt: "/danx-flesh-out DX-349",
        workspace: "issue-worker",
      },
    });
  });

  it("body without repo is accepted (validateRepoMatch is opt-in)", async () => {
    // The dashboard proxy forwards `body.repo` verbatim, so dashboard-
    // originated calls always carry it. But a direct in-network caller
    // (curl from another worker container on `danxbot-net`) may omit
    // the field. `validateRepoMatch` only enforces equality when the
    // field is present, so the omit path must still 200.
    const req = createMockReqWithBody("POST", {
      issue_id: "DX-42",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const input = mockDispatchFn.mock.calls[0][0] as { issueId?: string };
    expect(input.issueId).toBe("DX-42");
  });

  it("maps ProjectsDirError from dispatch() to 503 (worker-config issue)", async () => {
    const { ProjectsDirError } = await import(
      "../agent/projects-dir-preflight.js"
    );
    const summary =
      "Claude projects dir /home/danxbot/.claude/projects is not writable";
    mockDispatchFn.mockRejectedValueOnce(
      new ProjectsDirError({ ok: false, reason: "readonly", summary }),
    );

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-349",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getBody())).toEqual({ error: summary });
  });

  it("maps WorkspaceGateUnknownError to 500 (server-side bug)", async () => {
    const { WorkspaceGateUnknownError } = await import(
      "../workspace/resolve.js"
    );
    mockDispatchFn.mockRejectedValueOnce(
      new WorkspaceGateUnknownError(
        "Workspace gate 'unknown-gate' is not recognized by this resolver",
      ),
    );

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-349",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    // Distinct from generic 500: an unknown gate is a server-side bug
    // (the workspace YAML declares a gate the resolver doesn't know),
    // not a caller-fixable input. Same status code, distinct log path.
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/unknown-gate/);
  });

  it("forwards status_url + api_token to dispatch() (statusUrl wiring)", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-349",
      api_token: "callback-bearer-xyz",
      status_url: "https://laravel.example.com/agent/status",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const input = mockDispatchFn.mock.calls[0][0] as {
      statusUrl?: string;
      apiToken?: string;
      apiDispatchMeta: { metadata: { statusUrl: string | null } };
    };
    expect(input.statusUrl).toBe("https://laravel.example.com/agent/status");
    expect(input.apiToken).toBe("callback-bearer-xyz");
    // The dashboard surfaces the callback URL from the trigger metadata,
    // so the same value must reach both fields.
    expect(input.apiDispatchMeta.metadata.statusUrl).toBe(
      "https://laravel.example.com/agent/status",
    );
  });

  it("returns 400 when issue_id is not a string (e.g. JSON number)", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: 349,
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or blank required field: issue_id",
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("maps McpResolveError from dispatch() to 400 (caller-fixable)", async () => {
    const { McpResolveError } = await import("../agent/mcp-types.js");
    mockDispatchFn.mockRejectedValueOnce(
      new McpResolveError("MCP placeholder ${FOO} unresolved"),
    );

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-349",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/MCP placeholder/);
  });

  it("maps WorkspaceNotFoundError to 400 (caller-fixable)", async () => {
    const { WorkspaceNotFoundError } = await import(
      "../workspace/resolve.js"
    );
    mockDispatchFn.mockRejectedValueOnce(
      new WorkspaceNotFoundError(
        'Workspace "issue-worker" not found under /repo/.danxbot/workspaces/',
      ),
    );

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-349",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/issue-worker/);
  });

  it("maps an unknown dispatch failure to 500 (catch-all)", async () => {
    mockDispatchFn.mockRejectedValueOnce(new Error("spawn ENOENT"));

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-349",
    });
    const res = createMockRes();

    await handleFleshOut(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody())).toEqual({ error: "spawn ENOENT" });
  });
});

/**
 * `handleTriage` — DX-515 phase 1. Operator-directed triage dispatch.
 *
 * Mirrors `handleFleshOut` in shape (same auth band, same workspace,
 * same error-mapping chain) but builds a task body that optionally
 * carries a `## Operator notes` block and stamps
 * `dispatchKind: "triage"` on the dispatch row.
 *
 * Test surface:
 *   - 503 when dispatchApi is toggled off (consistency with other routes).
 *   - 400 on missing / blank / malformed issue_id (delegated to the
 *     shared validator — one happy-path coverage check).
 *   - 400 when body.repo names a different worker.
 *   - 400 when instructions is the wrong type / blank / oversized.
 *   - 200 base path — task body is the bare triage line; no
 *     `## Operator notes` block; `dispatchKind: "triage"`; `issueId`
 *     linked.
 *   - 200 with-notes path — task body appends the marked block verbatim
 *     to make the SKILL.md contract observable in `prompt.md`.
 *   - 200 with exactly 2000-char instructions (boundary).
 *   - Default error mapping (ProjectsDirError → 503, McpResolveError →
 *     400, unknown → 500) matches the other dispatch routes.
 *
 * The `buildTriageTaskBody` helper is exercised separately so the
 * task-shaping contract is pinned without going through the HTTP layer.
 */
describe("buildTriageTaskBody — task body shaping", () => {
  it("returns just the orchestrator slash command when instructions is null", () => {
    expect(buildTriageTaskBody(null)).toBe("/danx-triage-orchestrator");
  });

  it("appends the `## Operator notes` block when instructions is present", () => {
    expect(buildTriageTaskBody("only Blocked cards older than 2 weeks")).toBe(
      "/danx-triage-orchestrator\n\n## Operator notes\n\nonly Blocked cards older than 2 weeks",
    );
  });

  it("preserves multi-line operator notes verbatim (no trimming, no escaping)", () => {
    const notes = "line one\nline two\n\nparagraph break";
    expect(buildTriageTaskBody(notes)).toBe(
      `/danx-triage-orchestrator\n\n## Operator notes\n\n${notes}`,
    );
  });
});

describe("handleTriage — body validation + dispatch wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    mockDispatchFn.mockResolvedValue({ dispatchId: "test-triage-1" });
  });

  it("returns 503 when dispatchApi is disabled (mirrors /api/launch contract)", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "dispatchApi",
    );
    const req = createMockReqWithBody("POST", { repo: MOCK_REPO.name });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getBody())).toEqual({
      error: `Dispatch API is disabled for repo ${MOCK_REPO.name}`,
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when body.repo names a different worker (cross-worker safety)", async () => {
    const req = createMockReqWithBody("POST", { repo: "some-other-repo" });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /This worker manages "[^"]+", not "some-other-repo"/,
    );
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("rejects legacy issue_id field with 400 (zero back-compat — orchestrator picks targets)", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-515",
    });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/issue_id is not accepted/);
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when instructions is the wrong type (e.g. JSON number)", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      instructions: 42,
    });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "instructions must be a string when provided",
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when instructions is whitespace-only", async () => {
    // Empty-after-trim is rejected so the agent never sees a `##
    // Operator notes` header with no body underneath.
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      instructions: "   \n   ",
    });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "instructions must be a non-empty string when provided",
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when instructions exceeds 2000 chars", async () => {
    const oversized = "x".repeat(2001);
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      instructions: oversized,
    });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /instructions exceeds 2000-character limit \(got 2001\)/,
    );
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("accepts exactly 2000-char instructions (boundary)", async () => {
    const maxed = "x".repeat(2000);
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      instructions: maxed,
    });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(mockDispatchFn).toHaveBeenCalledTimes(1);
    type TriageDispatchInput = CapturedDispatchInput & {
      workspace: string;
      task: string;
      issueId?: string;
      dispatchKind?: string;
    };
    const input = mockDispatchFn.mock.calls[0][0] as TriageDispatchInput;
    expect(input.task).toBe(
      `/danx-triage-orchestrator\n\n## Operator notes\n\n${maxed}`,
    );
  });

  it("returns 200 + spawns base-form orchestrator dispatch when instructions is omitted", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      api_token: "secret-bearer",
    });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      job_id: "test-triage-1",
      status: "launched",
    });

    expect(mockDispatchFn).toHaveBeenCalledTimes(1);
    type TriageDispatchInput = CapturedDispatchInput & {
      workspace: string;
      task: string;
      apiToken?: string;
      overlay: Record<string, string>;
      issueId?: string;
      dispatchKind?: string;
    };
    const input = mockDispatchFn.mock.calls[0][0] as TriageDispatchInput;
    expect(input.workspace).toBe("issue-worker");
    expect(input.task).toBe("/danx-triage-orchestrator");
    expect(input.task).not.toMatch(/Operator notes/);
    expect(input.issueId).toBeUndefined();
    expect(input.apiToken).toBe("secret-bearer");
    expect(input.overlay).toEqual({});
    expect(input.dispatchKind).toBe("triage");
    expect(input.apiDispatchMeta).toEqual({
      trigger: "api",
      metadata: {
        endpoint: "/api/triage",
        callerIp: null,
        statusUrl: null,
        initialPrompt: "/danx-triage-orchestrator",
        workspace: "issue-worker",
      },
    });
  });

  it("returns 200 + appends the `## Operator notes` block when instructions is present", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      instructions: "only Blocked cards older than 2 weeks",
    });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(mockDispatchFn).toHaveBeenCalledTimes(1);
    type TriageDispatchInput = CapturedDispatchInput & {
      task: string;
      dispatchKind?: string;
    };
    const input = mockDispatchFn.mock.calls[0][0] as TriageDispatchInput;
    expect(input.task).toBe(
      "/danx-triage-orchestrator\n\n## Operator notes\n\nonly Blocked cards older than 2 weeks",
    );
    // The initialPrompt in apiDispatchMeta must match the task exactly —
    // it's the dashboard's source-of-truth for what the agent received.
    expect(input.apiDispatchMeta.metadata.initialPrompt).toBe(input.task);
    expect(input.dispatchKind).toBe("triage");
  });

  it("maps McpResolveError from dispatch() to 400 (caller-fixable)", async () => {
    const { McpResolveError } = await import("../agent/mcp-types.js");
    mockDispatchFn.mockRejectedValueOnce(
      new McpResolveError("MCP placeholder ${FOO} unresolved"),
    );

    const req = createMockReqWithBody("POST", { repo: MOCK_REPO.name });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/MCP placeholder/);
  });

  it("maps an unknown dispatch failure to 500 (catch-all)", async () => {
    mockDispatchFn.mockRejectedValueOnce(new Error("spawn ENOENT"));

    const req = createMockReqWithBody("POST", { repo: MOCK_REPO.name });
    const res = createMockRes();

    await handleTriage(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody())).toEqual({ error: "spawn ENOENT" });
  });
});

/**
 * `handleChat` — DX-348 Phase 3 (DX-351). Per-card chat session.
 *
 * The handler validates {issue_id, text}, looks up the chat-sessions
 * record for the issue, decides FRESH (no record / stale session) vs
 * RESUME (record + claude session file still exists), then forwards to
 * `dispatch()` with workspace `issue-chat`. After a successful spawn,
 * the new `dispatch_id` is persisted to the chat-sessions file so the
 * next call resumes the leaf of the chain.
 *
 * Test surface:
 *   - 503 when dispatchApi toggled off (mirrors the rest of the dispatch routes).
 *   - 400 on missing / blank / malformed issue_id + text.
 *   - 400 when body.repo names a different worker.
 *   - 200 FRESH path — no prior record → `/danx-chat <id>\n\n<text>` task.
 *   - 200 RESUME path — prior record + session resolves → text-only task,
 *     resumeSessionId + parentJobId threaded.
 *   - 200 FRESH path when chat-sessions exists but the prior session uuid
 *     can't be resolved (stale record after worker move / claude purge).
 *   - chat-sessions write happens AFTER dispatch returns, with the new id.
 *   - error-mapping chain matches handleFleshOut (ProjectsDirError → 503, etc.)
 */
describe("handleChat — body validation + fresh/resume routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    mockDispatchFn.mockResolvedValue({ dispatchId: "test-chat-1" });
    mockReadChatSession.mockResolvedValue(null);
    mockWriteChatSession.mockResolvedValue(undefined);
    mockFindSessionFileByDispatchId.mockResolvedValue(null);
  });

  it("returns 503 when dispatchApi is disabled", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "dispatchApi",
    );
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "hello",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getBody())).toEqual({
      error: `Dispatch API is disabled for repo ${MOCK_REPO.name}`,
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
    expect(mockWriteChatSession).not.toHaveBeenCalled();
  });

  it("returns 400 when body.repo names a different worker", async () => {
    const req = createMockReqWithBody("POST", {
      repo: "wrong-repo",
      issue_id: "DX-351",
      text: "hi",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /This worker manages "[^"]+", not "wrong-repo"/,
    );
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when issue_id is missing", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      text: "hi",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or blank required field: issue_id",
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["lowercase prefix", "dx-351"],
    ["digit prefix", "12-351"],
    ["no dash", "DX351"],
    ["empty digits", "DX-"],
    ["trailing junk", "DX-351x"],
  ])("returns 400 on malformed issue_id (%s)", async (_label, raw) => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: raw,
      text: "hi",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /^Invalid issue_id ".*" — must match <PREFIX>-N/,
    );
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when text is missing", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or blank required field: text",
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("returns 400 when text is whitespace-only", async () => {
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "   ",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or blank required field: text",
    });
    expect(mockDispatchFn).not.toHaveBeenCalled();
  });

  it("FRESH path: no prior record → dispatches with /danx-chat <id> + text task, no resume, persists new id", async () => {
    mockReadChatSession.mockResolvedValue(null);
    mockDispatchFn.mockResolvedValue({ dispatchId: "new-chat-job" });
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "please flip status to ToDo",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      job_id: "new-chat-job",
      parent_job_id: null,
      status: "launched",
    });

    expect(mockDispatchFn).toHaveBeenCalledTimes(1);
    type ChatDispatchInput = {
      workspace: string;
      task: string;
      issueId?: string;
      resumeSessionId?: string;
      parentJobId?: string;
      apiDispatchMeta: {
        trigger: string;
        metadata: { endpoint: string; workspace: string };
      };
    };
    const input = mockDispatchFn.mock.calls[0][0] as ChatDispatchInput;
    expect(input.workspace).toBe("issue-chat");
    expect(input.task).toBe(
      "/danx-chat DX-351\n\nplease flip status to ToDo",
    );
    expect(input.issueId).toBe("DX-351");
    expect(input.resumeSessionId).toBeUndefined();
    expect(input.parentJobId).toBeUndefined();
    expect(input.apiDispatchMeta.metadata.endpoint).toBe("/api/chat");
    expect(input.apiDispatchMeta.metadata.workspace).toBe("issue-chat");

    expect(mockWriteChatSession).toHaveBeenCalledTimes(1);
    expect(mockWriteChatSession).toHaveBeenCalledWith(
      MOCK_REPO.localPath,
      "DX-351",
      "new-chat-job",
    );
  });

  it("RESUME path: prior record + session resolves → text-only task, resumeSessionId + parentJobId set, new id persisted", async () => {
    mockReadChatSession.mockResolvedValue({
      dispatch_id: "prior-chat-job",
      updated_at: "2026-05-14T07:00:00.000Z",
    });
    // findSessionFileByDispatchId returns the JSONL file path; the
    // resolver basenames it (minus `.jsonl`) to get the session uuid.
    mockFindSessionFileByDispatchId.mockResolvedValue(
      "/fake/projects/x/session-uuid-abc.jsonl",
    );
    mockDispatchFn.mockResolvedValue({ dispatchId: "resumed-chat-job" });

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "and also bump priority",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      job_id: "resumed-chat-job",
      parent_job_id: "prior-chat-job",
      status: "launched",
    });

    const input = mockDispatchFn.mock.calls[0][0] as {
      task: string;
      resumeSessionId?: string;
      parentJobId?: string;
    };
    // No skill prompt on resume — claude --resume continues the
    // conversation history; reinjecting the skill would duplicate
    // boilerplate in the dispatched session.
    expect(input.task).toBe("and also bump priority");
    expect(input.resumeSessionId).toBe("session-uuid-abc");
    expect(input.parentJobId).toBe("prior-chat-job");

    expect(mockWriteChatSession).toHaveBeenCalledWith(
      MOCK_REPO.localPath,
      "DX-351",
      "resumed-chat-job",
    );
  });

  it("STALE record path: prior record exists but session uuid unresolvable → fall through to FRESH dispatch", async () => {
    mockReadChatSession.mockResolvedValue({
      dispatch_id: "abandoned-job",
      updated_at: "2026-05-01T00:00:00.000Z",
    });
    mockFindSessionFileByDispatchId.mockResolvedValue(null);
    mockDispatchFn.mockResolvedValue({ dispatchId: "fresh-after-stale" });

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "still want to chat",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.parent_job_id).toBeNull();

    const input = mockDispatchFn.mock.calls[0][0] as {
      task: string;
      resumeSessionId?: string;
    };
    expect(input.task).toBe("/danx-chat DX-351\n\nstill want to chat");
    expect(input.resumeSessionId).toBeUndefined();
    // Stale record was overwritten with the new dispatch id.
    expect(mockWriteChatSession).toHaveBeenCalledWith(
      MOCK_REPO.localPath,
      "DX-351",
      "fresh-after-stale",
    );
  });

  it("chat-sessions write failure AFTER dispatch still returns 200 + job_id (dispatch already launched)", async () => {
    // The dispatch IS the authoritative side effect; failing to record
    // the new leaf would only cost a re-dispatch FRESH on the next
    // turn. Telling the caller "your request failed" while the agent
    // is burning tokens is worse than the lost cache write.
    mockReadChatSession.mockResolvedValue(null);
    mockDispatchFn.mockResolvedValue({ dispatchId: "launched-job" });
    mockWriteChatSession.mockRejectedValueOnce(
      new Error("EACCES on chat-sessions"),
    );

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "hello",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      job_id: "launched-job",
      parent_job_id: null,
      status: "launched",
    });
    expect(mockDispatchFn).toHaveBeenCalledTimes(1);
  });

  it("does NOT pass dispatchKind on chat dispatch — prevents the ToDo→In Progress auto-flip from triggering on a chat turn", async () => {
    // src/dispatch/core.ts auto-flips ToDo → In Progress when
    // `dispatchKind === "work"` and `issueId` is set. Chat dispatches
    // MUST NOT trigger that flip — a chat turn against a ToDo card is
    // a conversation, not a pickup. Defensive against a future
    // refactor that defaults dispatchKind="work" or adds it implicitly.
    mockReadChatSession.mockResolvedValue(null);
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "what is this card about?",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    const input = mockDispatchFn.mock.calls[0][0] as {
      issueId?: string;
      dispatchKind?: string;
    };
    expect(input.issueId).toBe("DX-351");
    expect(input.dispatchKind).toBeUndefined();
  });

  it("chat-sessions read failure is non-fatal — proceeds as FRESH", async () => {
    // Disk-read errors must not 500 — the chat-sessions record is a
    // cache, not authoritative state. A bad read self-heals via the
    // subsequent write.
    mockReadChatSession.mockRejectedValue(new Error("EIO read failure"));
    mockDispatchFn.mockResolvedValue({ dispatchId: "recovered-job" });

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "still works",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const input = mockDispatchFn.mock.calls[0][0] as { task: string };
    expect(input.task).toBe("/danx-chat DX-351\n\nstill works");
    expect(mockWriteChatSession).toHaveBeenCalledWith(
      MOCK_REPO.localPath,
      "DX-351",
      "recovered-job",
    );
  });

  it("forwards api_token + status_url to dispatch()", async () => {
    mockReadChatSession.mockResolvedValue(null);
    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "hello",
      api_token: "bearer-xyz",
      status_url: "https://laravel.example.com/agent/status",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const input = mockDispatchFn.mock.calls[0][0] as {
      apiToken?: string;
      statusUrl?: string;
    };
    expect(input.apiToken).toBe("bearer-xyz");
    expect(input.statusUrl).toBe("https://laravel.example.com/agent/status");
  });

  it("maps generic dispatch() failure to 500", async () => {
    mockReadChatSession.mockResolvedValue(null);
    mockDispatchFn.mockRejectedValueOnce(new Error("spawn ENOENT"));

    const req = createMockReqWithBody("POST", {
      repo: MOCK_REPO.name,
      issue_id: "DX-351",
      text: "hi",
    });
    const res = createMockRes();

    await handleChat(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody())).toEqual({ error: "spawn ENOENT" });
    expect(mockWriteChatSession).not.toHaveBeenCalled();
  });
});
