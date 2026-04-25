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
