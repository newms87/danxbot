import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCleanEnv,
  logPromptToDisk,
  createInactivityTimer,
  setupProcessHandlers,
} from "./process-utils.js";
import type { AgentJob } from "./launcher.js";

// ─── buildCleanEnv ────────────────────────────────────────────────────────────

describe("buildCleanEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      CLAUDECODE_SESSION: "abc123",
      CLAUDECODE_MODE: "piped",
      CUSTOM_VAR: "hello",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("strips CLAUDECODE vars from process.env", () => {
    const result = buildCleanEnv();
    expect(result).not.toHaveProperty("CLAUDECODE_SESSION");
    expect(result).not.toHaveProperty("CLAUDECODE_MODE");
  });

  it("preserves non-CLAUDECODE vars", () => {
    const result = buildCleanEnv();
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.CUSTOM_VAR).toBe("hello");
  });

  it("merges extra vars on top", () => {
    const result = buildCleanEnv({ EXTRA: "value", PATH: "/override" });
    expect(result.EXTRA).toBe("value");
    expect(result.PATH).toBe("/override");
  });

  it("returns env without CLAUDECODE vars when no extras provided", () => {
    const result = buildCleanEnv();
    const keys = Object.keys(result);
    expect(keys).not.toContain("CLAUDECODE_SESSION");
    expect(keys).toContain("PATH");
  });

  it("sets ENABLE_TOOL_SEARCH=0 so MCP tools load eagerly (dispatched agents must see mcp__* tools without ToolSearch)", () => {
    const result = buildCleanEnv();
    expect(result.ENABLE_TOOL_SEARCH).toBe("0");
  });

  it("allows caller to override ENABLE_TOOL_SEARCH via extras", () => {
    const result = buildCleanEnv({ ENABLE_TOOL_SEARCH: "1" });
    expect(result.ENABLE_TOOL_SEARCH).toBe("1");
  });
});

// ─── logPromptToDisk ──────────────────────────────────────────────────────────

describe("logPromptToDisk", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "process-utils-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the log directory and writes prompt.md", () => {
    logPromptToDisk(tmpDir, "job-1", "my prompt");
    const promptPath = join(tmpDir, "job-1", "prompt.md");
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, "utf-8")).toBe("my prompt");
  });

  it("writes agents.json when agents are provided", () => {
    const agents = [{ name: "test-agent" }];
    logPromptToDisk(tmpDir, "job-2", "prompt", agents);
    const agentsPath = join(tmpDir, "job-2", "agents.json");
    expect(existsSync(agentsPath)).toBe(true);
    expect(JSON.parse(readFileSync(agentsPath, "utf-8"))).toEqual(agents);
  });

  it("does not write agents.json when agents array is empty", () => {
    logPromptToDisk(tmpDir, "job-3", "prompt", []);
    const agentsPath = join(tmpDir, "job-3", "agents.json");
    expect(existsSync(agentsPath)).toBe(false);
  });

  it("does not throw when the log directory cannot be created (non-fatal)", () => {
    // Pass a path where a file already exists as the parent — causes mkdirSync to fail
    const promptPath = join(tmpDir, "job-4", "prompt.md");
    // Create a file at the job path so mkdir will fail (ENOTDIR or EEXIST)
    // Instead just point logsDir to a file path to trigger the error
    expect(() => logPromptToDisk("/proc/1/mem", "job-4", "prompt")).not.toThrow();
  });
});

// ─── createInactivityTimer ────────────────────────────────────────────────────

describe("createInactivityTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeJob(): AgentJob {
    return {
      id: "test-job",
      status: "running",
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

  it("fires onTimeout after timeoutMs and kills the process via the injected kill fn", () => {
    const job = makeJob();
    const killProcess = vi.fn();
    const onTimeout = vi.fn();

    createInactivityTimer(killProcess, 5000, onTimeout, job);

    vi.advanceTimersByTime(5000);
    expect(killProcess).toHaveBeenCalledWith("SIGTERM");
    expect(onTimeout).toHaveBeenCalledWith(job);
    expect(job.status).toBe("timeout");
  });

  it("reset() restarts the clock and prevents premature timeout", () => {
    const job = makeJob();
    const killProcess = vi.fn();
    const onTimeout = vi.fn();

    const timer = createInactivityTimer(killProcess, 5000, onTimeout, job);

    vi.advanceTimersByTime(4000);
    timer.reset();
    vi.advanceTimersByTime(4000); // 4s after reset — should NOT fire yet
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1500); // now 5.5s after reset — should fire
    expect(onTimeout).toHaveBeenCalledWith(job);
  });

  it("clear() cancels the pending timeout", () => {
    const job = makeJob();
    const killProcess = vi.fn();
    const onTimeout = vi.fn();

    const timer = createInactivityTimer(killProcess, 5000, onTimeout, job);
    timer.clear();
    vi.advanceTimersByTime(10000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("does not fire onTimeout when job is no longer 'running'", () => {
    const job = makeJob();
    const killProcess = vi.fn();
    const onTimeout = vi.fn();

    createInactivityTimer(killProcess, 5000, onTimeout, job);
    job.status = "completed";
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

// ─── setupProcessHandlers ─────────────────────────────────────────────────────

describe("setupProcessHandlers", () => {
  function makeJob(): AgentJob {
    return {
      id: "test-job",
      status: "running",
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

  function makeChild() {
    return new EventEmitter() as NodeJS.EventEmitter & {
      emit(event: "close", code: number | null): boolean;
      emit(event: "error", err: Error): boolean;
    };
  }

  it("sets status to 'completed' and summary from last assistant text on exit code 0", () => {
    const job = makeJob();
    const child = makeChild();
    const onComplete = vi.fn();

    setupProcessHandlers(child as never, job, () => "final answer", () => "", { onComplete });
    child.emit("close", 0);

    expect(job.status).toBe("completed");
    expect(job.summary).toBe("final answer");
    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("uses fallback summary 'Agent completed successfully' when no assistant text", () => {
    const job = makeJob();
    const child = makeChild();

    setupProcessHandlers(child as never, job, () => "", () => "", {});
    child.emit("close", 0);

    expect(job.status).toBe("completed");
    expect(job.summary).toBe("Agent completed successfully");
  });

  it("sets status to 'failed' and includes stderr in summary on non-zero exit", () => {
    const job = makeJob();
    const child = makeChild();
    const onComplete = vi.fn();

    setupProcessHandlers(
      child as never, job,
      () => "some text",
      () => "fatal error occurred",
      { onComplete },
    );
    child.emit("close", 1);

    expect(job.status).toBe("failed");
    expect(job.summary).toContain("1");
    expect(job.summary).toContain("fatal error occurred");
    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("falls back to last assistant text when stderr is empty on failed exit", () => {
    const job = makeJob();
    const child = makeChild();

    setupProcessHandlers(child as never, job, () => "last words", () => "", {});
    child.emit("close", 2);

    expect(job.status).toBe("failed");
    expect(job.summary).toContain("last words");
  });

  it("sets status to 'failed' on process spawn error", () => {
    const job = makeJob();
    const child = makeChild();
    const onComplete = vi.fn();

    setupProcessHandlers(child as never, job, () => "", () => "", { onComplete });
    child.emit("error", new Error("spawn failed"));

    expect(job.status).toBe("failed");
    expect(job.summary).toContain("spawn failed");
    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("does not call onComplete when job is already in a terminal state", () => {
    const job = makeJob();
    job.status = "timeout"; // already terminal
    const child = makeChild();
    const onComplete = vi.fn();

    setupProcessHandlers(child as never, job, () => "", () => "", { onComplete });
    child.emit("close", 0);

    expect(onComplete).not.toHaveBeenCalled();
  });

  // Close-handler cancel behavior is no longer driven by a _canceling flag.
  // cancelJob now sets job.status="canceled" BEFORE sending SIGTERM, so the
  // `job.status === "running"` guard below short-circuits this handler when
  // the process exits under cancel. End-to-end coverage lives in
  // launcher.test.ts ("keeps status='canceled' when host onExit fires ...").
  // The test below locks down the guard itself.

  it("preserves pre-set terminal status when close fires after cancelJob", () => {
    const job = makeJob();
    job.status = "canceled";
    job.summary = "Agent was canceled by user request";
    const child = makeChild();
    const onComplete = vi.fn();

    setupProcessHandlers(child as never, job, () => "ignored", () => "ignored", { onComplete });
    child.emit("close", 143);

    expect(job.status).toBe("canceled");
    expect(job.summary).toBe("Agent was canceled by user request");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("calls cleanup function on both close and error events", () => {
    const cleanup = vi.fn();

    // close path
    const job1 = makeJob();
    const child1 = makeChild();
    setupProcessHandlers(child1 as never, job1, () => "", () => "", { cleanup });
    child1.emit("close", 0);
    expect(cleanup).toHaveBeenCalledTimes(1);

    cleanup.mockClear();

    // error path
    const job2 = makeJob();
    const child2 = makeChild();
    setupProcessHandlers(child2 as never, job2, () => "", () => "", { cleanup });
    child2.emit("error", new Error("boom"));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
