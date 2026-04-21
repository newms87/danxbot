import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../config.js", () => ({
  config: {
    logsDir: "/tmp/danxbot-test-logs",
    dispatch: {
      mcpProbeTimeoutMs: 3_000,
    },
  },
}));

vi.mock("../poller/constants.js", () => ({
  getReposBase: () => "/danxbot/repos",
}));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdtempSync = vi.fn().mockReturnValue("/tmp/danxbot-mcp-test");
const mockRmSync = vi.fn();
vi.mock("node:fs", () => ({
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

// Mock SessionLogWatcher — capture onEntry callbacks so tests can emit entries
const mockWatcherEntryCallbacks: Array<(entry: unknown) => void> = [];
vi.mock("./session-log-watcher.js", () => ({
  SessionLogWatcher: class {
    onEntry = vi.fn((cb: (entry: unknown) => void) => {
      mockWatcherEntryCallbacks.push(cb);
    });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
  },
  DISPATCH_TAG_PREFIX: "<!-- danxbot-dispatch:",
}));

// Mock the MCP probe so launcher tests never spawn real subprocesses. Default
// to a healthy response; individual tests override via mockResolvedValueOnce.
const mockProbeAllMcpServers = vi.fn().mockResolvedValue({
  ok: true,
  failures: [],
});
vi.mock("./mcp-server-probe.js", () => ({
  probeAllMcpServers: (...args: unknown[]) => mockProbeAllMcpServers(...args),
}));

vi.mock("./laravel-forwarder.js", () => ({
  createLaravelForwarder: vi.fn().mockReturnValue({
    consume: vi.fn(),
    flush: vi.fn(),
  }),
  deriveEventsUrl: vi.fn((url: string) => url.replace(/\/status$/, "/events")),
}));

const mockBuildDispatchScript = vi
  .fn()
  .mockReturnValue("/tmp/danxbot-term-test/run-agent.sh");
const mockGetTerminalLogPath = vi
  .fn()
  .mockReturnValue("/tmp/danxbot-terminal-test-uuid-1234.log");
const mockSpawnInTerminal = vi.fn();
vi.mock("../terminal.js", () => ({
  buildDispatchScript: (...args: unknown[]) => mockBuildDispatchScript(...args),
  getTerminalLogPath: (...args: unknown[]) => mockGetTerminalLogPath(...args),
  spawnInTerminal: (...args: unknown[]) => mockSpawnInTerminal(...args),
}));

// Host-mode PID tracking — mocked at the module boundary so launcher unit
// tests don't touch the real filesystem or call process.kill.
const mockReadPidFileWithTimeout = vi.fn();
const mockHostExitWatchers: Array<{
  onExit: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  fire: () => void;
}> = [];
const mockCreateHostExitWatcher = vi.fn().mockImplementation(() => {
  const callbacks: Array<() => void> = [];
  const watcher = {
    onExit: vi.fn((cb: () => void) => {
      callbacks.push(cb);
    }),
    stop: vi.fn(),
    fire: () => {
      for (const cb of callbacks) cb();
      callbacks.length = 0;
    },
  };
  mockHostExitWatchers.push(watcher);
  return watcher;
});
const mockIsPidAlive = vi.fn().mockReturnValue(true);
const mockKillHostPid = vi.fn();
vi.mock("./host-pid.js", () => ({
  readPidFileWithTimeout: (...args: unknown[]) =>
    mockReadPidFileWithTimeout(...args),
  createHostExitWatcher: (...args: unknown[]) =>
    mockCreateHostExitWatcher(...args),
  isPidAlive: (...args: unknown[]) => mockIsPidAlive(...args),
  killHostPid: (...args: unknown[]) => mockKillHostPid(...args),
}));

import {
  spawnAgent,
  cancelJob,
  getJobStatus,
  type AgentJob,
} from "./launcher.js";

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

function emitWatcherEntry(entry: Record<string, unknown>): void {
  for (const cb of mockWatcherEntryCallbacks) {
    cb(entry);
  }
}

describe("spawnAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWatcherEntryCallbacks.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns claude CLI with shared flags and firstMessage referencing prompt.md", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "--dangerously-skip-permissions",
        "--verbose",
        "-p",
        expect.stringContaining("<!-- danxbot-dispatch:test-uuid-1234 -->"),
      ]),
      expect.objectContaining({
        cwd: "/danxbot/repos/platform",
        stdio: ["ignore", "ignore", "pipe"],
      }),
    );

    // firstMessage (the -p value) is the Read directive, NOT the original
    // prompt text. The original prompt is written verbatim to prompt.md.
    const args = mockSpawn.mock.calls[0][1] as string[];
    const promptArg = args[args.indexOf("-p") + 1];
    expect(promptArg).toContain("<!-- danxbot-dispatch:test-uuid-1234 -->");
    expect(promptArg).toContain("Read ");
    expect(promptArg).toContain(
      "/prompt.md and execute the task described in it.",
    );
    expect(promptArg).not.toContain("/danx-next");

    // Original prompt body lands in prompt.md — writeFileSync receives it.
    const promptWrite = mockWriteFileSync.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" && (c[0] as string).endsWith("prompt.md"),
    );
    expect(promptWrite).toBeDefined();
    expect(promptWrite![1]).toBe("/danx-next");
  });

  it("does NOT pass --output-format stream-json — watcher is the monitoring source", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("stream-json");
  });

  it("sets stdio stdout to 'ignore' — no stdout plumbing, watcher-only monitoring", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const spawnOpts = mockSpawn.mock.calls[0][2] as { stdio: unknown[] };
    expect(spawnOpts.stdio[0]).toBe("ignore");
    expect(spawnOpts.stdio[1]).toBe("ignore");
    expect(spawnOpts.stdio[2]).toBe("pipe");
  });

  it("does not register a stdout 'data' listener — stdout is 'ignore'", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // The mock child still has a stdout EventEmitter, but the launcher must
    // not attach any 'data' listener to it when stdout is ignored.
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("inactivity timer is fully decoupled from stdout — phantom stdout data cannot reset it", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    // Pump stdout data continuously — if any vestigial listener existed, the
    // timer would reset and the job would never time out.
    for (let i = 0; i < 12; i++) {
      child.stdout.emit("data", Buffer.from("phantom output\n"));
      await vi.advanceTimersByTimeAsync(5_500);
    }

    expect(job.status).toBe("timeout");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does NOT include --mcp-config when not set", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--mcp-config");
  });

  it("includes --mcp-config when mcpConfigPath is set", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      mcpConfigPath: "/tmp/mcp/settings.json",
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/mcp/settings.json");
  });

  // Regression: the agents payload must reach the CLI when given as an object
  // keyed by agent name (Claude CLI's required shape). See
  // `.claude/rules/agent-dispatch.md`.
  it("passes --agents <json> to claude CLI when agents is a non-empty object", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const agents = {
      "template-builder": { description: "Builds templates", prompt: "..." },
      "schema-builder": { description: "Builds schemas", prompt: "..." },
    };

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      agents,
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    const flagIdx = args.indexOf("--agents");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(args[flagIdx + 1]).toBe(JSON.stringify(agents));
  });

  it("omits --agents when agents object is empty", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      agents: {},
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--agents");
  });

  it("omits --agents when agents is undefined", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--agents");
  });

  it("strips CLAUDECODE env vars from spawned process", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    process.env.CLAUDECODE_SESSION = "should-be-removed";

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv).not.toHaveProperty("CLAUDECODE_SESSION");

    delete process.env.CLAUDECODE_SESSION;
  });

  it("returns an AgentJob with running status", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    expect(job.id).toBe("test-uuid-1234");
    expect(job.status).toBe("running");
    expect(job.process).toBe(child);
  });

  it("sets job status to completed on clean exit", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    child.emit("close", 0);

    expect(job.status).toBe("completed");
    expect(job.completedAt).toBeInstanceOf(Date);
  });

  it("sets job status to failed on non-zero exit", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    child.emit("close", 1);

    expect(job.status).toBe("failed");
    expect(job.completedAt).toBeInstanceOf(Date);
  });

  it("sets job status to failed on process error", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    child.emit("error", new Error("ENOENT"));

    expect(job.status).toBe("failed");
    expect(job.summary).toContain("ENOENT");
  });

  it("kills process on inactivity timeout", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(job.status).toBe("timeout");
  });

  it("sends timeout status PUT when inactivity fires with statusUrl", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
      statusUrl: "http://example.com/status",
      apiToken: "tok-inactivity",
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(job.status).toBe("timeout");
    const timeoutCall = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[1] === "object" && c[1] !== null
        && typeof (c[1] as { body?: unknown }).body === "string"
        && ((c[1] as { body: string }).body).includes('"timeout"'),
    );
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall![0]).toBe("http://example.com/status");
    const body = JSON.parse((timeoutCall![1] as { body: string }).body);
    expect(body.status).toBe("timeout");
    expect(body.message).toContain("seconds of inactivity");
    expect(
      (timeoutCall![1] as { headers: Record<string, string> }).headers.Authorization,
    ).toBe("Bearer tok-inactivity");
  });

  it("does NOT issue a timeout PUT when statusUrl is set but apiToken is missing", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
      statusUrl: "http://example.com/status",
      // apiToken intentionally omitted — guard must keep us from PUT'ing
      // with a missing Bearer token
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(job.status).toBe("timeout");
    const anyTimeoutPut = mockFetch.mock.calls.some(
      (c: unknown[]) => typeof c[1] === "object" && c[1] !== null
        && typeof (c[1] as { body?: unknown }).body === "string"
        && ((c[1] as { body: string }).body).includes('"timeout"'),
    );
    expect(anyTimeoutPut).toBe(false);
  });

  it("retries the terminal timeout PUT on a transient failure", async () => {
    // Fail only the FIRST terminal "timeout" PUT — let heartbeat PUTs and
    // subsequent terminal retries succeed. This pins the retry contract in
    // putStatus (TERMINAL_STATUS_RETRIES=3, TERMINAL_STATUS_RETRY_DELAY_MS=2000)
    // specifically for the timeout status; without conditioning on body the
    // heartbeat PUTs would consume the failure and bypass the retry path.
    let rejectedOnce = false;
    mockFetch.mockImplementation(async (_url: string, init: unknown) => {
      const body = (init as { body?: string })?.body ?? "";
      if (body.includes('"timeout"') && !rejectedOnce) {
        rejectedOnce = true;
        return { ok: false, status: 502 };
      }
      return { ok: true };
    });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
      statusUrl: "http://example.com/status",
      apiToken: "tok-retry",
    });

    await vi.advanceTimersByTimeAsync(61_000);
    // Advance past the 2s terminal retry backoff so the second attempt fires
    await vi.advanceTimersByTimeAsync(2_100);

    expect(job.status).toBe("timeout");
    const timeoutCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[1] === "object" && c[1] !== null
        && typeof (c[1] as { body?: unknown }).body === "string"
        && ((c[1] as { body: string }).body).includes('"timeout"'),
    );
    expect(timeoutCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops heartbeat PUTs after inactivity timeout fires", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
      statusUrl: "http://example.com/status",
      apiToken: "tok-heartbeat",
    });

    await vi.advanceTimersByTimeAsync(61_000);
    const callsAtTimeout = mockFetch.mock.calls.length;

    // Advance another 30s — no heartbeat PUT should fire because stopHeartbeat
    // ran inside cleanup() before the terminal putStatus. A regression that
    // flipped the order or dropped stopHeartbeat would cause new "running"
    // PUTs to appear here.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockFetch.mock.calls.length).toBe(callsAtTimeout);
  });

  it("resets inactivity timeout on watcher entries", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    // Advance 50s (not past timeout)
    await vi.advanceTimersByTimeAsync(50_000);

    // Emit a watcher entry — should reset the timer
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "test",
      data: { content: [{ type: "text", text: "working..." }] },
    });

    // Advance another 50s (would be 100s total without reset)
    await vi.advanceTimersByTimeAsync(50_000);

    // Should still be running because timeout was reset by watcher entry
    expect(job.status).toBe("running");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("extracts last assistant text from watcher entries as job summary", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // Emit watcher entries with assistant text
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "test",
      data: {
        content: [{ type: "text", text: "Task completed successfully" }],
      },
    });

    child.emit("close", 0);

    expect(job.status).toBe("completed");
    expect(job.summary).toBe("Task completed successfully");
  });

  it("accumulates usage tokens across every assistant entry", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // Claude Code writes one assistant entry per model turn; each carries its
    // own per-turn usage. Total = sum across entries — verified empirically
    // against a real JSONL during card #57 validation.
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: {
        content: [],
        usage: {
          input_tokens: 6,
          output_tokens: 221,
          cache_read_input_tokens: 18599,
          cache_creation_input_tokens: 45182,
        },
      },
    });
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: {
        content: [],
        usage: {
          input_tokens: 1,
          output_tokens: 84,
          cache_read_input_tokens: 63781,
          cache_creation_input_tokens: 445,
        },
      },
    });

    expect(job.usage).toEqual({
      input_tokens: 7,
      output_tokens: 305,
      cache_read_input_tokens: 82380,
      cache_creation_input_tokens: 45627,
    });
  });

  it("treats missing usage fields as 0 and ignores non-assistant entries", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // Assistant entry with no usage at all (e.g. partial / malformed)
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: { content: [] },
    });
    // Assistant entry with only input_tokens set — other three should default to 0
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: { content: [], usage: { input_tokens: 10 } },
    });
    // Non-assistant entry — must not contribute
    emitWatcherEntry({
      type: "user",
      timestamp: Date.now(),
      summary: "",
      data: {
        content: [{ type: "tool_result", content: "ok" }],
        usage: { input_tokens: 99999 },
      },
    });

    expect(job.usage).toEqual({
      input_tokens: 10,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("getJobStatus surfaces the four summed token fields", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: {
        content: [],
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_read_input_tokens: 56,
          cache_creation_input_tokens: 78,
        },
      },
    });

    const status = getJobStatus(job);
    expect(status).toMatchObject({
      job_id: job.id,
      status: "running",
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 56,
      cache_creation_input_tokens: 78,
    });
  });

  it("getJobStatus reports zero tokens for a freshly spawned job", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    expect(getJobStatus(job)).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("getJobStatus preserves token totals after the job completes", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: {
        content: [],
        usage: {
          input_tokens: 5,
          output_tokens: 50,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 5000,
        },
      },
    });

    child.emit("close", 0);

    const status = getJobStatus(job);
    expect(status).toMatchObject({
      status: "completed",
      input_tokens: 5,
      output_tokens: 50,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 5000,
    });
    expect(status.completed_at).not.toBeNull();
  });

  it("getJobStatus preserves token totals after cancelJob", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    mockFetch.mockResolvedValue({ ok: true });

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: {
        content: [],
        usage: {
          input_tokens: 7,
          output_tokens: 13,
          cache_read_input_tokens: 42,
          cache_creation_input_tokens: 91,
        },
      },
    });

    // Wire SIGTERM → child close so cancelJob's grace-wait resolves immediately.
    child.kill = vi.fn().mockImplementation((sig: string) => {
      if (sig === "SIGTERM") child.emit("close", 143);
    });

    const cancelPromise = cancelJob(job, "tok");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    expect(getJobStatus(job)).toMatchObject({
      status: "canceled",
      input_tokens: 7,
      output_tokens: 13,
      cache_read_input_tokens: 42,
      cache_creation_input_tokens: 91,
    });
  });

  it("sums every partial-usage shape independently — each field is accumulated from its own source", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // Three entries, each missing a different subset of fields. If the
    // subscriber short-circuits on any field, these sums won't all match.
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: {
        content: [],
        usage: { output_tokens: 5, cache_read_input_tokens: 10 },
      },
    });
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: { content: [], usage: { cache_creation_input_tokens: 20 } },
    });
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: {
        content: [],
        usage: {
          input_tokens: 3,
          output_tokens: 7,
          cache_creation_input_tokens: 1,
        },
      },
    });

    expect(job.usage).toEqual({
      input_tokens: 3,
      output_tokens: 12,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 21,
    });
  });

  it("calls onComplete callback when job finishes", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    const onComplete = vi.fn();

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      onComplete,
    });

    child.emit("close", 0);

    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("calls onComplete callback on error", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    const onComplete = vi.fn();

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      onComplete,
    });

    child.emit("error", new Error("spawn failed"));

    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("calls onComplete callback on timeout", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    const onComplete = vi.fn();

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
      onComplete,
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(onComplete).toHaveBeenCalled();
  });

  it("passes additional env vars to spawned process", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      env: { DANXBOT_REPO_NAME: "platform", DANXBOT_EPHEMERAL: "1" },
    });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.DANXBOT_REPO_NAME).toBe("platform");
    expect(spawnEnv.DANXBOT_EPHEMERAL).toBe("1");
  });

  it("logs prompt to disk with dispatch tag", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("test-uuid-1234"),
      expect.objectContaining({ recursive: true }),
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("prompt.md"),
      expect.stringContaining("/danx-next"),
    );
  });

  it("includes stderr in failure summary", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    child.stderr.emit("data", Buffer.from("Error: permission denied"));
    child.emit("close", 1);

    expect(job.status).toBe("failed");
    expect(job.summary).toContain("permission denied");
  });

  it("prevents double status transition (close after timeout)", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(61_000);
    expect(job.status).toBe("timeout");

    child.emit("close", 0);
    expect(job.status).toBe("timeout");
  });

  it("does not fire timeout after close event", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    child.emit("close", 0);
    expect(job.status).toBe("completed");

    await vi.advanceTimersByTimeAsync(61_000);
    expect(job.status).toBe("completed");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills process on max runtime exceeded", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      maxRuntimeMs: 120_000,
    });

    // Keep activity going so inactivity doesn't trigger
    await vi.advanceTimersByTimeAsync(60_000);
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: { content: [] },
    });
    await vi.advanceTimersByTimeAsync(61_000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(job.status).toBe("timeout");
    expect(job.summary).toContain("max runtime");
  });

  it("sends timeout status PUT when max runtime fires with statusUrl", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      maxRuntimeMs: 120_000,
      statusUrl: "http://example.com/status",
      apiToken: "tok-max-runtime",
    });

    // Keep activity going so inactivity doesn't trigger first
    await vi.advanceTimersByTimeAsync(60_000);
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: { content: [] },
    });
    await vi.advanceTimersByTimeAsync(61_000);

    expect(job.status).toBe("timeout");
    const timeoutCall = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[1] === "object" && c[1] !== null
        && typeof (c[1] as { body?: unknown }).body === "string"
        && ((c[1] as { body: string }).body).includes('"timeout"'),
    );
    expect(timeoutCall).toBeDefined();
    const body = JSON.parse((timeoutCall![1] as { body: string }).body);
    expect(body.status).toBe("timeout");
    expect(body.message).toContain("max runtime");
    expect(
      (timeoutCall![1] as { headers: Record<string, string> }).headers.Authorization,
    ).toBe("Bearer tok-max-runtime");
  });

  it("job.stop is defined after spawn", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    expect(job.stop).toBeDefined();
  });

  it("stop sends SIGTERM and sets status to completed", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const stopPromise = job.stop!("completed", "All tasks done");

    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(job.status).toBe("completed");
    expect(job.summary).toBe("All tasks done");
    expect(job.completedAt).toBeInstanceOf(Date);
  });

  it("stop sends SIGTERM and sets status to failed", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const stopPromise = job.stop!("failed", "Agent encountered an error");

    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    expect(job.status).toBe("failed");
    expect(job.summary).toBe("Agent encountered an error");
  });

  it("stop sends SIGKILL after 5s if process still alive", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const stopPromise = job.stop!("completed");

    // At t=0, SIGTERM sent. At t=5s, check again.
    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    // SIGTERM at stop call, SIGKILL after 5s since mock doesn't exit
    const killCalls = child.kill.mock.calls.map((c: unknown[]) => c[0]);
    expect(killCalls).toContain("SIGTERM");
    expect(killCalls).toContain("SIGKILL");
  });

  it("stop is no-op when job is not running", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    child.emit("close", 0);
    expect(job.status).toBe("completed");

    // Calling stop on a completed job should be a no-op
    await job.stop!("failed");

    expect(job.status).toBe("completed");
  });

  it("stop calls onComplete callback", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    const onComplete = vi.fn();

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      onComplete,
    });

    const stopPromise = job.stop!("completed", "Done");

    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("stop does not trigger double onComplete after close event", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    const onComplete = vi.fn();

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      onComplete,
    });

    const stopPromise = job.stop!("completed", "Done");
    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    // Process finally closes after stop
    child.emit("close", 0);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("stop does not send SIGKILL when process exits within 5s", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const stopPromise = job.stop!("completed");

    // Simulate fast exit before the 5s wait completes
    child.emit("close", 0);

    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    const killCalls = child.kill.mock.calls.map((c: unknown[]) => c[0]);
    expect(killCalls).toContain("SIGTERM");
    expect(killCalls).not.toContain("SIGKILL");
  });

  it("stop preserves status set before close handler fires", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // Start stop (sets status to "completed" before kill)
    const stopPromise = job.stop!("completed", "All done");

    // Simulate close event firing (non-zero exit from SIGTERM)
    child.emit("close", 143);

    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    // Status should be "completed" (from stop), not "failed" (from close handler)
    expect(job.status).toBe("completed");
    expect(job.summary).toBe("All done");
  });

  it("stop calls putStatus when statusUrl and apiToken are set", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      statusUrl: "http://example.com/status",
      apiToken: "tok-abc",
    });

    const stopPromise = job.stop!("completed", "Done");
    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    expect(mockFetch).toHaveBeenCalledWith(
      "http://example.com/status",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer tok-abc",
        }),
      }),
    );
  });

  it("stop does not call fetch when statusUrl is not set", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const stopPromise = job.stop!("completed", "Done");
    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe("MCP server probe", () => {
    it("does NOT probe when mcpConfigPath is absent", async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child);

      await spawnAgent({
        prompt: "/danx-next",
        repoName: "platform",
        timeoutMs: 300_000,
      });

      expect(mockProbeAllMcpServers).not.toHaveBeenCalled();
    });

    it("probes the provided mcpConfigPath before spawning claude", async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child);

      await spawnAgent({
        prompt: "/danx-next",
        repoName: "platform",
        timeoutMs: 300_000,
        mcpConfigPath: "/tmp/mcp/settings.json",
      });

      expect(mockProbeAllMcpServers).toHaveBeenCalledWith(
        "/tmp/mcp/settings.json",
        expect.any(Number),
      );
      // Claude must run only after probe resolves healthy.
      expect(mockSpawn).toHaveBeenCalled();
      const probeOrder = mockProbeAllMcpServers.mock.invocationCallOrder[0];
      const spawnOrder = mockSpawn.mock.invocationCallOrder[0];
      expect(probeOrder).toBeLessThan(spawnOrder);
    });

    it("throws a named error listing the broken server when the probe fails", async () => {
      mockProbeAllMcpServers.mockResolvedValueOnce({
        ok: false,
        failures: [
          {
            ok: false,
            serverName: "schema",
            reason: "exit",
            exitCode: 1,
            stderr: "SCHEMA_DEFINITION_ID is required\n",
            message:
              'MCP server "schema" exited with code 1 before responding: SCHEMA_DEFINITION_ID is required',
          },
        ],
      });

      await expect(
        spawnAgent({
          prompt: "/danx-next",
          repoName: "platform",
          timeoutMs: 300_000,
          mcpConfigPath: "/tmp/mcp/settings.json",
        }),
      ).rejects.toThrow(/schema/);

      // Claude must NOT have been spawned when the probe fails — the whole
      // point is to fail before burning any API credits.
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("error message includes every broken server when multiple fail", async () => {
      mockProbeAllMcpServers.mockResolvedValueOnce({
        ok: false,
        failures: [
          {
            ok: false,
            serverName: "schema",
            reason: "exit",
            exitCode: 1,
            stderr: "",
            message: 'MCP server "schema" exited with code 1 before responding',
          },
          {
            ok: false,
            serverName: "danxbot",
            reason: "timeout",
            stderr: "",
            message: 'MCP server "danxbot" timeout: no response to initialize',
          },
        ],
      });

      await expect(
        spawnAgent({
          prompt: "/danx-next",
          repoName: "platform",
          timeoutMs: 300_000,
          mcpConfigPath: "/tmp/mcp/settings.json",
        }),
      ).rejects.toThrow(/schema.*danxbot|danxbot.*schema/s);
    });

    it("cleans up the prompt temp directory on probe failure (no leak)", async () => {
      // The outer runDispatchSlot catch handles `settingsDir` but has no
      // awareness of `promptDir` — spawnAgent's internal cleanup closure
      // isn't reachable yet. The probe-failure path must rmSync promptDir
      // itself. This test guards against a regression where that inline
      // cleanup gets accidentally deleted.
      mockMkdtempSync.mockImplementation(routeMkdtempByPrefix);

      mockProbeAllMcpServers.mockResolvedValueOnce({
        ok: false,
        failures: [
          {
            ok: false,
            serverName: "schema",
            reason: "exit",
            exitCode: 1,
            stderr: "SCHEMA_DEFINITION_ID is required",
            message:
              'MCP server "schema" exited with code 1 before responding: SCHEMA_DEFINITION_ID is required',
          },
        ],
      });

      await expect(
        spawnAgent({
          prompt: "/danx-next",
          repoName: "platform",
          timeoutMs: 300_000,
          mcpConfigPath: "/tmp/mcp/settings.json",
        }),
      ).rejects.toThrow();

      const promptCleanup = mockRmSync.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string) === "/tmp/danxbot-prompt-test",
      );
      expect(promptCleanup).toBeDefined();
    });
  });
});

// Route mkdtempSync by prefix so the three callers (mcp settings, prompt dir,
// terminal settings dir) get distinct paths. Tests can assert on the right
// cleanup path without being fragile to call order.
function routeMkdtempByPrefix(prefix: string): string {
  if (prefix.includes("danxbot-prompt-")) return "/tmp/danxbot-prompt-test";
  if (prefix.includes("danxbot-term-")) return "/tmp/danxbot-term-test";
  return "/tmp/danxbot-mcp-test";
}

/** Override the per-prefix mkdtempSync routing for a single test. */
function mockTempDirs(overrides: {
  prompt?: string;
  term?: string;
  mcp?: string;
}): void {
  mockMkdtempSync.mockImplementation((prefix: string) => {
    if (prefix.includes("danxbot-prompt-"))
      return overrides.prompt ?? "/tmp/danxbot-prompt-test";
    if (prefix.includes("danxbot-term-"))
      return overrides.term ?? "/tmp/danxbot-term-test";
    return overrides.mcp ?? "/tmp/danxbot-mcp-test";
  });
}

describe("spawnAgent — job.watcher and terminal mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWatcherEntryCallbacks.length = 0;
    mockHostExitWatchers.length = 0;
    mockMkdtempSync.mockImplementation(routeMkdtempByPrefix);
    // Default host-mode setup: PID file resolves to a fake PID, liveness check
    // says the process is alive. Individual tests override as needed.
    mockReadPidFileWithTimeout.mockResolvedValue(424242);
    mockIsPidAlive.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets job.watcher after spawn", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    expect(job.watcher).toBeDefined();
  });

  it("does not call spawnInTerminal when openTerminal is false (default)", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    expect(mockSpawnInTerminal).not.toHaveBeenCalled();
    expect(mockBuildDispatchScript).not.toHaveBeenCalled();
  });

  it("calls buildDispatchScript and spawnInTerminal when openTerminal is true", async () => {
    mockTempDirs({ term: "/tmp/danxbot-term-test" });

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
      apiToken: "test-token",
    });

    expect(mockGetTerminalLogPath).toHaveBeenCalledWith("test-uuid-1234");
    expect(mockBuildDispatchScript).toHaveBeenCalledWith(
      "/tmp/danxbot-term-test",
      expect.objectContaining({
        jobId: "test-uuid-1234",
        terminalLogPath: "/tmp/danxbot-terminal-test-uuid-1234.log",
        apiToken: "test-token",
        pidFilePath: "/tmp/danxbot-term-test/claude.pid",
      }),
    );
    expect(mockSpawnInTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("platform"),
        script: "/tmp/danxbot-term-test/run-agent.sh",
        cwd: "/danxbot/repos/platform",
      }),
    );
  });

  it("does NOT spawn a headless claude process when openTerminal is true — single-fork invariant", async () => {
    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    // `mockSpawn` is the spy on node:child_process.spawn — the only caller in
    // launcher.ts is the headless `spawn("claude", ...)` path. Host mode must
    // never reach it.
    const claudeSpawns = mockSpawn.mock.calls.filter(
      (c: unknown[]) => c[0] === "claude",
    );
    expect(claudeSpawns).toHaveLength(0);
  });

  it("reads the host-mode PID file and stores job.claudePid", async () => {
    mockReadPidFileWithTimeout.mockResolvedValue(987654);
    mockTempDirs({ term: "/tmp/danxbot-term-pid" });

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    expect(mockReadPidFileWithTimeout).toHaveBeenCalledWith(
      "/tmp/danxbot-term-pid/claude.pid",
      2_000,
      50,
      // The wt.exe output log lives alongside claude.pid in the same settings
      // dir. Passing it here is what lets a later PID-file timeout surface
      // the captured wt.exe output + interop-stall hint in the error.
      "/tmp/danxbot-term-pid/wt-stderr.log",
    );
    expect(job.claudePid).toBe(987654);
    expect(job.process).toBeUndefined();
  });

  it("attaches a host exit watcher to the tracked PID", async () => {
    mockReadPidFileWithTimeout.mockResolvedValue(111222);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    expect(mockCreateHostExitWatcher).toHaveBeenCalledWith(111222, 500);
    expect(job.hostExitWatcher).toBeDefined();
  });

  it("transitions the job to completed when the host-mode PID exits WITH assistant output", async () => {
    mockReadPidFileWithTimeout.mockResolvedValue(333444);
    const onComplete = vi.fn();

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
      onComplete,
    });

    // Simulate a final assistant message being written to JSONL
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "test",
      data: { content: [{ type: "text", text: "Task done" }] },
    });

    // Simulate claude PID going away
    mockHostExitWatchers[0]!.fire();

    expect(job.status).toBe("completed");
    expect(job.summary).toBe("Task done");
    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("transitions the job to FAILED when the host-mode PID exits without producing assistant output", async () => {
    // Per "fallbacks are bugs" — an agent that dies without any assistant output
    // either crashed at startup OR the watcher never attached. We must NOT
    // silently report completed; the lack of output is evidence of failure.
    mockReadPidFileWithTimeout.mockResolvedValue(999_111);
    const onComplete = vi.fn();

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
      onComplete,
    });

    // NO watcher entries emitted — lastAssistantText is "".
    // Simulate claude PID going away.
    mockHostExitWatchers[0]!.fire();

    expect(job.status).toBe("failed");
    expect(job.summary).toMatch(/without producing/i);
    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("host exit is a no-op when the job has already transitioned (danxbot_complete path)", async () => {
    mockReadPidFileWithTimeout.mockResolvedValue(222_333);
    mockIsPidAlive.mockReturnValue(false);
    const onComplete = vi.fn();

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
      onComplete,
    });

    // Simulate danxbot_complete: job.stop runs SIGTERM + transitions status.
    const stopPromise = job.stop!("completed", "Done via MCP");
    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    const onCompleteCallsAfterStop = onComplete.mock.calls.length;

    // Now the PID actually dies afterward — onExit must NOT overwrite the
    // already-terminal state.
    mockHostExitWatchers[0]!.fire();

    expect(job.status).toBe("completed");
    expect(job.summary).toBe("Done via MCP");
    // No additional onComplete fired after status was terminal
    expect(onComplete.mock.calls.length).toBe(onCompleteCallsAfterStop);
  });

  it("sets job.terminalLogPath when openTerminal is true", async () => {
    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    expect(job.terminalLogPath).toBe(
      "/tmp/danxbot-terminal-test-uuid-1234.log",
    );
  });

  it("does not set job.terminalLogPath when openTerminal is false", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: false,
    });

    expect(job.terminalLogPath).toBeUndefined();
  });

  it("passes the shared firstMessage (tag + Read directive) to buildDispatchScript", async () => {
    await spawnAgent({
      prompt: "do the work",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    const buildCall = mockBuildDispatchScript.mock.calls[0];
    const firstMessage = buildCall[1].firstMessage as string;
    expect(firstMessage).toContain("<!-- danxbot-dispatch:test-uuid-1234 -->");
    expect(firstMessage).toContain("Read ");
    expect(firstMessage).toContain(
      "/prompt.md and execute the task described in it.",
    );
    // Original prompt body stays in the file — it is NEVER inlined on the
    // command line in either runtime.
    expect(firstMessage).not.toContain("do the work");
  });

  it("includes --agents <json> in the shared flags when agents is non-empty", async () => {
    const agents = {
      Validator: { description: "Validator", prompt: "..." },
      TestReviewer: { description: "Test reviewer", prompt: "..." },
    };

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
      agents,
    });

    const buildCall = mockBuildDispatchScript.mock.calls[0];
    const flags = buildCall[1].flags as string[];
    const agentsIdx = flags.indexOf("--agents");
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(flags[agentsIdx + 1]).toBe(JSON.stringify(agents));
  });

  it("omits --agents from shared flags when agents object is empty", async () => {
    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
      agents: {},
    });

    const buildCall = mockBuildDispatchScript.mock.calls[0];
    const flags = buildCall[1].flags as string[];
    expect(flags).not.toContain("--agents");
  });

  it("omits --agents from shared flags when agents is undefined in host mode", async () => {
    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    const buildCall = mockBuildDispatchScript.mock.calls[0];
    const flags = buildCall[1].flags as string[];
    expect(flags).not.toContain("--agents");
  });

  it("cleans up BOTH promptDir and terminal settings dir AND stops the host exit watcher when job exits", async () => {
    mockTempDirs({
      prompt: "/tmp/danxbot-prompt-cleanup",
      term: "/tmp/danxbot-term-cleanup",
    });

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    const watcherStop = mockHostExitWatchers[0]!.stop;

    // Simulate the host claude PID going away
    mockHostExitWatchers[0]!.fire();
    await vi.advanceTimersByTimeAsync(0);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).toContain("/tmp/danxbot-term-cleanup");
    expect(rmPaths).toContain("/tmp/danxbot-prompt-cleanup");
    // Watcher must be stopped or its setInterval leaks
    expect(watcherStop).toHaveBeenCalled();
  });

  it("fails the job and runs cleanup when readPidFileWithTimeout rejects", async () => {
    mockTempDirs({
      prompt: "/tmp/danxbot-prompt-timeout",
      term: "/tmp/danxbot-term-timeout",
    });
    const pidErr = new Error("Timed out after 2000ms waiting for PID file");
    mockReadPidFileWithTimeout.mockRejectedValue(pidErr);
    const onComplete = vi.fn();

    await expect(
      spawnAgent({
        prompt: "/danx-next",
        repoName: "platform",
        timeoutMs: 300_000,
        openTerminal: true,
        onComplete,
      }),
    ).rejects.toThrow(/Timed out after 2000ms/);

    // onComplete must fire so the caller's lifecycle tracking runs even on spawn failure
    expect(onComplete).toHaveBeenCalledTimes(1);
    const job = onComplete.mock.calls[0]![0] as AgentJob;
    expect(job.status).toBe("failed");
    expect(job.summary).toContain("Host-mode spawn failed");
    // Both temp dirs must be removed — no resource leak on failure
    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).toContain("/tmp/danxbot-term-timeout");
    expect(rmPaths).toContain("/tmp/danxbot-prompt-timeout");
  });

  it("cleans up only the promptDir (no terminal settings dir) when openTerminal is false", async () => {
    // Docker mode creates ONLY the prompt dir — no host terminal settings dir.
    mockTempDirs({
      prompt: "/tmp/danxbot-prompt-docker",
      term: "/tmp/danxbot-term-docker-should-not-exist",
    });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: false,
    });

    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).toContain("/tmp/danxbot-prompt-docker");
    expect(rmPaths).not.toContain("/tmp/danxbot-term-docker-should-not-exist");
  });
});

describe("spawnAgent — docker/host invocation equivalence", () => {
  // Contract: for identical SpawnAgentOptions, the claude-facing invocation
  // (flags + firstMessage modulo the temp promptDir path) is byte-identical
  // across runtime modes. Only the spawn envelope differs.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWatcherEntryCallbacks.length = 0;
    mockHostExitWatchers.length = 0;
    mockMkdtempSync.mockImplementation(routeMkdtempByPrefix);
    mockReadPidFileWithTimeout.mockResolvedValue(123456);
    mockIsPidAlive.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces identical flags and firstMessage for docker and host runtimes", async () => {
    const sharedOpts = {
      prompt: "shared task body",
      repoName: "platform" as const,
      timeoutMs: 300_000,
      title: "Card #42",
      mcpConfigPath: "/tmp/mcp/settings.json",
      agents: {
        Validator: { description: "Validator", prompt: "v" },
        TestReviewer: { description: "TestReviewer", prompt: "t" },
      },
    };

    // Docker invocation
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    await spawnAgent(sharedOpts);
    const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
    const dockerDashP = dockerArgs.indexOf("-p");
    const dockerFlags = dockerArgs.slice(0, dockerDashP);
    const dockerFirstMessage = dockerArgs[dockerDashP + 1];

    // Host invocation — fresh call with the same options
    vi.clearAllMocks();
    mockMkdtempSync.mockImplementation(routeMkdtempByPrefix);
    mockReadPidFileWithTimeout.mockResolvedValue(123456);
    mockIsPidAlive.mockReturnValue(true);
    await spawnAgent({ ...sharedOpts, openTerminal: true });
    const hostBuild = mockBuildDispatchScript.mock.calls[0][1] as {
      flags: string[];
      firstMessage: string;
    };

    // flags: byte-identical (array equality, same ordering)
    expect(hostBuild.flags).toEqual(dockerFlags);
    // firstMessage: byte-identical (same promptDir in both thanks to prefix
    // routing — the point is the shape + contents match exactly)
    expect(hostBuild.firstMessage).toBe(dockerFirstMessage);
  });
});

describe("cancelJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWatcherEntryCallbacks.length = 0;
    mockMkdtempSync.mockImplementation(routeMkdtempByPrefix);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets job.status='canceled' before sending SIGTERM (mirrors job.stop() pattern)", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "long task",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    let statusAtKillTime: string | undefined;
    child.kill = vi.fn().mockImplementation(() => {
      statusAtKillTime = job.status;
    });

    const cancelPromise = cancelJob(job, "test-token");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    expect(statusAtKillTime).toBe("canceled");
  });

  it("results in status=canceled when process exits immediately on SIGTERM", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "long task",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // Simulate fast process exit triggered by SIGTERM (before 5s wait)
    child.kill = vi.fn().mockImplementation((sig: string) => {
      if (sig === "SIGTERM") {
        // Close with non-zero exit code (typical SIGTERM behavior)
        child.emit("close", 143);
      }
    });

    mockFetch.mockResolvedValue({ ok: true });

    const cancelPromise = cancelJob(job, "test-token");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    expect(job.status).toBe("canceled");
    expect(job.summary).toBe("Agent was canceled by user request");
    expect(job.completedAt).toBeInstanceOf(Date);
  });

  it("sends canceled status PUT when statusUrl is available", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "long task",
      repoName: "platform",
      timeoutMs: 300_000,
      statusUrl: "http://example.com/status",
      apiToken: "tok-cancel",
    });

    const cancelPromise = cancelJob(job, "tok-cancel");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    expect(mockFetch).toHaveBeenCalledWith(
      "http://example.com/status",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"canceled"'),
      }),
    );
  });

  it("is a no-op when job is not running", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "test",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    child.emit("close", 0);
    expect(job.status).toBe("completed");

    await cancelJob(job, "test-token");

    expect(child.kill).not.toHaveBeenCalled();
    expect(job.status).toBe("completed");
  });

  it("sends SIGKILL after 5s when process does not exit on SIGTERM", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "long task",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // Don't emit "close" — process never exits naturally
    const cancelPromise = cancelJob(job, "test-token");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    const killCalls = child.kill.mock.calls.map((c: unknown[]) => c[0]);
    expect(killCalls).toContain("SIGTERM");
    expect(killCalls).toContain("SIGKILL");
  });

  it("rm's the promptDir when cancelJob runs in docker mode", async () => {
    mockTempDirs({ prompt: "/tmp/danxbot-prompt-cancel-docker" });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "long task",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const cancelPromise = cancelJob(job, "test-token");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).toContain("/tmp/danxbot-prompt-cancel-docker");
  });

  it("rm's BOTH promptDir and termSettingsDir when cancelJob runs in host mode", async () => {
    mockTempDirs({
      prompt: "/tmp/danxbot-prompt-cancel-host",
      term: "/tmp/danxbot-term-cancel-host",
    });
    mockHostExitWatchers.length = 0;
    mockReadPidFileWithTimeout.mockResolvedValue(303030);
    mockIsPidAlive.mockReturnValue(false);

    const job = await spawnAgent({
      prompt: "host task",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    const cancelPromise = cancelJob(job, "tok");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).toContain("/tmp/danxbot-prompt-cancel-host");
    expect(rmPaths).toContain("/tmp/danxbot-term-cancel-host");
  });

  it("rm's the promptDir when the inactivity timer fires in docker mode", async () => {
    mockTempDirs({ prompt: "/tmp/danxbot-prompt-inactivity" });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "task",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(61_000);
    child.emit("close", 143);
    await vi.advanceTimersByTimeAsync(0);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).toContain("/tmp/danxbot-prompt-inactivity");
  });

  it("rm's the promptDir when maxRuntimeMs fires in docker mode", async () => {
    mockTempDirs({ prompt: "/tmp/danxbot-prompt-maxruntime" });
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnAgent({
      prompt: "task",
      repoName: "platform",
      timeoutMs: 300_000,
      maxRuntimeMs: 120_000,
    });

    // Keep inactivity timer alive, then trip maxRuntime
    await vi.advanceTimersByTimeAsync(60_000);
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: { content: [] },
    });
    await vi.advanceTimersByTimeAsync(61_000);

    const rmPaths = mockRmSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(rmPaths).toContain("/tmp/danxbot-prompt-maxruntime");
  });

  it("is a no-op when job.process is undefined", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnAgent({
      prompt: "test",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    job.process = undefined;
    job.status = "running";

    await cancelJob(job, "test-token");

    expect(child.kill).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────
  // Host-mode cancellation: no ChildProcess, just a tracked PID.
  // ──────────────────────────────────────────────────────────────

  it("sends SIGTERM + SIGKILL via killHostPid when canceling a host-mode job", async () => {
    mockHostExitWatchers.length = 0;
    mockReadPidFileWithTimeout.mockResolvedValue(555_666);
    mockIsPidAlive.mockReturnValue(true);

    const job = await spawnAgent({
      prompt: "host task",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    const cancelPromise = cancelJob(job, "tok");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    const pidSignals = mockKillHostPid.mock.calls.map((c: unknown[]) => [
      c[0],
      c[1],
    ]);
    expect(pidSignals).toContainEqual([555_666, "SIGTERM"]);
    expect(pidSignals).toContainEqual([555_666, "SIGKILL"]);
    expect(job.status).toBe("canceled");
  });

  // Card #41: cancelJob race — host onExit callback fires during the 5s grace
  // wait and previously overwrote job.status with "completed"/"failed",
  // hiding the cancel intent from any local consumer of job.status
  // (dashboard, stall recovery, retries). cancelJob must set status="canceled"
  // BEFORE SIGTERM so both docker close handler and host onExit early-return
  // via their `if (job.status === "running")` guards.
  // Regression: before card #62, cancelJob skipped options.onComplete because
  // the close handler early-returned under pre-set "canceled" status. The
  // dispatch layer relies on onComplete to clean up the per-dispatch MCP
  // settings directory (src/worker/dispatch.ts:113). Without this call, those
  // directories leak on every cancellation.
  it("fires options.onComplete on cancel so dispatch-layer cleanup runs", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    const onComplete = vi.fn();

    const job = await spawnAgent({
      prompt: "long task",
      repoName: "platform",
      timeoutMs: 300_000,
      onComplete,
    });

    const cancelPromise = cancelJob(job, "tok");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(job);
    expect(job.status).toBe("canceled");
  });

  it("fires options.onComplete on cancel in host mode", async () => {
    mockHostExitWatchers.length = 0;
    mockReadPidFileWithTimeout.mockResolvedValue(333_444);
    mockIsPidAlive.mockReturnValue(false);
    const onComplete = vi.fn();

    const job = await spawnAgent({
      prompt: "host task",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
      onComplete,
    });

    const cancelPromise = cancelJob(job, "tok");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("keeps status='canceled' when host onExit fires during the 5s grace wait", async () => {
    mockHostExitWatchers.length = 0;
    mockReadPidFileWithTimeout.mockResolvedValue(888_111);
    mockIsPidAlive.mockReturnValue(false);

    const job = await spawnAgent({
      prompt: "host task",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
      statusUrl: "http://example.com/status",
      apiToken: "tok",
    });

    mockFetch.mockResolvedValue({ ok: true });

    const cancelPromise = cancelJob(job, "tok");

    // Simulate the host claude PID dying in response to SIGTERM: the watcher
    // sees the process is gone and fires the onExit callback mid-wait. This
    // is the exact race that motivated card #41.
    mockHostExitWatchers[0].fire();

    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    expect(job.status).toBe("canceled");
    expect(job.summary).toBe("Agent was canceled by user request");
  });

  it("skips SIGKILL in host mode when isPidAlive returns false after SIGTERM", async () => {
    mockHostExitWatchers.length = 0;
    mockReadPidFileWithTimeout.mockResolvedValue(777_888);
    // First call (during alive-check before SIGKILL) returns false — the
    // process already exited on SIGTERM, so SIGKILL must NOT follow.
    mockIsPidAlive.mockReturnValue(false);

    const job = await spawnAgent({
      prompt: "host task",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    const cancelPromise = cancelJob(job, "tok");
    await vi.advanceTimersByTimeAsync(5_001);
    await cancelPromise;

    const signals = mockKillHostPid.mock.calls.map((c: unknown[]) => c[1]);
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
  });

  it("inactivity timeout in host mode kills via killHostPid and issues timeout PUT", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    mockHostExitWatchers.length = 0;
    mockReadPidFileWithTimeout.mockResolvedValue(606_060);

    const job = await spawnAgent({
      prompt: "host task",
      repoName: "platform",
      timeoutMs: 60_000,
      openTerminal: true,
      statusUrl: "http://example.com/status",
      apiToken: "tok-host-inactivity",
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(mockKillHostPid).toHaveBeenCalledWith(606_060, "SIGTERM");
    expect(job.status).toBe("timeout");
    const timeoutCall = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[1] === "object" && c[1] !== null
        && typeof (c[1] as { body?: unknown }).body === "string"
        && ((c[1] as { body: string }).body).includes('"timeout"'),
    );
    expect(timeoutCall).toBeDefined();
  });

  it("max runtime timeout in host mode kills via killHostPid and issues timeout PUT", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    mockHostExitWatchers.length = 0;
    mockReadPidFileWithTimeout.mockResolvedValue(707_070);

    const job = await spawnAgent({
      prompt: "host task",
      repoName: "platform",
      timeoutMs: 300_000,
      maxRuntimeMs: 120_000,
      openTerminal: true,
      statusUrl: "http://example.com/status",
      apiToken: "tok-host-max-runtime",
    });

    // Keep inactivity timer from tripping first
    await vi.advanceTimersByTimeAsync(60_000);
    emitWatcherEntry({
      type: "assistant",
      timestamp: Date.now(),
      summary: "",
      data: { content: [] },
    });
    await vi.advanceTimersByTimeAsync(61_000);

    expect(mockKillHostPid).toHaveBeenCalledWith(707_070, "SIGTERM");
    expect(job.status).toBe("timeout");
    expect(job.summary).toContain("max runtime");
    const timeoutCall = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[1] === "object" && c[1] !== null
        && typeof (c[1] as { body?: unknown }).body === "string"
        && ((c[1] as { body: string }).body).includes('"timeout"'),
    );
    expect(timeoutCall).toBeDefined();
    const body = JSON.parse((timeoutCall![1] as { body: string }).body);
    expect(body.message).toContain("max runtime");
  });

  it("job.stop targets the tracked PID in host mode and transitions to completed", async () => {
    mockHostExitWatchers.length = 0;
    mockReadPidFileWithTimeout.mockResolvedValue(424_242);
    mockIsPidAlive.mockReturnValue(false); // exits promptly on SIGTERM

    const job = await spawnAgent({
      prompt: "host task",
      repoName: "platform",
      timeoutMs: 300_000,
      openTerminal: true,
    });

    const stopPromise = job.stop!("completed", "Host agent done");
    await vi.advanceTimersByTimeAsync(5_001);
    await stopPromise;

    expect(mockKillHostPid).toHaveBeenCalledWith(424_242, "SIGTERM");
    expect(job.status).toBe("completed");
    expect(job.summary).toBe("Host agent done");
  });
});
