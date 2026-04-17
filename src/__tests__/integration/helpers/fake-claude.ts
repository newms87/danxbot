/**
 * Fake Claude CLI — Writes JSONL session files matching real Claude Code's format.
 *
 * Spawned as a child process by integration tests (via PATH override so the real
 * `claude` binary is replaced). Reads the prompt from CLI args, extracts the
 * dispatch tag, creates a JSONL session file at the expected location, and writes
 * entries simulating a real agent session.
 *
 * Usage:
 *   node --import tsx/esm fake-claude.ts --dangerously-skip-permissions \
 *     --verbose -p "<prompt>"
 *
 * Environment variables:
 *   FAKE_CLAUDE_SESSION_DIR — Override the session directory (required for test isolation)
 *   FAKE_CLAUDE_SCENARIO — Controls behavior: "happy" (default), "error", "slow", "empty"
 *   FAKE_CLAUDE_WRITE_DELAY_MS — Delay between JSONL entries (default: 50)
 *   FAKE_CLAUDE_EXIT_CODE — Exit code (default: 0, set to non-zero for error scenarios)
 *   FAKE_CLAUDE_LINGER_MS — Time to wait after writing entries before exiting (default: 3000).
 *                           Gives SessionLogWatcher time to discover the file (~1s) and poll.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);

// Extract prompt from -p argument (last two args: "-p" "<prompt>")
const promptIdx = args.lastIndexOf("-p");
const prompt = promptIdx >= 0 && promptIdx + 1 < args.length ? args[promptIdx + 1] : "";

// Extract dispatch ID from the prompt tag
const dispatchMatch = prompt.match(/<!-- danxbot-dispatch:([^\s]+) -->/);
const dispatchId = dispatchMatch?.[1] || "unknown";

// Config from env
const sessionDir = process.env.FAKE_CLAUDE_SESSION_DIR;
if (!sessionDir) {
  process.stderr.write("FAKE_CLAUDE_SESSION_DIR is required\n");
  process.exit(1);
}

const scenario = process.env.FAKE_CLAUDE_SCENARIO || "happy";
const writeDelayMs = parseInt(process.env.FAKE_CLAUDE_WRITE_DELAY_MS || "50", 10);
const exitCode = parseInt(process.env.FAKE_CLAUDE_EXIT_CODE || "0", 10);
const lingerMs = parseInt(process.env.FAKE_CLAUDE_LINGER_MS || "3000", 10);

// Create session directory and file
mkdirSync(sessionDir, { recursive: true });
const sessionId = randomUUID();
const jsonlPath = join(sessionDir, `${sessionId}.jsonl`);

function writeEntry(entry: Record<string, unknown>): void {
  appendFileSync(jsonlPath, JSON.stringify(entry) + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario(): Promise<void> {
  const now = new Date().toISOString();

  // Write the user message (contains the dispatch tag — watcher scans for this)
  writeEntry({
    type: "user",
    message: { content: prompt },
    timestamp: now,
    sessionId,
  });

  await sleep(writeDelayMs);

  if (scenario === "empty") {
    // No assistant messages — just exit
    return;
  }

  // First assistant message — watcher synthesizes init from this
  writeEntry({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "I'll help you with that task." },
        { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "/test/file.ts" } },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(writeDelayMs);

  // Tool result
  writeEntry({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tool_1", content: "file contents here", is_error: false },
      ],
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(writeDelayMs);

  if (scenario === "slow") {
    // Simulate a slow agent — write one message then go quiet
    // The inactivity timer should fire
    writeEntry({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Let me think about this..." }],
        usage: { input_tokens: 150, output_tokens: 20 },
      },
      timestamp: new Date().toISOString(),
      sessionId,
    });

    // Stay alive but silent — keep the event loop running so the process
    // doesn't exit. The parent kills us via inactivity timeout (SIGTERM) or
    // cancelJob (SIGTERM then SIGKILL). We do NOT handle SIGTERM here so the
    // default behavior (exit with signal) fires, matching real claude behavior
    // where SIGTERM causes a non-zero exit.
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
    return;
  }

  if (scenario === "error") {
    // Write a result entry indicating error, then linger + exit with non-zero
    writeEntry({
      type: "result",
      subtype: "error",
      cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 500,
      duration_api_ms: 400,
      is_error: true,
      result: "Agent encountered an error",
      timestamp: new Date().toISOString(),
      sessionId,
    });

    // Linger so SessionLogWatcher can discover and poll the file
    await sleep(lingerMs);
    process.exit(exitCode || 1);
    return;
  }

  // Happy path — second assistant message (final answer)
  writeEntry({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Task completed successfully. Here are the results." }],
      usage: { input_tokens: 200, output_tokens: 80 },
    },
    timestamp: new Date().toISOString(),
    sessionId,
  });

  await sleep(writeDelayMs);

  // Result entry — session complete
  writeEntry({
    type: "result",
    subtype: "success",
    cost_usd: 0.05,
    num_turns: 2,
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    result: "Task completed successfully. Here are the results.",
    timestamp: new Date().toISOString(),
    sessionId,
  });

  // Linger so SessionLogWatcher can discover and poll the file before process exits.
  // In production, agents run for minutes; in tests, this simulates that buffer.
  await sleep(lingerMs);
}

runScenario()
  .then(() => {
    process.exit(exitCode);
  })
  .catch((err) => {
    process.stderr.write(`fake-claude error: ${err}\n`);
    process.exit(1);
  });
