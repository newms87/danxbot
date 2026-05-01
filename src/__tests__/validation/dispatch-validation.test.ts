/**
 * Validation tests for agent dispatch pipeline — real Claude API.
 *
 * Tests the dispatch + poller launch paths against the real Claude CLI.
 * Gated behind ANTHROPIC_API_KEY — excluded from `npx vitest run` by default.
 * Run with: `npm run test:validate`
 *
 * Token budget: 200k cumulative FRESH input tokens (excludes cache-read tokens,
 * which are ~10x cheaper and already paid for by the creating request). Each
 * test spawns a minimal prompt; claude's system prompt + tool loading accounts
 * for most of the fresh-input cost per cold spawn. Cache reads are tracked
 * separately for observability but not charged against the budget.
 *
 * NOTE: This file must NOT import from ./setup.js — it contains vi.mock("fs/promises")
 * that vitest hoists, which would break SessionLogWatcher's real fs access.
 * Instead, we mock only config, logger, terminal, and poller/constants.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { CaptureServer } from "../integration/helpers/capture-server.js";
import {
  SessionLogWatcher,
} from "../../agent/session-log-watcher.js";
import type { AgentJob, SpawnAgentOptions } from "../../agent/launcher.js";
import type { AgentLogEntry } from "../../types.js";

// Inlined to avoid importing setup.js (vi.mock hoisting breaks real fs access)
function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// --- Infrastructure mocks (not logic under test) ---
// spawnAgent imports config.ts which requires DB env vars. We mock the
// minimal infrastructure needed so the real spawn/watcher code runs.

const { testState } = vi.hoisted(() => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  return {
    testState: {
      logsDir: fs.mkdtempSync(path.join(os.tmpdir(), "danxbot-val-logs-")),
    },
  };
});

vi.mock("../../config.js", () => ({
  config: {
    runtime: "host",
    isHost: true,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 120_000,
    },
    agent: {
      model: "claude-sonnet-4-6",
      routerModel: "claude-haiku-4-5-20251001",
      maxTurns: 3,
      maxBudgetUsd: 0.50,
      maxThinkingTokens: 4000,
      timeoutMs: 120_000,
      maxThreadMessages: 10,
      maxRetries: 0,
    },
    logsDir: testState.logsDir,
  },
}));

vi.mock("../../poller/constants.js", () => ({
  getReposBase: () => process.cwd(),
}));

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../terminal.js", () => ({
  buildDispatchScript: vi.fn(),
  getTerminalLogPath: vi.fn(),
  spawnInTerminal: vi.fn(),
}));

// --- Token Budget Tracker ---

const TOKEN_BUDGET = 200_000;
let cumulativeInputTokens = 0;
let cumulativeOutputTokens = 0;
let cumulativeCacheReadTokens = 0;

/**
 * Parse a JSONL session file and sum all usage tokens from assistant entries.
 */
function extractTokenUsageFromJsonl(filePath: string): { inputTokens: number; outputTokens: number; cacheReadTokens: number } {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let skippedLines = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant" && entry.message?.usage) {
        // `input_tokens` is fresh (uncached) input — the real cost driver.
        // `cache_read_input_tokens` is ~10% of the price; tracked separately
        // for observability but not charged against the budget.
        inputTokens += entry.message.usage.input_tokens ?? 0;
        outputTokens += entry.message.usage.output_tokens ?? 0;
        cacheReadTokens += entry.message.usage.cache_read_input_tokens ?? 0;
      }
    } catch {
      skippedLines++;
    }
  }

  if (skippedLines > 0) {
    console.warn(`[Token Budget] Skipped ${skippedLines} malformed JSONL lines in ${filePath}`);
  }

  return { inputTokens, outputTokens, cacheReadTokens };
}

/** Track token usage from a specific JSONL file path. */
function trackTokensFromFile(filePath: string): void {
  if (!filePath || !existsSync(filePath)) return;
  const usage = extractTokenUsageFromJsonl(filePath);
  cumulativeInputTokens += usage.inputTokens;
  cumulativeOutputTokens += usage.outputTokens;
  cumulativeCacheReadTokens += usage.cacheReadTokens;
}

function checkTokenBudget(): void {
  if (cumulativeInputTokens > TOKEN_BUDGET) {
    throw new Error(
      `Token budget exceeded: ${cumulativeInputTokens} input tokens used, budget is ${TOKEN_BUDGET}`,
    );
  }
}

// --- Test helpers ---

let spawnAgent: typeof import("../../agent/launcher.js").spawnAgent;
let captureServer: CaptureServer;
let tempDir: string;
const jsonlFilesToTrack: string[] = [];

/** Spawn an agent and wait for onComplete. Reduces boilerplate across tests. */
function spawnAndAwait(opts: Partial<SpawnAgentOptions> & { prompt: string }): Promise<AgentJob> {
  return new Promise<AgentJob>((resolve, reject) => {
    spawnAgent({
      repoName: ".",
      timeoutMs: 60_000,
      maxRuntimeMs: 90_000,
      cwd: "/tmp/test-workspace",
      ...opts,
      onComplete: resolve,
    }).catch(reject);
  });
}

describe.skipIf(!hasApiKey())("validation: dispatch pipeline (real Claude API)", () => {
  beforeAll(async () => {
    captureServer = new CaptureServer();

    const launcher = await import("../../agent/launcher.js");
    spawnAgent = launcher.spawnAgent;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    captureServer.clear();
    await captureServer.start();

    tempDir = mkdtempSync(join(tmpdir(), "danxbot-val-"));
  });

  afterEach(async () => {
    await captureServer.stop();

    for (const filePath of jsonlFilesToTrack) {
      trackTokensFromFile(filePath);
    }
    jsonlFilesToTrack.length = 0;

    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    console.log(
      `\n[Token Budget] Fresh input: ${cumulativeInputTokens} / ${TOKEN_BUDGET} | Output: ${cumulativeOutputTokens} | Cache reads (not budgeted): ${cumulativeCacheReadTokens}`,
    );

    if (existsSync(testState.logsDir)) {
      rmSync(testState.logsDir, { recursive: true, force: true });
    }

    if (cumulativeInputTokens > TOKEN_BUDGET) {
      throw new Error(
        `Token budget exceeded: ${cumulativeInputTokens} input tokens, budget is ${TOKEN_BUDGET}`,
      );
    }
  });

  // -------------------------
  // Dispatch Path Tests
  // -------------------------

  describe("dispatch path", () => {
    it("creates JSONL, watcher discovers by tag, summary extracted, status PUTs sent", async () => {
      const job = await spawnAndAwait({
        prompt: "Summarize in one short sentence: Danxbot is an AI agent that processes Trello cards.",
        statusUrl: captureServer.statusUrl,
        apiToken: "val-token",
      });

      expect(job.status).toBe("completed");
      expect(job.completedAt).toBeInstanceOf(Date);

      // Summary extraction
      expect(job.summary).toBeTruthy();
      expect(job.summary.length).toBeGreaterThan(5);

      // Watcher must have discovered the JSONL file
      expect(job.watcher).toBeDefined();
      const watcherPath = job.watcher!.getSessionFilePath();
      expect(watcherPath).not.toBeNull();
      expect(existsSync(watcherPath!)).toBe(true);
      jsonlFilesToTrack.push(watcherPath!);

      // Watcher collected entries from real JSONL
      const entries = job.watcher!.getEntries();
      expect(entries.length).toBeGreaterThan(0);
      const assistantEntries = entries.filter((e) => e.type === "assistant");
      expect(assistantEntries.length).toBeGreaterThanOrEqual(1);

      // Status PUTs: putStatus fires asynchronously — wait for it to land
      await new Promise((r) => setTimeout(r, 2_000));

      const puts = captureServer.getRequestsByMethod("PUT");

      // Completed PUT should exist with auth header
      const completedPut = puts.find((r) => {
        try { return JSON.parse(r.body).status === "completed"; }
        catch { return false; }
      });
      expect(completedPut).toBeDefined();
      expect(completedPut!.headers["authorization"]).toBe("Bearer val-token");

      checkTokenBudget();
    }, 120_000);
  });

  // -------------------------
  // Poller Path Tests
  // -------------------------

  describe("poller path", () => {
    it("fires onComplete with status completed and completedAt set", async () => {
      const job = await spawnAndAwait({
        prompt: "Reply with exactly one word: OK",
      });

      const watcherPath = job.watcher?.getSessionFilePath();
      if (watcherPath) jsonlFilesToTrack.push(watcherPath);

      expect(job.status).toBe("completed");
      expect(job.completedAt).toBeInstanceOf(Date);
      expect(job.completedAt!.getTime()).toBeGreaterThan(job.startedAt.getTime());

      checkTokenBudget();
    }, 120_000);

    it("sends zero HTTP requests when statusUrl is absent", async () => {
      const job = await spawnAndAwait({
        prompt: "Reply with exactly one word: SILENT",
      });

      const watcherPath = job.watcher?.getSessionFilePath();
      if (watcherPath) jsonlFilesToTrack.push(watcherPath);

      const allRequests = captureServer.getRequests();
      expect(allRequests.length).toBe(0);

      checkTokenBudget();
    }, 120_000);
  });

});
