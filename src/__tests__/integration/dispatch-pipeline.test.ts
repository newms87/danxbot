/**
 * Integration tests for the agent dispatch pipeline.
 *
 * Tests the REAL wiring: spawnAgent -> SessionLogWatcher -> heartbeat/forwarder -> cleanup.
 * Only the CLI binary is replaced (fake-claude via PATH override). No mocking of
 * launcher, watcher, forwarder, or process-utils.
 *
 * Infrastructure mocks (config, logger, poller/constants, terminal) are necessary
 * because they depend on env vars or OS-specific features — they are not logic under test.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createMockReqWithBody, createMockRes } from "../helpers/http-mocks.js";
import { makeRepoContext } from "../helpers/fixtures.js";

// --- Infrastructure mocks (not logic under test) ---

// vi.hoisted uses require() because it runs before ESM imports are available
const { testState } = vi.hoisted(() => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  return {
    testState: {
      logsDir: fs.mkdtempSync(path.join(os.tmpdir(), "danxbot-test-logs-")),
      reposBase: "/tmp/danxbot-test-repos",
    },
  };
});

vi.mock("../../config.js", () => ({
  config: {
    runtime: "docker",
    isHost: false,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 30_000,
    },
    logsDir: testState.logsDir,
  },
}));

vi.mock("../../poller/constants.js", () => ({
  getReposBase: () => testState.reposBase,
}));

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Terminal mock: intentionally disabled — tests run in docker mode (isHost=false)
vi.mock("../../terminal.js", () => ({
  buildDispatchScript: vi.fn(),
  getTerminalLogPath: vi.fn(),
  spawnInTerminal: vi.fn(),
}));

// --- Real imports (the pipeline under test) ---

import { spawnAgent, cancelJob, type AgentJob } from "../../agent/launcher.js";
import { deriveSessionDir } from "../../agent/session-log-watcher.js";
import { CaptureServer } from "./helpers/capture-server.js";

// --- Test helpers ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");
const fakeClaude = resolve(__dirname, "helpers/fake-claude.ts");
const tsxBin = resolve(projectRoot, "node_modules/.bin/tsx");

let captureServer: CaptureServer;
let tempDir: string;
let repoDir: string;
let sessionDir: string;
let fakeBinDir: string;

/**
 * Create a shell wrapper script named `claude` that runs fake-claude.ts via tsx.
 * This gets prepended to PATH so spawn("claude", ...) finds it.
 */
function createClaudeWrapper(binDir: string): void {
  const wrapperPath = join(binDir, "claude");
  writeFileSync(
    wrapperPath,
    `#!/bin/bash\nexec "${tsxBin}" "${fakeClaude}" "$@"\n`,
  );
  chmodSync(wrapperPath, 0o755);
}

/** Predicate: is this a PUT with the given status in the body? */
function isStatusPut(status: string) {
  return (r: { method: string; body: string }) => {
    if (r.method !== "PUT") return false;
    try { return JSON.parse(r.body).status === status; }
    catch { return false; }
  };
}

/** Wait for capture server to receive N requests matching a predicate, with timeout. */
function waitForRequests(
  predicate: (r: { method: string; path: string; body: string }) => boolean,
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      const matching = captureServer.getRequests().filter(predicate);
      reject(new Error(
        `Expected ${count} matching requests, got ${matching.length} within ${timeoutMs}ms. ` +
        `Total requests: ${captureServer.getRequests().length}`,
      ));
    }, timeoutMs);

    const poll = setInterval(() => {
      const matching = captureServer.getRequests().filter(predicate);
      if (matching.length >= count) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }
    }, 100);
  });
}

/** Build fake-claude env vars for the spawned process. */
function fakeClasudeEnv(overrides?: {
  scenario?: string;
  writeDelayMs?: number;
  exitCode?: number;
  lingerMs?: number;
}): Record<string, string> {
  return {
    PATH: `${fakeBinDir}:${process.env.PATH}`,
    FAKE_CLAUDE_SESSION_DIR: sessionDir,
    FAKE_CLAUDE_SCENARIO: overrides?.scenario ?? "happy",
    FAKE_CLAUDE_WRITE_DELAY_MS: String(overrides?.writeDelayMs ?? 50),
    FAKE_CLAUDE_EXIT_CODE: String(overrides?.exitCode ?? 0),
    FAKE_CLAUDE_LINGER_MS: String(overrides?.lingerMs ?? 3000),
  };
}

/**
 * Spawn an agent and wait for completion. Returns the finished AgentJob.
 * Propagates spawnAgent errors instead of swallowing them.
 */
function runToCompletion(overrides?: {
  scenario?: string;
  writeDelayMs?: number;
  exitCode?: number;
  lingerMs?: number;
  statusUrl?: string;
  apiToken?: string;
  eventForwarding?: { statusUrl: string; apiToken: string };
  timeoutMs?: number;
}): Promise<AgentJob> {
  const statusUrl = overrides?.statusUrl ?? captureServer.statusUrl;
  const apiToken = overrides?.apiToken ?? "test-token";

  return new Promise<AgentJob>((resolve, reject) => {
    spawnAgent({
      prompt: "Integration test task",
      repoName: "test-repo",
      timeoutMs: overrides?.timeoutMs ?? 10_000,
      statusUrl,
      apiToken,
      eventForwarding: overrides?.eventForwarding ?? { statusUrl, apiToken },
      onComplete: resolve,
      env: fakeClasudeEnv(overrides),
    }).catch(reject);
  });
}

// --- Lifecycle ---

beforeAll(() => {
  captureServer = new CaptureServer();
});

beforeEach(async () => {
  vi.clearAllMocks();
  captureServer.clear();
  await captureServer.start();

  tempDir = mkdtempSync(join(tmpdir(), "danxbot-integ-"));
  fakeBinDir = join(tempDir, "bin");
  mkdirSync(fakeBinDir);
  createClaudeWrapper(fakeBinDir);

  testState.reposBase = join(tempDir, "repos");
  repoDir = join(testState.reposBase, "test-repo");
  mkdirSync(repoDir, { recursive: true });

  sessionDir = deriveSessionDir(repoDir);
});

afterEach(async () => {
  await captureServer.stop();
  if (sessionDir && existsSync(sessionDir)) {
    rmSync(sessionDir, { recursive: true, force: true });
  }
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (existsSync(testState.logsDir)) {
    rmSync(testState.logsDir, { recursive: true, force: true });
  }
});

// --- Tests ---

describe("Integration: dispatch pipeline", () => {
  describe("happy path", () => {
    it("completes with status=completed and captures terminal status PUT", async () => {
      const job = await runToCompletion();

      expect(job.status).toBe("completed");
      expect(job.completedAt).toBeInstanceOf(Date);

      await waitForRequests(isStatusPut("completed"), 1);

      const puts = captureServer.getRequestsByMethod("PUT");
      const terminalPut = puts.find(isStatusPut("completed"));
      expect(terminalPut).toBeDefined();
      expect(terminalPut!.path).toBe("/status");
      expect(terminalPut!.headers["authorization"]).toBe("Bearer test-token");
    }, 20_000);

    it("extracts summary from last assistant text in JSONL", async () => {
      const job = await runToCompletion();

      expect(job.status).toBe("completed");
      expect(job.summary).toContain("Task completed successfully");
    }, 20_000);

    it("watcher discovers JSONL file and collects entries", async () => {
      const job = await runToCompletion();

      expect(job.watcher).toBeDefined();
      const entries = job.watcher!.getEntries();
      expect(entries.length).toBeGreaterThan(0);

      const assistantEntries = entries.filter((e) => e.type === "assistant");
      expect(assistantEntries.length).toBeGreaterThanOrEqual(1);

      expect(job.watcher!.getSessionFilePath()).not.toBeNull();
    }, 20_000);
  });

  describe("event forwarding", () => {
    it("forwards watcher entries as batched POSTs to events endpoint", async () => {
      await runToCompletion();

      await waitForRequests((r) => r.method === "POST" && r.path === "/events", 1);

      const posts = captureServer.getRequestsByPath("/events");
      expect(posts.length).toBeGreaterThanOrEqual(1);

      for (const post of posts) {
        const body = JSON.parse(post.body);
        expect(body.events).toBeDefined();
        expect(Array.isArray(body.events)).toBe(true);
        expect(body.events.length).toBeGreaterThan(0);
      }

      const allEvents = posts.flatMap((p) => JSON.parse(p.body).events);
      const eventTypes = new Set(allEvents.map((e: { type: string }) => e.type));
      expect(eventTypes.has("agent_event") || eventTypes.has("tool_call")).toBe(true);
    }, 20_000);
  });

  describe("inactivity timeout", () => {
    it("fires timeout when fake claude stops writing JSONL", async () => {
      const job = await runToCompletion({ scenario: "slow", timeoutMs: 2_000 });

      expect(job.status).toBe("timeout");
      expect(job.summary).toContain("timed out");
      expect(job.completedAt).toBeInstanceOf(Date);
    }, 20_000);
  });

  describe("error exit", () => {
    it("transitions to failed when fake claude exits non-zero", async () => {
      const job = await runToCompletion({ scenario: "error", exitCode: 1 });

      expect(job.status).toBe("failed");
      expect(job.completedAt).toBeInstanceOf(Date);
      expect(job.summary).toBeTruthy();

      await waitForRequests(isStatusPut("failed"), 1);

      const failedPut = captureServer.getRequestsByMethod("PUT").find(isStatusPut("failed"));
      expect(failedPut).toBeDefined();
    }, 20_000);
  });

  describe("cancel", () => {
    it("cancels a running job via cancelJob and sends canceled status PUT", async () => {
      // Spawn a slow agent that stays alive until killed
      const job = await spawnAgent({
        prompt: "Integration test task",
        repoName: "test-repo",
        timeoutMs: 30_000,
        statusUrl: captureServer.statusUrl,
        apiToken: "test-token",
        env: fakeClasudeEnv({ scenario: "slow" }),
      });

      expect(job.status).toBe("running");

      // Cancel after a brief delay to let the process start
      await new Promise((r) => setTimeout(r, 500));
      await cancelJob(job, "test-token");

      // cancelJob sets _canceling flag before SIGTERM, so the close handler
      // correctly uses "canceled" status instead of "failed".
      expect(job.status).toBe("canceled");
      expect(job.completedAt).toBeInstanceOf(Date);

      await waitForRequests(isStatusPut("canceled"), 1);

      const cancelPut = captureServer.getRequestsByMethod("PUT").find(isStatusPut("canceled"));
      expect(cancelPut).toBeDefined();
    }, 20_000);
  });

  describe("cleanup", () => {
    it("stops watcher and clears heartbeat on completion", async () => {
      const job = await runToCompletion();

      expect(job.heartbeatInterval).toBeUndefined();
    }, 20_000);

    it("flushes forwarder on completion", async () => {
      await runToCompletion();

      await waitForRequests((r) => r.method === "POST" && r.path === "/events", 1);

      const eventPosts = captureServer.getRequestsByPath("/events");
      expect(eventPosts.length).toBeGreaterThanOrEqual(1);
    }, 20_000);
  });

  describe("no statusUrl", () => {
    it("completes without sending heartbeat PUTs", async () => {
      const job = await new Promise<AgentJob>((resolve, reject) => {
        spawnAgent({
          prompt: "Integration test task",
          repoName: "test-repo",
          timeoutMs: 10_000,
          onComplete: resolve,
          env: fakeClasudeEnv(),
        }).catch(reject);
      });

      expect(job.status).toBe("completed");

      const puts = captureServer.getRequestsByMethod("PUT");
      expect(puts.length).toBe(0);

      const posts = captureServer.getRequestsByPath("/events");
      expect(posts.length).toBe(0);
    }, 20_000);
  });

  describe("dispatch handleLaunch integration", () => {
    it("full HTTP path: POST /api/launch -> spawnAgent -> JSONL -> completion", async () => {
      const { handleLaunch, clearJobCleanupIntervals } = await import("../../worker/dispatch.js");

      const repo = makeRepoContext({ name: "test-repo", localPath: repoDir });

      // Set fake-claude env vars in process.env (buildCleanEnv copies from process.env)
      const originalPath = process.env.PATH;
      const envKeys = Object.keys(fakeClasudeEnv());
      const envSnapshot = fakeClasudeEnv();
      Object.assign(process.env, envSnapshot);

      try {
        const req = createMockReqWithBody("POST", {
          task: "Integration test via handleLaunch",
          api_token: "test-token",
          status_url: captureServer.statusUrl,
        });
        const res = createMockRes();

        await handleLaunch(req, res, repo);

        expect(res._getStatusCode()).toBe(200);
        const body = JSON.parse(res._getBody());
        expect(body.status).toBe("launched");
        expect(body.job_id).toBeDefined();

        await waitForRequests(isStatusPut("completed"), 1, 15_000);

        const puts = captureServer.getRequestsByMethod("PUT");
        expect(puts.length).toBeGreaterThanOrEqual(1);

        clearJobCleanupIntervals();
      } finally {
        process.env.PATH = originalPath;
        for (const key of envKeys) {
          if (key !== "PATH") delete process.env[key];
        }
      }
    }, 30_000);

    it("GET /api/status returns summed token usage from the dispatch JSONL", async () => {
      const { handleLaunch, handleStatus, clearJobCleanupIntervals } = await import(
        "../../worker/dispatch.js"
      );

      const repo = makeRepoContext({ name: "test-repo", localPath: repoDir });

      const originalPath = process.env.PATH;
      const envKeys = Object.keys(fakeClasudeEnv());
      Object.assign(process.env, fakeClasudeEnv());

      try {
        const launchReq = createMockReqWithBody("POST", {
          task: "Usage aggregation end-to-end",
          api_token: "test-token",
          status_url: captureServer.statusUrl,
        });
        const launchRes = createMockRes();

        await handleLaunch(launchReq, launchRes, repo);
        const { job_id } = JSON.parse(launchRes._getBody());

        await waitForRequests(isStatusPut("completed"), 1, 15_000);

        const statusRes = createMockRes();
        handleStatus(statusRes, job_id);
        const status = JSON.parse(statusRes._getBody());

        // Fake-claude "happy" scenario emits two assistant entries with usage:
        //   { input_tokens: 100, output_tokens: 50 }
        //   { input_tokens: 200, output_tokens: 80 }
        // JSONL is the single canonical source; /api/status must sum these.
        expect(status).toMatchObject({
          job_id,
          status: "completed",
          input_tokens: 300,
          output_tokens: 130,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        });

        clearJobCleanupIntervals();
      } finally {
        process.env.PATH = originalPath;
        for (const key of envKeys) {
          if (key !== "PATH") delete process.env[key];
        }
      }
    }, 30_000);
  });
});
