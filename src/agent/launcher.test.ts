import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../config.js", () => ({
  config: {
    logsDir: "/tmp/danxbot-test-logs",
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

import { spawnHeadlessAgent } from "./launcher.js";

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

describe("spawnHeadlessAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns claude CLI with correct args for a prompt", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnHeadlessAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
        "-p",
        "/danx-next",
      ]),
      expect.objectContaining({
        cwd: "/danxbot/repos/platform",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("does NOT include --mcp-config in args", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnHeadlessAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--mcp-config");
  });

  it("strips CLAUDECODE env vars from spawned process", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    process.env.CLAUDECODE_SESSION = "should-be-removed";

    await spawnHeadlessAgent({
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

    const job = await spawnHeadlessAgent({
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

    const job = await spawnHeadlessAgent({
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

    const job = await spawnHeadlessAgent({
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

    const job = await spawnHeadlessAgent({
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

    const job = await spawnHeadlessAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(61_000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(job.status).toBe("timeout");
  });

  it("resets inactivity timeout on stdout data", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnHeadlessAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    // Advance 50s (not past timeout)
    await vi.advanceTimersByTimeAsync(50_000);
    // Emit stdout data — should reset the timer
    child.stdout.emit("data", Buffer.from('{"type":"assistant"}\n'));
    // Advance another 50s (would be 100s total without reset)
    await vi.advanceTimersByTimeAsync(50_000);

    // Should still be running because timeout was reset
    expect(job.status).toBe("running");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("calls onComplete callback when job finishes", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);
    const onComplete = vi.fn();

    const job = await spawnHeadlessAgent({
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

    const job = await spawnHeadlessAgent({
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

    await spawnHeadlessAgent({
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

    await spawnHeadlessAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
      env: { DANXBOT_REPO_NAME: "platform", DANXBOT_EPHEMERAL: "1" },
    });

    const spawnEnv = mockSpawn.mock.calls[0][2].env;
    expect(spawnEnv.DANXBOT_REPO_NAME).toBe("platform");
    expect(spawnEnv.DANXBOT_EPHEMERAL).toBe("1");
  });

  it("logs prompt to disk", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    await spawnHeadlessAgent({
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
      "/danx-next",
    );
  });

  it("captures assistant text from stream-json as job summary on success", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnHeadlessAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // Emit a stream-json assistant event
    const event = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Completed the task successfully" }] },
    });
    child.stdout.emit("data", Buffer.from(event + "\n"));

    // Close with success
    child.emit("close", 0);

    expect(job.status).toBe("completed");
    expect(job.summary).toBe("Completed the task successfully");
  });

  it("includes stderr in failure summary", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnHeadlessAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 300_000,
    });

    // Emit stderr
    child.stderr.emit("data", Buffer.from("Error: permission denied"));

    // Close with failure
    child.emit("close", 1);

    expect(job.status).toBe("failed");
    expect(job.summary).toContain("permission denied");
  });

  it("prevents double status transition (close after timeout)", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnHeadlessAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    // Trigger timeout
    await vi.advanceTimersByTimeAsync(61_000);
    expect(job.status).toBe("timeout");

    // Now emit close — should NOT change status
    child.emit("close", 0);
    expect(job.status).toBe("timeout");
  });

  it("does not fire timeout after close event", async () => {
    const child = createMockChildProcess();
    mockSpawn.mockReturnValue(child);

    const job = await spawnHeadlessAgent({
      prompt: "/danx-next",
      repoName: "platform",
      timeoutMs: 60_000,
    });

    // Close first
    child.emit("close", 0);
    expect(job.status).toBe("completed");

    // Advance past timeout — should NOT kill or change status
    await vi.advanceTimersByTimeAsync(61_000);
    expect(job.status).toBe("completed");
    expect(child.kill).not.toHaveBeenCalled();
  });
});
