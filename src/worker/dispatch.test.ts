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
  handleStatus,
  handleStop,
  clearJobCleanupIntervals,
} from "./dispatch.js";

const MOCK_REPO = makeRepoContext();

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFeatureEnabled.mockReturnValue(true);
});

describe("handleLaunch", () => {
  it("returns 400 when task is missing", async () => {
    const req = createMockReqWithBody("POST", { api_token: "tok-123" });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or blank required fields: task, api_token",
    });
  });

  it("returns 400 when api_token is missing", async () => {
    const req = createMockReqWithBody("POST", { task: "Do something" });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or blank required fields: task, api_token",
    });
  });

  it("returns 400 when repo name does not match", async () => {
    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: [],
      repo: "wrong-repo",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: `This worker manages "test-repo", not "wrong-repo"`,
    });
  });

  it("returns 400 when allow_tools is missing (AC: required field)", async () => {
    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/allow_tools/);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when allow_tools is not an array", async () => {
    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: "Read",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/array/);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when allow_tools contains a non-string entry", async () => {
    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: ["Read", 42],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/string/);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 400 (not 500) when allow_tools references an unknown MCP server — McpResolveError maps to 400", async () => {
    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: ["mcp__totally_unknown_server__anything"],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /unknown MCP server|totally_unknown_server/,
    );
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when allow_tools asks for mcp__schema__* but schema_definition_id is missing — resolver surfaces 400, not 500", async () => {
    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: ["mcp__schema__schema_get"],
      // schema_definition_id intentionally omitted
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /definitionId|SCHEMA_DEFINITION_ID/,
    );
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 200 with job_id on successful launch", async () => {
    const mockJob = {
      id: "job-abc-123",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Implement feature X",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    // job_id is the stable dispatchId (UUID), not the internal job id
    expect(body.job_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(body.status).toBe("launched");
  });

  it("passes correct options to spawnAgent", async () => {
    const mockJob = {
      id: "job-1",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Build schema",
      api_token: "tok-abc",
      allow_tools: [],
      status_url: "http://example.com/status",
      max_runtime_ms: 120000,
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        // Prompt includes the completion instruction appended by handleLaunch
        prompt: expect.stringContaining("Build schema"),
        repoName: "test-repo",
        timeoutMs: 3600000,
        mcpConfigPath: expect.stringContaining("settings.json"),
        statusUrl: "http://example.com/status",
        apiToken: "tok-abc",
        maxRuntimeMs: 120000,
        eventForwarding: {
          statusUrl: "http://example.com/status",
          apiToken: "tok-abc",
        },
        openTerminal: false, // config.isHost is false in test
      }),
    );
  });

  it("does NOT forward resume fields (resumeSessionId, parentJobId) on a fresh launch", async () => {
    // Regression guard: the `expect.objectContaining` in the "passes correct
    // options" test tolerates extra keys. A refactor that accidentally leaks
    // resumeSessionId/parentJobId into handleLaunch would silently turn every
    // fresh launch into a resume. This test locks their absence explicitly.
    const mockJob = {
      id: "job-no-leak",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Fresh launch",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    expect(spawnOpts.resumeSessionId).toBeUndefined();
    expect(spawnOpts.parentJobId).toBeUndefined();
  });

  it("passes title to spawnAgent when provided", async () => {
    const mockJob = {
      id: "job-1",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Build schema",
      api_token: "tok-abc",
      allow_tools: [],
      title: "AgentDispatch #AGD-359, SchemaDefinition #SD-176",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    expect(spawnOpts.title).toBe(
      "AgentDispatch #AGD-359, SchemaDefinition #SD-176",
    );
  });

  // Regression: the agents object on the request body must reach spawnAgent
  // intact. See `.claude/rules/agent-dispatch.md`.
  it("forwards the agents object from the request body to spawnAgent intact", async () => {
    const mockJob = {
      id: "job-agents",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const agents = {
      "template-builder": { description: "Builds templates", prompt: "..." },
      "schema-builder": { description: "Builds schemas", prompt: "..." },
    };

    const req = createMockReqWithBody("POST", {
      task: "Build schema",
      api_token: "tok-abc",
      allow_tools: [],
      agents,
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    expect(spawnOpts.agents).toEqual(agents);
  });

  it("does not set eventForwarding when statusUrl is absent", async () => {
    const mockJob = {
      id: "job-2",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    expect(spawnOpts.eventForwarding).toBeUndefined();
  });

  it("calls buildMcpSettings with correct options", async () => {
    const mockJob = {
      id: "job-3",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Build schema",
      api_token: "tok-abc",
      allow_tools: ["mcp__schema__*"],
      api_url: "http://custom-api.com",
      schema_definition_id: "def-42",
      schema_role: "builder",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    const settings = mockSettingsRead(spawnOpts);
    expect(settings.mcpServers.schema.env.SCHEMA_API_URL).toBe(
      "http://custom-api.com",
    );
    expect(settings.mcpServers.schema.env.SCHEMA_API_TOKEN).toBe("tok-abc");
    expect(settings.mcpServers.schema.env.SCHEMA_DEFINITION_ID).toBe("def-42");
    expect(settings.mcpServers.schema.env.SCHEMA_ROLE).toBe("builder");
    expect(settings.mcpServers.danxbot.env.DANXBOT_STOP_URL).toContain(
      "/api/stop/",
    );
  });

  it("accepts numeric schema_definition_id (Laravel sends int IDs as JSON numbers)", async () => {
    // Regression: Laravel's `$schema->id` is an int and serializes as a JSON
    // number, not a string. A string-only type-check silently drops the value,
    // so `SCHEMA_DEFINITION_ID` never reaches the MCP server, which exits with
    // "SCHEMA_DEFINITION_ID is required" — leaving the agent with no
    // `mcp__schema__*` tools. The parser must coerce numeric IDs to strings.
    const mockJob = {
      id: "job-int-id",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Build schema",
      api_token: "tok-abc",
      allow_tools: ["mcp__schema__*"],
      api_url: "http://custom-api.com",
      schema_definition_id: 42, // numeric, as Laravel sends it
      schema_role: "orchestrator",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    const settings = mockSettingsRead(spawnOpts);
    expect(settings.mcpServers.schema.env.SCHEMA_DEFINITION_ID).toBe("42");
    expect(settings.mcpServers.schema.env.SCHEMA_ROLE).toBe("orchestrator");
  });

  it("rewrites loopback callback URLs to host.docker.internal in docker runtime", async () => {
    // mockDispatchConfig.isHost = false (docker runtime). Callbacks sent as
    // localhost URLs would fail from inside a container; handleLaunch must
    // rewrite both api_url and status_url before passing them downstream.
    mockDispatchConfig.isHost = false;
    const mockJob = {
      id: "job-rw",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Build schema",
      api_token: "tok-abc",
      allow_tools: [],
      api_url: "http://localhost:80",
      status_url: "http://localhost/api/agent-dispatch/abc/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockSpawnAgent).toHaveBeenCalled();
    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    expect(spawnOpts.statusUrl).toBe(
      "http://host.docker.internal/api/agent-dispatch/abc/status",
    );
  });

  it("normalizes the defaultApiUrl fallback when api_url is omitted", async () => {
    // Regression: `defaultApiUrl` is itself a loopback URL (http://localhost:80)
    // and must be rewritten in docker runtime when the dispatcher omits api_url.
    mockDispatchConfig.isHost = false;
    const mockJob = {
      id: "job-fb",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      // No api_url — falls back to config.dispatch.defaultApiUrl
      task: "Do work",
      api_token: "tok-abc",
      allow_tools: [],
      status_url: "http://localhost/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockSpawnAgent).toHaveBeenCalled();
  });

  it("returns 500 without creating MCP settings when api_url is unparseable", async () => {
    // Guard: a bad URL must not leak a settings dir — normalization runs before
    // buildMcpSettings, so an early throw leaves nothing to clean up.
    mockDispatchConfig.isHost = false;
    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-abc",
      allow_tools: [],
      api_url: "not a url",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("leaves loopback callback URLs untouched in host runtime", async () => {
    mockDispatchConfig.isHost = true;
    try {
      const mockJob = {
        id: "job-host",
        status: "running",
        summary: "",
        startedAt: new Date(),
      };
      mockSpawnAgent.mockResolvedValue(mockJob);

      const req = createMockReqWithBody("POST", {
        task: "Build schema",
        api_token: "tok-abc",
        allow_tools: [],
        api_url: "http://localhost:80",
        status_url: "http://localhost/api/agent-dispatch/abc/status",
      });
      const res = createMockRes();

      await handleLaunch(req, res, MOCK_REPO);

      expect(mockSpawnAgent).toHaveBeenCalled();
      const spawnOpts = mockSpawnAgent.mock.calls[0][0];
      expect(spawnOpts.statusUrl).toBe(
        "http://localhost/api/agent-dispatch/abc/status",
      );
    } finally {
      mockDispatchConfig.isHost = false;
    }
  });

  it("cleans up MCP settings on spawn failure", async () => {
    mockSpawnAgent.mockRejectedValue(new Error("Spawn failed"));

    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
  });

  it("accepts matching repo name without error", async () => {
    const mockJob = {
      id: "job-match",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
      allow_tools: [],
      repo: "test-repo",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
  });

  it("returns 500 with the probe error when the MCP probe rejects", async () => {
    // spawnAgent's probe-failure path throws a descriptive error.
    const probeError = new Error(
      'MCP server probe failed for [schema] before launching agent:\n  - MCP server "schema" exited with code 1 before responding: SCHEMA_DEFINITION_ID is required',
    );
    mockSpawnAgent.mockRejectedValueOnce(probeError);

    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    const body = JSON.parse(res._getBody());
    expect(body.error).toContain("schema");
    expect(body.error).toContain("SCHEMA_DEFINITION_ID is required");
  });
});

// Phase 4 of the agent-isolation epic (Trello 7ha2CSpc). `/api/launch` and
// `/api/resume` now merge the `http-launch` dispatch profile's baseline
// allowlist with the caller's `body.allow_tools`. The baseline is empty
// today so the merge is structurally a no-op for http callers, but the
// plumbing is exercised here so a future baseline change flows through
// without rework — and so the two Phase 4 acceptance criteria (profile-
// flag-always-present, danxbot-only-by-default + trello-opt-in-via-body)
// are pinned by assertions.
describe("handleLaunch — profile merge (Phase 4)", () => {
  it("produces a danxbot-only allowlist when body.allow_tools is empty (Phase 4 AC: danxbot-only by default)", async () => {
    const mockJob = {
      id: "job-default",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    // Only infrastructure — `mcp__danxbot__danxbot_complete` — reaches claude.
    // Trello, schema, and every other MCP server stay inert until the caller
    // opts in via body.allow_tools.
    expect(spawnOpts.allowedTools).toEqual([
      "mcp__danxbot__danxbot_complete",
    ]);
    const settings = mockSettingsRead(spawnOpts);
    expect(Object.keys(settings.mcpServers).sort()).toEqual(["danxbot"]);
  });

  it("activates mcp__trello__* when the body opts in (Phase 4 AC: trello opt-in via body works)", async () => {
    const mockJob = {
      id: "job-trello-optin",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Move a card",
      api_token: "tok-123",
      allow_tools: ["mcp__trello__*"],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    // Resolver expands the wildcard via the registry; assert the presence of
    // at least one concrete trello tool + the infra completion tool — without
    // enumerating the registry (that belongs in the resolver tests).
    expect(spawnOpts.allowedTools).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^mcp__trello__/),
        "mcp__danxbot__danxbot_complete",
      ]),
    );
    const settings = mockSettingsRead(spawnOpts);
    expect(Object.keys(settings.mcpServers).sort()).toEqual([
      "danxbot",
      "trello",
    ]);
  });

  it("forwards body.allow_tools entries in declared order (http-launch baseline is empty today)", async () => {
    const mockJob = {
      id: "job-builtin-merge",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Read some files",
      api_token: "tok-123",
      allow_tools: ["Read", "Grep"],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    // The empty http-launch baseline means the effective allowlist is just
    // [built-ins..., danxbot_complete]. Built-ins appear in body-declared
    // order (resolver contract) and the infra tool lands as a stable suffix.
    expect(spawnOpts.allowedTools).toEqual([
      "Read",
      "Grep",
      "mcp__danxbot__danxbot_complete",
    ]);
  });
});

describe("handleLaunch — dispatchApi feature toggle", () => {
  it("returns 503 with the documented body when dispatchApi is disabled", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "dispatchApi",
    );
    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
      allow_tools: [],
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

  it("runs normally when dispatchApi is enabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockSpawnAgent.mockResolvedValue({
      id: "job-enabled",
      status: "running",
      summary: "",
      startedAt: new Date(),
    });
    const req = createMockReqWithBody("POST", {
      task: "Do work",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(mockSpawnAgent).toHaveBeenCalled();
  });
});

describe("handleResume", () => {
  beforeEach(() => {
    mockFindSessionFileByDispatchId.mockReset();
    mockDeriveSessionDir.mockClear();
  });

  it("derives the parent session dir from the workspace cwd, not the repo root (Phase 3 spawn-cwd contract)", async () => {
    // Regression guard: if `resolveParentSessionId` ever reverts to
    // `deriveSessionDir(getReposBase() + repoName)`, every resume would
    // look under an empty projects dir and silently return 404 on good
    // parent IDs. Asserting the cwd string gets the `.danxbot/workspace`
    // suffix locks the launcher + resume lookup in lockstep. See Trello
    // `7ha2CSpc` and `src/workspace/generate.ts` `workspacePath`.
    mockFindSessionFileByDispatchId.mockResolvedValueOnce(
      "/fake/projects/-test-repos-test-repo-.danxbot-workspace/session-abc.jsonl",
    );
    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Keep going",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    const cwds = mockDeriveSessionDir.mock.calls.map((c) => c[0] as string);
    expect(cwds.length).toBeGreaterThan(0);
    expect(cwds.some((cwd) => cwd.endsWith(".danxbot/workspace"))).toBe(true);
  });

  it("returns 400 when job_id is missing", async () => {
    const req = createMockReqWithBody("POST", {
      task: "Keep going",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or blank required fields: job_id, task, api_token",
    });
    expect(mockFindSessionFileByDispatchId).not.toHaveBeenCalled();
  });

  it("returns 400 when job_id is only whitespace (rejects non-empty but blank strings)", async () => {
    // Truthiness lets `"   "` through; typeof+trim checks don't. Regression
    // guard for code-quality.md "fail loud" — a whitespace id would have
    // scanned every JSONL for a bogus tag and returned a misleading 404.
    const req = createMockReqWithBody("POST", {
      job_id: "   ",
      task: "Keep going",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(mockFindSessionFileByDispatchId).not.toHaveBeenCalled();
  });

  it("returns 400 when task is only whitespace", async () => {
    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "   ",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 400 when allow_tools is missing on resume (AC: required field, same gate as launch)", async () => {
    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Keep going",
      api_token: "tok-123",
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/allow_tools/);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 400 (not 500) when resume allow_tools references an unknown MCP server — McpResolveError maps to 400", async () => {
    mockFindSessionFileByDispatchId.mockResolvedValue(
      "/fake/projects/-test-repos-test-repo/session-abc.jsonl",
    );
    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Keep going",
      api_token: "tok-123",
      allow_tools: ["mcp__totally_unknown_server__anything"],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /unknown MCP server|totally_unknown_server/,
    );
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 400 when job_id is not a string (type coercion safety)", async () => {
    const req = createMockReqWithBody("POST", {
      job_id: 12345,
      task: "Keep going",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(mockFindSessionFileByDispatchId).not.toHaveBeenCalled();
  });

  it("returns 400 when task is missing", async () => {
    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 400 when api_token is missing", async () => {
    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Keep going",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 400 when repo name does not match", async () => {
    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Keep going",
      api_token: "tok-123",
      allow_tools: [],
      repo: "wrong-repo",
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: `This worker manages "test-repo", not "wrong-repo"`,
    });
  });

  it("returns 404 when parent session file is not found on disk (tag not in any jsonl)", async () => {
    mockFindSessionFileByDispatchId.mockResolvedValue(null);

    const req = createMockReqWithBody("POST", {
      job_id: "missing-parent",
      task: "Keep going",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({
      error: `Parent job "missing-parent" session file not found — cannot resume`,
    });
    // spawnAgent must not be called when parent resolution fails.
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 500 (not 404) when the Claude session directory does not exist at all", async () => {
    // Distinct failure mode from "parent tag not found": the directory
    // `~/.claude/projects/<cwd>/` itself is missing, meaning claude has never
    // run in this repo's cwd. That's infrastructure, not a stale parent id —
    // mapping it to 404 hides a real bug (wrong cwd, missing deploy, etc).
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockStat.mockRejectedValueOnce(enoent);

    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Keep going",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /Claude session directory .* does not exist/,
    );
    // Must NOT fall through to the tag scan — the dir doesn't exist.
    expect(mockFindSessionFileByDispatchId).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 503 with the documented body when dispatchApi is disabled", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "dispatchApi",
    );
    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Keep going",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(503);
    expect(JSON.parse(res._getBody())).toEqual({
      error: `Dispatch API is disabled for repo ${MOCK_REPO.name}`,
    });
    expect(mockFindSessionFileByDispatchId).not.toHaveBeenCalled();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("returns 200 with {job_id, parent_job_id, status} and passes resumeSessionId + parentJobId to spawnAgent", async () => {
    // Session file lives at /some/dir/<sessionId>.jsonl — extracted via basename.
    mockFindSessionFileByDispatchId.mockResolvedValue(
      "/home/claude/.claude/projects/-repos-test/566c1776-4c8b-43ef-b1c2-76f262450c4a.jsonl",
    );
    const mockJob = {
      id: "resume-child",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      job_id: "aea75840-6e0d-4977-84b3-ac3d07853cdf",
      task: "Now do step 2",
      api_token: "tok-abc",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body).toMatchObject({
      parent_job_id: "aea75840-6e0d-4977-84b3-ac3d07853cdf",
      status: "launched",
    });
    // The new dispatch id is a fresh UUID — distinct from the parent.
    expect(body.job_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(body.job_id).not.toBe("aea75840-6e0d-4977-84b3-ac3d07853cdf");

    // resumeSessionId is the basename of the parent's JSONL, passed through
    // to spawnAgent so buildClaudeInvocation can emit `--resume <sessionId>`.
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeSessionId: "566c1776-4c8b-43ef-b1c2-76f262450c4a",
        parentJobId: "aea75840-6e0d-4977-84b3-ac3d07853cdf",
        repoName: "test-repo",
        prompt: expect.stringContaining("Now do step 2"),
      }),
    );
  });

  it("passes max_runtime_ms and title to spawnAgent when provided", async () => {
    mockFindSessionFileByDispatchId.mockResolvedValue(
      "/home/claude/.claude/projects/-repos-test/parent-session.jsonl",
    );
    mockSpawnAgent.mockResolvedValue({
      id: "resume-child",
      status: "running",
      summary: "",
      startedAt: new Date(),
    });

    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Continue",
      api_token: "tok-abc",
      allow_tools: [],
      max_runtime_ms: 300_000,
      title: "AgentDispatch #AGD-360",
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRuntimeMs: 300_000,
        title: "AgentDispatch #AGD-360",
      }),
    );
  });

  it("returns 500 with the probe error when the MCP probe rejects", async () => {
    // Mirror of the handleLaunch probe-failure contract: resume paths must
    // surface the probe error as a descriptive 500.
    mockFindSessionFileByDispatchId.mockResolvedValueOnce(
      "/fake/projects/parent-session-uuid.jsonl",
    );

    const probeError = new Error(
      'MCP server probe failed for [schema] before launching agent:\n  - MCP server "schema" timeout: no response to initialize',
    );
    mockSpawnAgent.mockRejectedValueOnce(probeError);

    const req = createMockReqWithBody("POST", {
      job_id: "parent-job",
      task: "Continue",
      api_token: "tok-abc",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(500);
    const body = JSON.parse(res._getBody());
    expect(body.error).toContain("schema");
    expect(body.error).toContain("timeout");
  });

  it("produces a danxbot-only allowlist when body.allow_tools is empty on resume (Phase 4 symmetry)", async () => {
    // Resume-side mirror of the "danxbot-only by default" launch test.
    // If a regression ever skipped the profile merge on resume but kept
    // the trello-opt-in path working, the existing resume-trello test
    // would still pass — only a default-case assertion catches it.
    mockFindSessionFileByDispatchId.mockResolvedValueOnce(
      "/fake/projects/-test-repos-test-repo-.danxbot-workspace/session-abc.jsonl",
    );
    const mockJob = {
      id: "job-resume-default",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Continue with no extra tools",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    expect(spawnOpts.allowedTools).toEqual([
      "mcp__danxbot__danxbot_complete",
    ]);
  });

  it("applies the same http-launch profile merge as handleLaunch (Phase 4)", async () => {
    // Symmetry guard: resume must route `body.allow_tools` through the
    // same `mergeProfileWithBody(http-launch, ...)` pipeline as launch
    // so a resumed dispatch inherits the caller's requested tool surface
    // without drift. Mirror of the handleLaunch trello-opt-in test.
    mockFindSessionFileByDispatchId.mockResolvedValueOnce(
      "/fake/projects/-test-repos-test-repo-.danxbot-workspace/session-abc.jsonl",
    );
    const mockJob = {
      id: "job-resume-trello",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      job_id: "parent-dispatch-uuid",
      task: "Continue trello work",
      api_token: "tok-123",
      allow_tools: ["Read", "mcp__trello__*"],
    });
    const res = createMockRes();

    await handleResume(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    const spawnOpts = mockSpawnAgent.mock.calls[0][0];
    expect(spawnOpts.allowedTools).toEqual(
      expect.arrayContaining([
        "Read",
        expect.stringMatching(/^mcp__trello__/),
        "mcp__danxbot__danxbot_complete",
      ]),
    );
    const settings = mockSettingsRead(spawnOpts);
    expect(Object.keys(settings.mcpServers).sort()).toEqual([
      "danxbot",
      "trello",
    ]);
  });
});

describe("handleStatus", () => {
  it("returns 404 for unknown job", () => {
    const res = createMockRes();

    handleStatus(res, "nonexistent-job");

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody())).toEqual({ error: "Job not found" });
  });

  it("returns job status for active job", async () => {
    const mockJob = {
      id: "job-status-test",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);
    mockGetJobStatus.mockReturnValue({
      id: "job-status-test",
      status: "running",
    });

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);

    // Use the stable dispatchId returned from launch, not the internal job id
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const res = createMockRes();
    handleStatus(res, dispatchId);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      id: "job-status-test",
      status: "running",
    });
  });

  it("passes token usage fields from getJobStatus straight through to the HTTP body", async () => {
    const mockJob = {
      id: "job-tokens",
      status: "completed",
      summary: "done",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);
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

    const launchReq = createMockReqWithBody("POST", {
      task: "Tokens pass-through",
      api_token: "tok-xyz",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const res = createMockRes();
    handleStatus(res, dispatchId);

    const body = JSON.parse(res._getBody());
    expect(body).toMatchObject({
      input_tokens: 300,
      output_tokens: 130,
      cache_read_input_tokens: 1024,
      cache_creation_input_tokens: 2048,
    });
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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const cancelReq = createMockReqWithBody("POST", { api_token: "tok-123" });
    const cancelRes = createMockRes();
    await handleCancel(cancelReq, cancelRes, dispatchId);

    expect(cancelRes._getStatusCode()).toBe(409);
  });

  it("returns 200 on successful cancel", async () => {
    const mockJob = {
      id: "job-to-cancel",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);
    mockCancelJob.mockResolvedValue(undefined);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const cancelReq = createMockReqWithBody("POST", {
      api_token: "tok-cancel",
    });
    const cancelRes = createMockRes();
    await handleCancel(cancelReq, cancelRes, dispatchId);

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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

    expect(stopRes._getStatusCode()).toBe(409);
  });

  it("returns 500 when job has no stop method", async () => {
    const mockJob = {
      id: "job-no-stop",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {
      status: "completed",
      summary: "All done",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", { status: null });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", { status: "" });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {});
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {
      status: "failed",
      summary: "Something went wrong",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {
      status: "critical_failure",
      summary: "MCP server failed to load Trello tools",
    });
    const stopRes = createMockRes();
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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {
      status: "critical_failure",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

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
    mockSpawnAgent.mockResolvedValue(mockJob);

    const launchReq = createMockReqWithBody("POST", {
      task: "Test task",
      api_token: "tok-123",
      allow_tools: [],
    });
    const launchRes = createMockRes();
    await handleLaunch(launchReq, launchRes, MOCK_REPO);
    const dispatchId = JSON.parse(launchRes._getBody()).job_id;

    const stopReq = createMockReqWithBody("POST", {
      status: "bogus",
      summary: "whatever",
    });
    const stopRes = createMockRes();
    await handleStop(stopReq, stopRes, dispatchId, MOCK_REPO);

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

  it("calls clearInterval for each interval registered by handleLaunch", async () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const job1 = {
      id: "job-ci-1",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    const job2 = {
      id: "job-ci-2",
      status: "running",
      summary: "",
      startedAt: new Date(),
    };
    mockSpawnAgent.mockResolvedValueOnce(job1).mockResolvedValueOnce(job2);

    const req1 = createMockReqWithBody("POST", {
      task: "Task 1",
      api_token: "tok-1",
      allow_tools: [],
    });
    const res1 = createMockRes();
    await handleLaunch(req1, res1, MOCK_REPO);

    const req2 = createMockReqWithBody("POST", {
      task: "Task 2",
      api_token: "tok-2",
      allow_tools: [],
    });
    const res2 = createMockRes();
    await handleLaunch(req2, res2, MOCK_REPO);

    clearIntervalSpy.mockClear();
    clearJobCleanupIntervals();

    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    clearIntervalSpy.mockClear();
    clearJobCleanupIntervals();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });
});

describe("handleLaunch — stall detection (host mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchConfig.isHost = false;
  });

  afterEach(() => {
    mockDispatchConfig.isHost = false;
  });

  function makeMockWatcher() {
    return {
      getEntries: vi.fn().mockReturnValue([]),
      onEntry: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }

  it("starts TerminalOutputWatcher and StallDetector when isHost + statusUrl + watcher present", async () => {
    mockDispatchConfig.isHost = true;

    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-stall-test",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-stall-test.log",
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: [],
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(mockTerminalOutputWatcherCtor).toHaveBeenCalledWith(
      "/tmp/danxbot-terminal-job-stall-test.log",
    );
    expect(mockTerminalWatcherStart).toHaveBeenCalled();
    expect(mockStallDetectorCtor).toHaveBeenCalled();
    expect(mockStallDetectorStart).toHaveBeenCalled();
  });

  it("does not start stall detection when statusUrl is absent", async () => {
    mockDispatchConfig.isHost = true;

    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-no-stall",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-no-stall.log",
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: [],
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockTerminalOutputWatcherCtor).not.toHaveBeenCalled();
    expect(mockStallDetectorCtor).not.toHaveBeenCalled();
  });

  it("does not start stall detection when job.terminalLogPath is absent", async () => {
    mockDispatchConfig.isHost = true;

    const mockJob = {
      id: "job-no-log",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: makeMockWatcher(),
      terminalLogPath: undefined,
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: [],
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockTerminalOutputWatcherCtor).not.toHaveBeenCalled();
    expect(mockStallDetectorCtor).not.toHaveBeenCalled();
  });

  it("stall detection cleanup is wired into job._cleanup", async () => {
    mockDispatchConfig.isHost = true;

    const originalCleanup = vi.fn();
    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-cleanup-test",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-cleanup-test.log",
      _cleanup: originalCleanup,
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: [],
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    // Trigger the wrapped cleanup
    mockJob._cleanup();

    expect(mockTerminalWatcherStop).toHaveBeenCalled();
    expect(mockStallDetectorStop).toHaveBeenCalled();
    expect(originalCleanup).toHaveBeenCalled();
  });

  it("does not start stall detection when isHost is false (even with statusUrl + watcher + terminalLogPath)", async () => {
    // isHost is false (set in beforeEach) — stall detection must not activate
    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-docker-mode",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-docker-mode.log",
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: [],
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockTerminalOutputWatcherCtor).not.toHaveBeenCalled();
    expect(mockStallDetectorCtor).not.toHaveBeenCalled();
  });

  it("does not start stall detection when job.watcher is absent", async () => {
    mockDispatchConfig.isHost = true;

    const mockJob = {
      id: "job-no-watcher",
      status: "running",
      summary: "",
      startedAt: new Date(),
      watcher: undefined, // no watcher
      terminalLogPath: "/tmp/danxbot-terminal-job-no-watcher.log",
      _cleanup: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: [],
      status_url: "http://example.com/status",
    });
    const res = createMockRes();

    await handleLaunch(req, res, MOCK_REPO);

    expect(mockTerminalOutputWatcherCtor).not.toHaveBeenCalled();
    expect(mockStallDetectorCtor).not.toHaveBeenCalled();
  });

  it("onStall callback: skips when the current job is no longer running", async () => {
    mockDispatchConfig.isHost = true;

    const mockWatcher = makeMockWatcher();
    const mockJob = {
      id: "job-already-done",
      status: "completed" as const, // already done when onStall fires
      summary: "Done",
      startedAt: new Date(),
      completedAt: new Date(),
      watcher: mockWatcher,
      terminalLogPath: "/tmp/danxbot-terminal-job-already-done.log",
      _cleanup: vi.fn(),
      stop: vi.fn(),
    };
    mockSpawnAgent.mockResolvedValue(mockJob);

    const req = createMockReqWithBody("POST", {
      task: "Do something",
      api_token: "tok-123",
      allow_tools: [],
      status_url: "http://example.com/status",
    });
    const res = createMockRes();
    await handleLaunch(req, res, MOCK_REPO);

    // Extract the onStall callback from the StallDetector constructor args
    const stallDetectorArgs = mockStallDetectorCtor.mock.calls[0][0] as {
      onStall: () => Promise<void>;
    };
    const onStall = stallDetectorArgs.onStall;

    await onStall();

    // Since the job is not running, no stop and no respawn should occur
    expect(mockJob.stop).not.toHaveBeenCalled();
    // spawnAgent was called once initially; should not be called again
    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
  });

  it("onStall callback: kills and respawns with nudge prompt on first stall", async () => {
    mockDispatchConfig.isHost = true;
    vi.useFakeTimers();

    try {
      const mockKill = vi.fn();
      const mockWatcher = makeMockWatcher();
      const mockJob = {
        id: "job-stall-respawn",
        status: "running" as string,
        summary: "",
        startedAt: new Date(),
        watcher: mockWatcher,
        terminalLogPath: "/tmp/danxbot-terminal-job-stall-respawn.log",
        _cleanup: vi.fn(),
        process: { kill: mockKill },
      };
      const mockRespawnJob = {
        id: "job-respawn-new",
        status: "running" as string,
        summary: "",
        startedAt: new Date(),
        watcher: makeMockWatcher(),
        terminalLogPath: "/tmp/danxbot-terminal-job-respawn-new.log",
        _cleanup: vi.fn(),
      };
      mockSpawnAgent
        .mockResolvedValueOnce(mockJob)
        .mockResolvedValueOnce(mockRespawnJob);

      const req = createMockReqWithBody("POST", {
        task: "Build the feature",
        api_token: "tok-123",
        allow_tools: [],
        status_url: "http://example.com/status",
      });
      const res = createMockRes();
      await handleLaunch(req, res, MOCK_REPO);
      const dispatchId = JSON.parse(res._getBody()).job_id;

      const stallDetectorArgs = mockStallDetectorCtor.mock.calls[0][0] as {
        onStall: () => Promise<void>;
      };
      const onStall = stallDetectorArgs.onStall;

      // Start onStall (it awaits a 5s timer inside)
      const onStallPromise = onStall();
      // Advance past the 5-second kill wait
      await vi.advanceTimersByTimeAsync(6_000);
      await onStallPromise;

      // spawnAgent should have been called twice: initial + respawn
      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);

      // Respawn prompt should contain the original task
      const respawnOpts = mockSpawnAgent.mock.calls[1][0] as {
        prompt: string;
        jobId: string;
      };
      expect(respawnOpts.prompt).toContain("Build the feature");
      expect(respawnOpts.prompt).toContain("stall");

      // Respawn uses a DIFFERENT jobId from the dispatchId
      expect(respawnOpts.jobId).not.toBe(dispatchId);

      // Active job under dispatchId is now the respawned job
      const statusRes = createMockRes();
      mockGetJobStatus.mockReturnValue({ status: "running" });
      handleStatus(statusRes, dispatchId);
      expect(statusRes._getStatusCode()).toBe(200);

      // Phase 3 contract: stall recovery routes through terminateWithGrace —
      // regression-proof against anyone re-inlining `job.process.kill(...)`,
      // which would silently break host mode (no ChildProcess handle).
      expect(mockTerminateWithGrace).toHaveBeenCalledWith(
        expect.objectContaining({ id: "job-stall-respawn" }),
        5_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("onStall callback: kills via killAgentProcess when job has no ChildProcess (host mode)", async () => {
    // Simulates a host-mode job: process is undefined, claudePid is set.
    // Before Phase 3, stall recovery directly accessed job.process.kill,
    // which was a no-op for host jobs — this test locks that contract.
    mockDispatchConfig.isHost = true;
    vi.useFakeTimers();

    try {
      const mockWatcher = makeMockWatcher();
      const hostJob = {
        id: "host-stall-job",
        status: "running" as string,
        summary: "",
        startedAt: new Date(),
        watcher: mockWatcher,
        terminalLogPath: "/tmp/danxbot-terminal-host-stall-job.log",
        _cleanup: vi.fn(),
        // No `process` — host mode runs claude in a detached wt.exe tab.
        claudePid: 424_242,
      };
      const respawnJob = {
        id: "host-respawn",
        status: "running" as string,
        summary: "",
        startedAt: new Date(),
        watcher: makeMockWatcher(),
        terminalLogPath: "/tmp/danxbot-terminal-host-respawn.log",
        _cleanup: vi.fn(),
        claudePid: 424_243,
      };
      mockSpawnAgent
        .mockResolvedValueOnce(hostJob)
        .mockResolvedValueOnce(respawnJob);

      const req = createMockReqWithBody("POST", {
        task: "Host task",
        api_token: "tok-host",
        allow_tools: [],
        status_url: "http://example.com/status",
      });
      const res = createMockRes();
      await handleLaunch(req, res, MOCK_REPO);

      const stallArgs = mockStallDetectorCtor.mock.calls[0][0] as {
        onStall: () => Promise<void>;
      };
      const p = stallArgs.onStall();
      await vi.advanceTimersByTimeAsync(6_000);
      await p;

      // Host-mode stall recovery passes the host job (no .process handle)
      // through terminateWithGrace, which must be signature-agnostic.
      expect(mockTerminateWithGrace).toHaveBeenCalledWith(
        expect.objectContaining({ id: "host-stall-job", claudePid: 424_242 }),
        5_000,
      );
      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("onStall callback: marks job failed when MAX_STALL_RESUMES exhausted", async () => {
    mockDispatchConfig.isHost = true;
    vi.useFakeTimers();

    try {
      const mockStop = vi.fn().mockResolvedValue(undefined);

      function makeStallJob(id: string) {
        return {
          id,
          status: "running" as string,
          summary: "",
          startedAt: new Date(),
          watcher: makeMockWatcher(),
          terminalLogPath: `/tmp/danxbot-terminal-${id}.log`,
          _cleanup: vi.fn(),
          process: { kill: vi.fn() },
          stop: mockStop,
        };
      }

      const job0 = makeStallJob("job-max-0");
      const job1 = makeStallJob("job-max-1");
      const job2 = makeStallJob("job-max-2");
      // Only 3 total spawns: initial + 2 respawns (3rd stall → mark failed, no respawn)
      mockSpawnAgent
        .mockResolvedValueOnce(job0)
        .mockResolvedValueOnce(job1)
        .mockResolvedValueOnce(job2);

      const req = createMockReqWithBody("POST", {
        task: "Long task",
        api_token: "tok-123",
        allow_tools: [],
        status_url: "http://example.com/status",
      });
      const res = createMockRes();
      await handleLaunch(req, res, MOCK_REPO);

      // Helper: fire onStall from the nth StallDetector (0-indexed) and advance past kill wait
      async function fireStall(detectorIndex: number): Promise<void> {
        const args = mockStallDetectorCtor.mock.calls[detectorIndex][0] as {
          onStall: () => Promise<void>;
        };
        const promise = args.onStall();
        await vi.advanceTimersByTimeAsync(6_000);
        await promise;
      }

      // Resume 1 (resumeCount 0→1, < 3): kill + respawn
      await fireStall(0);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);

      // Resume 2 (resumeCount 1→2, < 3): kill + respawn
      await fireStall(1);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(3);

      // Resume 3 (resumeCount 2→3, >= 3): mark failed, NO respawn
      await fireStall(2);
      expect(mockSpawnAgent).toHaveBeenCalledTimes(3); // still 3 — no 4th spawn
      expect(mockStop).toHaveBeenCalledWith(
        "failed",
        expect.stringContaining("stall"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
