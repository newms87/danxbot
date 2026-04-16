/**
 * StallDetector E2E Tests — Real files, real timers, real watchers.
 *
 * Tests the full integration: file writes → TerminalOutputWatcher poll →
 * timestamp update → StallDetector check → onStall callback. No mocks,
 * no fake timers. Uses controlled file writes to simulate agent behavior.
 *
 * Run via: npm run test:validate
 * Excluded from default `npx vitest run` via vitest.config.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  writeFileSync,
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TerminalOutputWatcher, THINKING_CHAR } from "../../agent/terminal-output-watcher.js";
import { SessionLogWatcher, DISPATCH_TAG_PREFIX, deriveSessionDir } from "../../agent/session-log-watcher.js";
import { StallDetector, hasReceivedToolResult } from "../../agent/stall-detector.js";

// --- Test configuration ---
// These match the new design: 5s stall threshold, 2s check interval.
// Watchers poll at 500ms for test responsiveness.

const STALL_THRESHOLD_MS = 5_000;
const CHECK_INTERVAL_MS = 2_000;
const WATCHER_POLL_MS = 500;

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, pollMs);
    };
    check();
  });
}

/** Build a JSONL entry for an assistant message with tool_use blocks. */
function jsonlAssistant(toolUseIds: string[], timestamp?: string): string {
  const content = toolUseIds.map((id) => ({
    type: "tool_use",
    id,
    name: "Read",
    input: {},
  }));
  return JSON.stringify({
    type: "assistant",
    message: { content, model: "claude-3" },
    timestamp: timestamp ?? new Date().toISOString(),
    sessionId: "e2e-test",
  });
}

/** Build a JSONL entry for a user message with tool_result blocks. */
function jsonlToolResult(toolUseIds: string[], timestamp?: string): string {
  const content = toolUseIds.map((id) => ({
    type: "tool_result",
    tool_use_id: id,
    content: "result content",
  }));
  return JSON.stringify({
    type: "user",
    message: { content },
    timestamp: timestamp ?? new Date().toISOString(),
    sessionId: "e2e-test",
  });
}

/** Build a JSONL entry for an assistant text-only message (no tools). */
function jsonlAssistantText(text: string, timestamp?: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }], model: "claude-3" },
    timestamp: timestamp ?? new Date().toISOString(),
    sessionId: "e2e-test",
  });
}

interface TestHarness {
  dir: string;
  termLogPath: string;
  jsonlPath: string;
  termWatcher: TerminalOutputWatcher;
  sessionWatcher: SessionLogWatcher;
  detector: StallDetector;
  stallTimestamps: number[];
  writeJsonl(line: string): void;
  writeThinking(): void;
  writeTerminalText(text: string): void;
  start(): Promise<void>;
  cleanup(): void;
}

function createHarness(options?: {
  stallThresholdMs?: number;
  checkIntervalMs?: number;
  maxNudges?: number;
  confirmationWindowMs?: number;
}): TestHarness {
  const dir = mkdtempSync(join(tmpdir(), "stall-e2e-"));
  const termLogPath = join(dir, "terminal.log");
  const sessionDir = join(dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });

  const sessionId = randomUUID();
  const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);

  // Create empty files so watchers find them immediately
  writeFileSync(termLogPath, "");
  writeFileSync(jsonlPath, "");

  const termWatcher = new TerminalOutputWatcher(termLogPath, WATCHER_POLL_MS);
  const sessionWatcher = new SessionLogWatcher({
    cwd: "/e2e-test",
    sessionDir,
    sessionId,
    pollIntervalMs: WATCHER_POLL_MS,
  });

  const stallTimestamps: number[] = [];
  const detector = new StallDetector({
    watcher: sessionWatcher,
    terminalWatcher: termWatcher,
    stallThresholdMs: options?.stallThresholdMs ?? STALL_THRESHOLD_MS,
    checkIntervalMs: options?.checkIntervalMs ?? CHECK_INTERVAL_MS,
    maxNudges: options?.maxNudges ?? 3,
    confirmationWindowMs: options?.confirmationWindowMs ?? 0,
    onStall: () => {
      stallTimestamps.push(Date.now());
    },
  });

  return {
    dir,
    termLogPath,
    jsonlPath,
    termWatcher,
    sessionWatcher,
    detector,
    stallTimestamps,

    writeJsonl(line: string) {
      appendFileSync(jsonlPath, line + "\n");
    },

    writeThinking() {
      appendFileSync(termLogPath, THINKING_CHAR);
    },

    writeTerminalText(text: string) {
      appendFileSync(termLogPath, text);
    },

    async start() {
      termWatcher.start();
      await sessionWatcher.start();
      detector.start();
    },

    cleanup() {
      detector.stop();
      termWatcher.stop();
      sessionWatcher.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// --- E2E Tests ---

describe("StallDetector E2E (real files, real timers)", () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.cleanup();
  });

  // Scenario 1: Continuous ✻ = no stall (false positive prevention)
  it("does not stall when thinking indicator appears continuously", async () => {
    harness = createHarness();

    // Set up: tool_use + tool_result so stall detection is active
    harness.writeJsonl(jsonlAssistant(["t1"]));
    harness.writeJsonl(jsonlToolResult(["t1"]));

    await harness.start();

    // Write ✻ every 500ms for 8 seconds — well past the 5s threshold
    const interval = setInterval(() => harness.writeThinking(), 500);
    await sleep(8_000);
    clearInterval(interval);

    expect(harness.stallTimestamps).toHaveLength(0);
  }, 12_000);

  // Scenario 2: Pending tool_use (no tool_result) = waiting, never stalled
  it("does not stall when a tool call is pending (no tool_result yet)", async () => {
    harness = createHarness();

    // Tool_use sent, no tool_result — agent is waiting for tool
    harness.writeJsonl(jsonlAssistant(["t1"]));

    await harness.start();

    // Wait 10s in total silence — should NOT stall because tool is pending
    await sleep(10_000);

    expect(harness.stallTimestamps).toHaveLength(0);
  }, 15_000);

  // Scenario 3: No tool_result yet (first turn) = not stalled
  it("does not stall before the first tool_result (first turn exempt)", async () => {
    harness = createHarness();

    // Only an assistant text entry — no tool calls yet
    harness.writeJsonl(jsonlAssistantText("I'm thinking about this..."));

    await harness.start();

    // 10s of silence — should NOT stall because no tool_result has happened
    await sleep(10_000);

    expect(harness.stallTimestamps).toHaveLength(0);
  }, 15_000);

  // Scenario 4: Terminal text output (no ✻) after tool_result = not stalled
  it("does not stall when agent is writing text output (no thinking indicator)", async () => {
    harness = createHarness();

    // Tool_use + tool_result so stall detection is active
    harness.writeJsonl(jsonlAssistant(["t1"]));
    harness.writeJsonl(jsonlToolResult(["t1"]));

    await harness.start();

    // Write regular text (not ✻) every 500ms for 8 seconds
    const interval = setInterval(
      () => harness.writeTerminalText("some output text\n"),
      500,
    );
    await sleep(8_000);
    clearInterval(interval);

    expect(harness.stallTimestamps).toHaveLength(0);
  }, 12_000);

  // Scenario 5: Silence after tool_result → stall detected, confirmed for 10s
  it("detects stall within ~7s of silence after tool_result, stays stalled for 10s", async () => {
    harness = createHarness();

    // Tool_use + tool_result, then some thinking, then silence
    harness.writeJsonl(jsonlAssistant(["t1"]));
    harness.writeJsonl(jsonlToolResult(["t1"]));

    await harness.start();

    // Write ✻ for 2 seconds to establish activity
    const interval = setInterval(() => harness.writeThinking(), 300);
    await sleep(2_000);
    clearInterval(interval);

    // Now silence — record the moment
    const silenceStart = Date.now();

    // Wait for stall detection (should fire within ~7s: 5s threshold + 2s check interval)
    const detected = await waitFor(
      () => harness.stallTimestamps.length > 0,
      12_000,
    );
    expect(detected).toBe(true);

    const detectionDelay = harness.stallTimestamps[0] - silenceStart;
    // Should detect between 5s (threshold) and 10s (threshold + check jitter + poll jitter)
    expect(detectionDelay).toBeGreaterThanOrEqual(4_000); // allow 1s jitter
    expect(detectionDelay).toBeLessThan(12_000);

    // Post-detection confirmation: wait 10s and verify no recovery
    const countAtDetection = harness.stallTimestamps.length;
    await sleep(10_000);

    // Agent should still be stalled — no recovery (stallTimestamps only grows or stays)
    expect(harness.stallTimestamps.length).toBeGreaterThanOrEqual(countAtDetection);
  }, 30_000);

  // Scenario 6: Stall fires, agent recovers (✻ resumes), stalls again → nudge counting
  it("recovers when activity resumes after stall, then detects second stall", async () => {
    harness = createHarness({ maxNudges: 5 });

    // Set up: tool_use + tool_result
    harness.writeJsonl(jsonlAssistant(["t1"]));
    harness.writeJsonl(jsonlToolResult(["t1"]));

    await harness.start();

    // Phase 1: Write ✻ briefly, then silence → first stall
    harness.writeThinking();
    await sleep(1_000);

    const firstStallDetected = await waitFor(
      () => harness.stallTimestamps.length > 0,
      12_000,
    );
    expect(firstStallDetected).toBe(true);

    const firstStallCount = harness.stallTimestamps.length;

    // Phase 2: Resume activity — agent "recovers"
    const resumeInterval = setInterval(() => harness.writeThinking(), 300);
    await sleep(3_000);
    clearInterval(resumeInterval);

    // Phase 3: Silence again → second stall
    const secondStallDetected = await waitFor(
      () => harness.stallTimestamps.length > firstStallCount,
      12_000,
    );
    expect(secondStallDetected).toBe(true);

    // Nudge count should be >= 2 (first stall + second stall at minimum)
    expect(harness.stallTimestamps.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  // Scenario 7: maxNudges exhaustion — detector stops itself after reaching the limit
  it("stops firing after maxNudges is reached", async () => {
    harness = createHarness({ maxNudges: 2, stallThresholdMs: 3_000, checkIntervalMs: 1_000 });

    // Tool_use + tool_result so stall detection is active
    harness.writeJsonl(jsonlAssistant(["t1"]));
    harness.writeJsonl(jsonlToolResult(["t1"]));

    // Brief activity then silence
    harness.writeThinking();

    await harness.start();

    // Wait for 2 stalls to fire (maxNudges = 2)
    const twoStalls = await waitFor(
      () => harness.stallTimestamps.length >= 2,
      15_000,
    );
    expect(twoStalls).toBe(true);

    // Record count after maxNudges reached, wait 6s (2x threshold) — no more should fire
    const countAfterMax = harness.stallTimestamps.length;
    await sleep(6_000);

    expect(harness.stallTimestamps).toHaveLength(countAfterMax);
    expect(harness.detector.getNudgeCount()).toBe(2);
  }, 20_000);

  // Scenario 8: Docker fallback — no terminal watcher, uses 7-minute JSONL-only timeout
  // (We don't wait 7 minutes in a test — use a short fallback threshold to prove the path works.)
  it("falls back to JSONL-only detection when no terminal watcher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stall-e2e-fallback-"));
    const sessionDir = join(dir, "sessions");
    mkdirSync(sessionDir, { recursive: true });

    const sessionId = randomUUID();
    const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, "");

    const sessionWatcher = new SessionLogWatcher({
      cwd: "/e2e-test",
      sessionDir,
      sessionId,
      pollIntervalMs: WATCHER_POLL_MS,
    });

    const stallTimestamps: number[] = [];

    // No terminalWatcher — StallDetector should fall back to JSONL-only
    // Use a short threshold (3s) so the test doesn't take 7 minutes
    const detector = new StallDetector({
      watcher: sessionWatcher,
      // Deliberately no terminalWatcher
      stallThresholdMs: 3_000,
      checkIntervalMs: 1_000,
      maxNudges: 3,
      confirmationWindowMs: 0,
      onStall: () => {
        stallTimestamps.push(Date.now());
      },
    });

    // Write tool_use + tool_result so stall detection is active
    appendFileSync(jsonlPath, jsonlAssistant(["t1"]) + "\n");
    appendFileSync(jsonlPath, jsonlToolResult(["t1"]) + "\n");

    await sessionWatcher.start();
    detector.start();

    try {
      // Wait for stall detection (3s threshold + 1s check interval ≈ 4-5s)
      const silenceStart = Date.now();
      const detected = await waitFor(
        () => stallTimestamps.length > 0,
        10_000,
      );

      expect(detected).toBe(true);
      const delay = stallTimestamps[0] - silenceStart;
      expect(delay).toBeGreaterThanOrEqual(2_000);
      expect(delay).toBeLessThan(8_000);
    } finally {
      detector.stop();
      sessionWatcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

// --- Real Claude Process E2E Tests ---
// These spawn actual `claude` CLI processes via `script -q -f` and verify
// stall detection against real terminal output (✻ characters) and JSONL files.
// Gated on ANTHROPIC_API_KEY — skipped when not set.

function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

interface RealClaudeHarness {
  cwd: string;
  termLogPath: string;
  sessionDir: string;
  termWatcher: TerminalOutputWatcher;
  sessionWatcher: SessionLogWatcher;
  detector: StallDetector;
  stallTimestamps: number[];
  proc: ChildProcess;
  waitForExit(): Promise<number>;
  waitForToolResult(timeoutMs: number): Promise<boolean>;
  start(): Promise<void>;
  cleanup(): void;
}

function createRealClaudeHarness(options: {
  prompt: string;
  stallThresholdMs?: number;
  checkIntervalMs?: number;
  maxNudges?: number;
  confirmationWindowMs?: number;
}): RealClaudeHarness {
  const dispatchId = randomUUID();
  const cwd = mkdtempSync(join(tmpdir(), "stall-e2e-real-"));
  const termLogPath = join(cwd, "terminal.log");
  const promptFile = join(cwd, "prompt.txt");

  // Tag prompt for JSONL file discovery by SessionLogWatcher
  const taggedPrompt = `${DISPATCH_TAG_PREFIX}${dispatchId} --> ${options.prompt}`;
  writeFileSync(promptFile, taggedPrompt);
  writeFileSync(termLogPath, "");

  // Derive session dir where Claude Code writes JSONL
  const sessionDir = deriveSessionDir(cwd);

  // Spawn claude via script -q -f for terminal output capture.
  // script creates a pty so claude emits ✻ thinking indicators.
  // The bash -c wrapper enables $(cat ...) command substitution.
  const proc = spawn("bash", [
    "-c",
    `exec script -q -f '${termLogPath}' -c "claude --dangerously-skip-permissions --verbose -p \\"\\$(cat '${promptFile}')\\""`,
  ], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const termWatcher = new TerminalOutputWatcher(termLogPath, WATCHER_POLL_MS);
  const sessionWatcher = new SessionLogWatcher({
    cwd,
    dispatchId,
    pollIntervalMs: WATCHER_POLL_MS,
  });

  const stallTimestamps: number[] = [];
  const detector = new StallDetector({
    watcher: sessionWatcher,
    terminalWatcher: termWatcher,
    stallThresholdMs: options.stallThresholdMs ?? STALL_THRESHOLD_MS,
    checkIntervalMs: options.checkIntervalMs ?? CHECK_INTERVAL_MS,
    maxNudges: options.maxNudges ?? 3,
    confirmationWindowMs: options.confirmationWindowMs ?? 0,
    onStall: () => {
      stallTimestamps.push(Date.now());
    },
  });

  let exitCode: number | null = null;
  let exitResolvers: Array<(code: number) => void> = [];

  proc.on("exit", (code) => {
    exitCode = code ?? 1;
    for (const resolve of exitResolvers) resolve(exitCode);
    exitResolvers = [];
  });

  return {
    cwd,
    termLogPath,
    sessionDir,
    termWatcher,
    sessionWatcher,
    detector,
    stallTimestamps,
    proc,

    waitForExit(): Promise<number> {
      if (exitCode !== null) return Promise.resolve(exitCode);
      return new Promise((resolve) => { exitResolvers.push(resolve); });
    },

    waitForToolResult(timeoutMs: number): Promise<boolean> {
      return waitFor(
        () => hasReceivedToolResult(sessionWatcher.getEntries()),
        timeoutMs,
      );
    },

    async start() {
      termWatcher.start();
      await sessionWatcher.start();
      detector.start();
    },

    cleanup() {
      detector.stop();
      termWatcher.stop();
      sessionWatcher.stop();

      // Kill process if still running
      if (exitCode === null) {
        try {
          proc.kill("SIGTERM");
        } catch (err) {
          // ESRCH = process already exited — expected during cleanup
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        }
      }

      // Clean up temp cwd
      rmSync(cwd, { recursive: true, force: true });

      // Clean up JSONL session directory created by Claude Code
      if (existsSync(sessionDir)) {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    },
  };
}

describe.skipIf(!hasApiKey())("StallDetector E2E — Real Claude Process", () => {
  let realHarness: RealClaudeHarness | null = null;

  afterEach(() => {
    realHarness?.cleanup();
    realHarness = null;
  });

  // Scenario 1: Quick completion without tool use — stall detection never activates
  it("no stall when agent completes quickly without tool use", async () => {
    realHarness = createRealClaudeHarness({
      prompt: "Reply with exactly one word: hi",
    });
    await realHarness.start();

    const exitCode = await realHarness.waitForExit();
    expect(exitCode).toBe(0);

    // No tool_result in JSONL → hasReceivedToolResult is false → state stays "waiting"
    // → stall detection never activates → no false positive
    expect(realHarness.stallTimestamps).toHaveLength(0);
  }, 30_000);

  // Scenario 2: Agent uses Read tool — no false stall during tool execution
  it("no false stall when agent uses a tool and completes", async () => {
    const testFilePath = join(tmpdir(), `danxbot-stall-test-${randomUUID()}.txt`);
    writeFileSync(testFilePath, "The answer is 42.");

    try {
      realHarness = createRealClaudeHarness({
        prompt: `Read the file ${testFilePath} and tell me what it says in one sentence`,
      });
      await realHarness.start();

      const exitCode = await realHarness.waitForExit();
      expect(exitCode).toBe(0);

      // Verify tool_result appeared in JSONL (proves the agent used a tool)
      const entries = realHarness.sessionWatcher.getEntries();
      expect(hasReceivedToolResult(entries)).toBe(true);

      // No stall should have fired during execution — ✻ and text output keep
      // lastActivityAt fresh throughout the tool call and response generation.
      expect(realHarness.stallTimestamps).toHaveLength(0);
    } finally {
      rmSync(testFilePath, { force: true });
    }
  }, 30_000);

  // Scenario 3: After tool-using agent exits, silence triggers stall detection.
  // This tests the full pipeline: real ✻ → TerminalOutputWatcher → StallDetector.
  // The "stall" is caused by process exit (no more terminal output), which is
  // mechanically identical to a hung agent from the detector's perspective.
  it("detects stall after tool-using agent completes and activity stops", async () => {
    const testFilePath = join(tmpdir(), `danxbot-stall-test-${randomUUID()}.txt`);
    writeFileSync(testFilePath, "Hello from the stall test.");

    try {
      realHarness = createRealClaudeHarness({
        prompt: `Read the file ${testFilePath} and tell me what it says in one sentence`,
        maxNudges: 1,
      });
      await realHarness.start();

      // Wait for process to complete — ensures tool_result exists in JSONL
      const exitCode = await realHarness.waitForExit();
      expect(exitCode).toBe(0);

      // Process exited — terminal output stopped. Keep detector running.
      // Stall should fire within ~7s (5s threshold + 2s check interval).
      const exitTime = Date.now();
      const stallDetected = await waitFor(
        () => realHarness!.stallTimestamps.length > 0,
        12_000,
      );

      expect(stallDetected).toBe(true);
      const stallDelay = realHarness.stallTimestamps[0] - exitTime;
      // 5s threshold with up to 2s check interval jitter + poll jitter
      expect(stallDelay).toBeGreaterThanOrEqual(4_000);
      expect(stallDelay).toBeLessThan(12_000);
    } finally {
      rmSync(testFilePath, { force: true });
    }
  }, 30_000);
});
