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
function mockSettingsRead(
  spawnOpts: Record<string, unknown> | undefined,
): { mcpServers: Record<string, { env: Record<string, string> }> } {
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
vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

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
vi.mock("../dashboard/dispatches-db.js", () => ({
  getDispatchById: vi.fn(),
  insertDispatch: vi.fn(),
  updateDispatch: vi.fn().mockResolvedValue(undefined),
}));

// Mock the critical-failure module so handleStop's writeFlag path doesn't
// touch the real filesystem. Tests assert on the mock args to verify the
// agent-signal payload shape.
const mockWriteFlag = vi.fn().mockImplementation((_lp: string, payload: unknown) => ({
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
// completed/failed path so an agent that called `danxbot_complete`
// without an explicit `danx_issue_save` still gets its YAML pushed to
// the tracker. Critical-failure short-circuits BEFORE this call. Mock
// records call order against `mockStop` so assertions pin the
// before-stop sequence.
const mockAutoSyncTrackedIssue = vi.fn().mockResolvedValue(undefined);
vi.mock("./auto-sync.js", () => ({
  autoSyncTrackedIssue: (...args: unknown[]) =>
    mockAutoSyncTrackedIssue(...args),
}));

import {
  handleLaunch,
  handleResume,
  handleCancel,
  handleListJobs,
  handleStatus,
  handleStop,
  clearJobCleanupIntervals,
} from "./dispatch.js";

const MOCK_REPO = makeRepoContext();

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFeatureEnabled.mockReturnValue(true);
  mockGetActiveJob.mockReset();
  mockListActiveJobs.mockReset().mockReturnValue([]);
  mockDispatchFn.mockReset();
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


describe("handleLaunch / handleResume — claude-auth preflight (Trello 3l2d7i46)", () => {
  // Hoisted lazily so the import doesn't pay the cost on every test file load.
  let ClaudeAuthError: typeof import("../agent/claude-auth-preflight.js").ClaudeAuthError;

  beforeEach(async () => {
    ({ ClaudeAuthError } = await import("../agent/claude-auth-preflight.js"));
  });

  it("handleLaunch maps ClaudeAuthError to 503 with the preflight summary as the error string", async () => {
    // Worker-config issue, not a caller bug — same shape as the dispatchApi-
    // disabled branch so external dispatchers (gpt-manager) handle both with
    // identical "back off and retry later" logic.
    const summary =
      "claude-auth file .claude.json at /home/danxbot/.claude.json is read-only — fix the bind mount in compose.yml";
    mockDispatchFn.mockRejectedValueOnce(
      new ClaudeAuthError({ ok: false, reason: "readonly", summary }),
    );

    const req = createMockReqWithBody("POST", {
      workspace: "system-test",
      task: "do thing",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getBody())).toEqual({ error: summary });
  });

  it("handleResume maps ClaudeAuthError to 503 with the preflight summary", async () => {
    // Twin coverage of the dispatch.ts catch arm — without it, a future
    // refactor that DRYs the two handlers can drop one branch and only the
    // launch test fails, hiding the resume regression.
    const summary =
      "claude-auth OAuth token expired at 2026-01-01T00:00:00.000Z — host claude needs to refresh, or worker needs a redeploy";
    mockDispatchFn.mockRejectedValueOnce(
      new ClaudeAuthError({ ok: false, reason: "expired", summary }),
    );

    // Set up the resume parent-session lookup to succeed so the failure path
    // we exercise is the dispatch() call, not a missing-parent 404.
    mockFindSessionFileByDispatchId.mockResolvedValueOnce(
      "/fake/projects/parent.jsonl",
    );

    const req = createMockReqWithBody("POST", {
      job_id: "parent-job-123",
      workspace: "system-test",
      task: "continue",
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getBody())).toEqual({ error: summary });
  });

  it("ClaudeAuthError 503 takes precedence over the catch-all 500 in handleLaunch", async () => {
    // The instanceof chain in handleLaunch is order-sensitive. If a future
    // refactor swaps the order or replaces it with a switch on err.name,
    // ClaudeAuthError (a subclass of Error) would silently fall through to
    // the generic 500 branch and external callers would lose the worker-
    // config signal.
    const authErr = new ClaudeAuthError({
      ok: false,
      reason: "missing",
      summary: "claude-auth file .credentials.json is missing",
    });
    mockDispatchFn.mockRejectedValueOnce(authErr);

    const req = createMockReqWithBody("POST", {
      workspace: "system-test",
      task: "do thing",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(503);
    expect(res._getStatusCode()).not.toBe(500);
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
        workspace: "trello-worker",
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
      workspace: "trello-worker",
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
        workspace: "trello-worker",
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
      workspace: "trello-worker",
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
      workspace: "trello-worker",
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
        workspace: "trello-worker",
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
      workspace: "trello-worker",
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
      workspace: "trello-worker",
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
      workspace: "trello-worker",
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
      workspace: "trello-worker",
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
      workspace: "trello-worker",
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
      workspace: "trello-worker",
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
      workspace: "trello-worker",
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
      workspace: "trello-worker",
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
      workspace: "trello-worker",
      task: "Do work",
    });
    // Default mock socket is null and headers has no x-forwarded-for —
    // exercises the `?? null` terminal of the chain.
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(capturedInput().apiDispatchMeta.metadata.callerIp).toBeNull();
  });
});
