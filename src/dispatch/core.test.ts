/**
 * Integration tests for `dispatch()` — the unified dispatch core introduced
 * in Phase 2 of Trello card XCptaJ34. These tests cover the boundary between
 * the caller-facing `DispatchInput` and what ships to claude:
 *
 *   - the on-disk MCP settings file (`--mcp-config <path>`) contents
 *   - the `--allowed-tools` CLI flag contents
 *   - the infrastructure invariants (danxbot always present, stopUrl wired)
 *
 * `spawnAgent` is mocked so we can capture the flag set without actually
 * spawning claude. The settings file is written for real (to a temp dir) —
 * reading it back is the observable boundary that downstream claude would
 * see, which is exactly what we want to assert.
 *
 * Card ACs covered:
 *   - AC: INTEGRATION — fake-claude test that the exact --mcp-config file
 *     contents and --allowed-tools CLI args are asserted against a snapshot
 *     for 3 representative allow_tools inputs (empty, trello-only, schema+bash)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { buildClaudeInvocation } from "../agent/claude-invocation.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";

const mockSpawnAgent = vi.fn();

vi.mock("../agent/launcher.js", async () => {
  const actual = await vi.importActual<
    typeof import("../agent/launcher.js")
  >("../agent/launcher.js");
  return {
    ...actual,
    spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  };
});

vi.mock("../config.js", () => ({
  config: {
    isHost: false,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 3600000,
    },
    logsDir: "/tmp/danxbot-dispatch-core-logs",
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../dashboard/dispatches-db.js", () => ({
  updateDispatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../agent/terminal-output-watcher.js", () => ({
  TerminalOutputWatcher: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock("../agent/stall-detector.js", () => ({
  StallDetector: class {
    start = vi.fn();
    stop = vi.fn();
  },
  DEFAULT_MAX_NUDGES: 3,
}));

import { dispatch, getActiveJob } from "./core.js";
// The mocked `../config.js` module exposes a plain mutable object. The cast
// to `{ isHost: boolean }` defeats the readonly type from the real config
// module — in the mocked factory, the object is a plain literal and writes
// are safe. Used by the `openTerminal` mirror / default tests.
import { config as realConfig } from "../config.js";
const mockedConfig = realConfig as unknown as { isHost: boolean };

const MOCK_REPO = makeRepoContext();
const DEFAULT_DISPATCH_META: DispatchTriggerMetadata = {
  trigger: "api",
  metadata: {
    endpoint: "/api/launch",
    callerIp: "127.0.0.1",
    statusUrl: null,
    initialPrompt: "test task",
  },
};

function makeRunningJob() {
  return {
    id: "mock-job-id",
    status: "running" as const,
    summary: "",
    startedAt: new Date(),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawnAgent.mockResolvedValue(makeRunningJob());
});

describe("dispatch() — settings file + allowed-tools plumbing", () => {
  it("writes a settings.json containing ONLY the danxbot server and emits --allowed-tools=mcp__danxbot__danxbot_complete when allow_tools is empty", async () => {
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    expect(Object.keys(settings.mcpServers)).toEqual(["danxbot"]);
    expect(opts.allowedTools).toEqual(["mcp__danxbot__danxbot_complete"]);
  });

  it("writes a settings.json with trello server + built-ins pass through to --allowed-tools when allow_tools requests trello tools", async () => {
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: ["Read", "mcp__trello__get_card", "mcp__trello__move_card"],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    expect(Object.keys(settings.mcpServers).sort()).toEqual([
      "danxbot",
      "trello",
    ]);
    expect(settings.mcpServers.trello.env.TRELLO_API_KEY).toBe(
      MOCK_REPO.trello.apiKey,
    );
    expect(settings.mcpServers.trello.env.TRELLO_BOARD_ID).toBe(
      MOCK_REPO.trello.boardId,
    );
    expect(opts.allowedTools).toEqual([
      "Read",
      "mcp__trello__get_card",
      "mcp__trello__move_card",
      "mcp__danxbot__danxbot_complete",
    ]);
  });

  it("writes a settings.json with schema server when allow_tools requests schema tools + Bash built-in (third representative input)", async () => {
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: ["Bash", "mcp__schema__schema_get", "mcp__schema__schema_update_model"],
      schemaDefinitionId: "42",
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    expect(Object.keys(settings.mcpServers).sort()).toEqual([
      "danxbot",
      "schema",
    ]);
    expect(settings.mcpServers.schema.env.SCHEMA_API_URL).toBe("http://api");
    expect(settings.mcpServers.schema.env.SCHEMA_API_TOKEN).toBe("tok");
    expect(settings.mcpServers.schema.env.SCHEMA_DEFINITION_ID).toBe("42");
    expect(opts.allowedTools).toEqual([
      "Bash",
      "mcp__schema__schema_get",
      "mcp__schema__schema_update_model",
      "mcp__danxbot__danxbot_complete",
    ]);
  });

  it("the danxbot server's env.DANXBOT_STOP_URL always points at the worker's /api/stop/<dispatchId>", async () => {
    const result = await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    expect(settings.mcpServers.danxbot.env.DANXBOT_STOP_URL).toBe(
      `http://localhost:${MOCK_REPO.workerPort}/api/stop/${result.dispatchId}`,
    );
  });

  it("forwards resumeSessionId + parentJobId through to spawnAgent when provided", async () => {
    await dispatch({
      repo: MOCK_REPO,
      task: "resume work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      resumeSessionId: "sess-uuid",
      parentJobId: "parent-uuid",
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.resumeSessionId).toBe("sess-uuid");
    expect(opts.parentJobId).toBe("parent-uuid");
  });

  it("passes title, agents, maxRuntimeMs, statusUrl through unchanged", async () => {
    const agents = { "my-agent": { description: "X", prompt: "..." } };
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      title: "AgentDispatch #AGD-1",
      agents,
      maxRuntimeMs: 120000,
      statusUrl: "http://status",
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.title).toBe("AgentDispatch #AGD-1");
    expect(opts.agents).toEqual(agents);
    expect(opts.maxRuntimeMs).toBe(120000);
    expect(opts.statusUrl).toBe("http://status");
  });

  it("registers the returned job in activeJobs under the stable dispatchId", async () => {
    const { dispatchId, job } = await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });
    expect(getActiveJob(dispatchId)).toBe(job);
  });
});

describe("dispatch() — error paths", () => {
  it("throws McpResolveError and writes NO settings file when allow_tools references an unknown server", async () => {
    await expect(
      dispatch({
        repo: MOCK_REPO,
        task: "do work",
        apiToken: "tok",
        apiUrl: "http://api",
        allowTools: ["mcp__totally_unknown_server__x"],
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      }),
    ).rejects.toThrow(/unknown MCP server/);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("throws McpResolveError when allow_tools asks for mcp__schema__* but schemaDefinitionId is missing", async () => {
    await expect(
      dispatch({
        repo: MOCK_REPO,
        task: "do work",
        apiToken: "tok",
        apiUrl: "http://api",
        allowTools: ["mcp__schema__schema_get"],
        // schemaDefinitionId intentionally omitted
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      }),
    ).rejects.toThrow(/definitionId|SCHEMA_DEFINITION_ID/);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

describe("buildClaudeInvocation — --allowed-tools flag wiring", () => {
  it("does NOT emit --allowed-tools when allowedTools is undefined (legacy path)", () => {
    const inv = buildClaudeInvocation({
      prompt: "p",
      jobId: "j",
    });
    expect(inv.flags).not.toContain("--allowed-tools");
  });

  it("does NOT emit --allowed-tools when allowedTools is an empty array", () => {
    const inv = buildClaudeInvocation({
      prompt: "p",
      jobId: "j",
      allowedTools: [],
    });
    expect(inv.flags).not.toContain("--allowed-tools");
  });

  it("emits --allowed-tools=<comma-joined> when allowedTools is non-empty", () => {
    const inv = buildClaudeInvocation({
      prompt: "p",
      jobId: "j",
      allowedTools: ["Read", "Bash", "mcp__danxbot__danxbot_complete"],
    });
    const idx = inv.flags.indexOf("--allowed-tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(inv.flags[idx + 1]).toBe(
      "Read,Bash,mcp__danxbot__danxbot_complete",
    );
  });

  it("emits --mcp-config and --allowed-tools together in the flag list when both are set (the unified dispatch shape)", () => {
    const inv = buildClaudeInvocation({
      prompt: "p",
      jobId: "j",
      mcpConfigPath: "/tmp/test/settings.json",
      allowedTools: ["Read", "mcp__trello__get_card"],
    });
    expect(inv.flags).toContain("--mcp-config");
    expect(inv.flags).toContain("/tmp/test/settings.json");
    expect(inv.flags).toContain("--allowed-tools");
    expect(inv.flags).toContain("Read,mcp__trello__get_card");
  });
});

describe("dispatch() — caller-supplied overrides (Phase 4 poller contract)", () => {
  it("honors input.timeoutMs override instead of the default agentTimeoutMs", async () => {
    // The poller supplies its own inactivity timeout (pollerIntervalMs * 60),
    // which differs from the HTTP default. dispatch() must forward it to
    // spawnAgent verbatim — if it hardcoded config.dispatch.agentTimeoutMs the
    // poller would silently get the wrong value.
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      timeoutMs: 123_456,
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    expect(mockSpawnAgent.mock.calls[0][0].timeoutMs).toBe(123_456);
  });

  it("falls back to config.dispatch.agentTimeoutMs when timeoutMs is omitted", async () => {
    // HTTP dispatch never sets timeoutMs — it relies on the global default.
    // Regression guard for the previous shape where the default was inlined
    // in dispatch() and a new input.timeoutMs would have been ignored.
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    expect(mockSpawnAgent.mock.calls[0][0].timeoutMs).toBe(3_600_000);
  });

  it("honors input.openTerminal=true override when config.isHost=false", async () => {
    // Mocked `config.isHost=false` (see vi.mock above). Override to true.
    // If the `??` default regressed to hardcoded `config.isHost`, spawnAgent
    // would see `false` and the assertion would fail.
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      openTerminal: true,
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    expect(mockSpawnAgent.mock.calls[0][0].openTerminal).toBe(true);
  });

  it("honors input.openTerminal=false override when config.isHost=true (mirror direction)", async () => {
    // Mirror of the previous test: flip config.isHost to true, then pass
    // `openTerminal:false`. Locks out the regression where someone replaces
    // `input.openTerminal ?? config.isHost` with `config.isHost` (ignoring
    // the input) — that regression would make spawnAgent see `true` here
    // and fail the assertion.
    mockedConfig.isHost = true;
    try {
      await dispatch({
        repo: MOCK_REPO,
        task: "do work",
        apiToken: "tok",
        apiUrl: "http://api",
        allowTools: [],
        openTerminal: false,
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      expect(mockSpawnAgent.mock.calls[0][0].openTerminal).toBe(false);
    } finally {
      mockedConfig.isHost = false;
    }
  });

  it("defaults openTerminal to config.isHost when the input omits it", async () => {
    // With the input omitting `openTerminal`, spawnAgent should receive
    // whatever config.isHost is set to. Flip isHost to true, omit the
    // input, assert true. A regression that hardcoded `false` or dropped
    // the fallback entirely would fail this.
    mockedConfig.isHost = true;
    try {
      await dispatch({
        repo: MOCK_REPO,
        task: "do work",
        apiToken: "tok",
        apiUrl: "http://api",
        allowTools: [],
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      expect(mockSpawnAgent.mock.calls[0][0].openTerminal).toBe(true);
    } finally {
      mockedConfig.isHost = false;
    }
  });

  it("always injects DANXBOT_REPO_NAME from input.repo.name, even when input.env is omitted", async () => {
    // Dispatch-level invariant: every spawned agent has DANXBOT_REPO_NAME
    // set from `input.repo.name`. Callers (poller, HTTP, Slack) never need
    // to restate the invariant. Locks out the regression where dispatch()
    // passes env:undefined through verbatim.
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    expect(mockSpawnAgent.mock.calls[0][0].env).toEqual({
      DANXBOT_REPO_NAME: MOCK_REPO.name,
    });
  });

  it("merges caller-supplied input.env on top of the auto-injected DANXBOT_REPO_NAME", async () => {
    // A caller that needs extra env vars (tests, future integrations) can
    // pass them via input.env. They merge ON TOP of the injected invariants,
    // so tests can override DANXBOT_REPO_NAME for isolation.
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      env: { DANXBOT_REPO_NAME: "override-repo", FOO: "bar" },
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    expect(mockSpawnAgent.mock.calls[0][0].env).toEqual({
      DANXBOT_REPO_NAME: "override-repo", // input.env wins
      FOO: "bar",
    });
  });

  it("chains input.onComplete AFTER cleanupMcpSettings so callers observe a disposed slot", async () => {
    // Poller's handleAgentCompletion runs card-progress checks on completion.
    // If onComplete fired BEFORE the MCP settings dir was cleaned, a race
    // could surface a half-torn-down dispatch to the next poll tick. The
    // ordering contract: cleanup FIRST, caller onComplete SECOND.
    const observedOrder: string[] = [];
    let capturedSettingsPath: string | undefined;
    let capturedInnerOnComplete:
      | ((j: { id: string }) => void)
      | undefined;
    mockSpawnAgent.mockImplementation(async (options) => {
      capturedSettingsPath = options.mcpConfigPath;
      capturedInnerOnComplete = options.onComplete;
      return makeRunningJob();
    });

    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      onComplete: () => {
        observedOrder.push("caller-onComplete");
        // At this point the settings dir must already be gone.
        expect(existsSync(capturedSettingsPath!)).toBe(false);
      },
    });

    // Sanity: settings file exists at this point (spawn happened, completion
    // hasn't fired yet).
    expect(existsSync(capturedSettingsPath!)).toBe(true);

    // Now simulate the agent's terminal state firing onComplete. This is the
    // chained lambda dispatch() wires around the caller's onComplete.
    capturedInnerOnComplete!({ id: "fake-job" });

    expect(observedOrder).toEqual(["caller-onComplete"]);
    expect(existsSync(capturedSettingsPath!)).toBe(false);
  });

  it("onComplete is optional — dispatch() works without a caller callback", async () => {
    // HTTP `/api/launch` never supplies onComplete (the stop endpoint
    // finalizes the row instead). Regression guard: the chained lambda must
    // not call `input.onComplete` when it's undefined.
    mockSpawnAgent.mockImplementation(async (options) => {
      // Fire the internal onComplete immediately; would throw on `input.onComplete(...)`
      // if the ?. guard regressed.
      options.onComplete?.({ id: "j" });
      return makeRunningJob();
    });

    await expect(
      dispatch({
        repo: MOCK_REPO,
        task: "do work",
        apiToken: "tok",
        apiUrl: "http://api",
        allowTools: [],
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      }),
    ).resolves.toBeDefined();
  });

  it("suppresses eventForwarding when statusUrl is set but apiToken is absent (no bearer → no PUTs)", async () => {
    // Poller-style dispatches may eventually want to emit status events
    // without talking to Laravel. Without an apiToken the Laravel PUT is
    // guaranteed to 401, so dispatch() drops the forwarding rather than
    // wiring a doomed loop.
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiUrl: "http://api",
      allowTools: [],
      statusUrl: "http://status",
      // apiToken intentionally omitted
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    expect(mockSpawnAgent.mock.calls[0][0].eventForwarding).toBeUndefined();
  });
});

describe("dispatch() — per-dispatch settings-file lifecycle", () => {
  it("writes the settings file to a fresh temp directory that actually exists on disk", async () => {
    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });
    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(existsSync(opts.mcpConfigPath)).toBe(true);
    // The path shape matches the `danxbot-mcp-` prefix the core uses.
    expect(opts.mcpConfigPath).toMatch(/danxbot-mcp-[^/]+[/\\]settings\.json$/);
  });

  it("wires the onComplete cleanup so settings dir gets removed when the agent terminates", async () => {
    mockSpawnAgent.mockImplementation(async (options) => {
      // Immediately fire the onComplete hook (simulating a very-fast agent)
      options.onComplete?.({ id: "x" });
      return makeRunningJob();
    });

    await dispatch({
      repo: MOCK_REPO,
      task: "do work",
      apiToken: "tok",
      apiUrl: "http://api",
      allowTools: [],
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });
    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(existsSync(opts.mcpConfigPath)).toBe(false);
  });

  it("removes the settings dir from disk when spawnAgent throws (guards the spawn-failure catch)", async () => {
    // Capture the settings path from the first spawnAgent arg BEFORE the
    // throw — once dispatch() rejects, there's no return value to pull it
    // from. The catch in core.ts's spawnForDispatch() must rmSync the
    // settings dir to avoid leaking /tmp/danxbot-mcp-* on every broken spawn.
    let capturedPath: string | undefined;
    mockSpawnAgent.mockImplementation(async (options) => {
      capturedPath = options.mcpConfigPath;
      // The probe-time invariant: settings file already exists on disk.
      expect(existsSync(capturedPath!)).toBe(true);
      throw new Error("simulated MCP probe failure");
    });

    await expect(
      dispatch({
        repo: MOCK_REPO,
        task: "do work",
        apiToken: "tok",
        apiUrl: "http://api",
        allowTools: [],
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      }),
    ).rejects.toThrow(/simulated MCP probe failure/);

    expect(capturedPath).toBeDefined();
    expect(existsSync(capturedPath!)).toBe(false);
  });
});
