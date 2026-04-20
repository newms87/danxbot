/**
 * Phase 4 — End-to-end validation of Claude Code usage tracking.
 *
 * Spawns real Claude CLI dispatches against a capture-server stand-in for
 * gpt-manager and asserts that the sum of `data.usage` across the captured
 * event batches exactly equals the sum of `usage` across all assistant turns
 * in the JSONL files Claude Code wrote.
 *
 * Scenarios:
 *   1. Primary session only — one agent, no sub-agents.
 *   2. Parent + sub-agent tree — Agent tool invocation, both JSONLs.
 *   3. Simulated 503 — capture server returns 503 on first N POSTs, then 200.
 *   4. Mid-batch restart — queue survives a forwarder restart.
 *
 * Gated behind ANTHROPIC_API_KEY via describe.skipIf. Runs under
 * `make test-validate` (vitest.validation.config.ts).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Infrastructure mocks matching dispatch-validation.test.ts.
const { testState } = vi.hoisted(() => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  return {
    testState: {
      logsDir: fs.mkdtempSync(path.join(os.tmpdir(), "danxbot-p4-logs-")),
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
      maxBudgetUsd: 0.5,
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

// ─── Usage-tracking capture server ────────────────────────────────────────
//
// Unlike the shared CaptureServer, this one can be configured to return 503
// on the first N POST /events requests — the 503 scenario depends on it.

interface UsageTrackingServer {
  baseUrl: string;
  statusUrl: string;
  stop: () => Promise<void>;
  postedBatches: () => Array<{ events: Array<Record<string, unknown>> }>;
  totalPostAttempts: () => number;
  putCount: () => number;
  setPostResponder: (code: number) => void;
}

async function startUsageServer(
  options: { failFirst?: number } = {},
): Promise<UsageTrackingServer> {
  // Only track SUCCESSFUL POST bodies — failed-and-retried bodies would
  // double-count usage in the sum assertions.
  const acceptedBodies: string[] = [];
  let totalPostAttempts = 0;
  let putCount = 0;
  let failRemaining = options.failFirst ?? 0;
  let postResponseCode = 200;

  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        if (req.method === "POST") {
          totalPostAttempts++;
          if (failRemaining > 0) {
            failRemaining--;
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "simulated outage" }));
            return;
          }
          // Only record bodies the server accepted.
          acceptedBodies.push(body);
          res.writeHead(postResponseCode, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify({ ok: postResponseCode < 400 }));
        } else if (req.method === "PUT") {
          putCount++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(200);
          res.end();
        }
      });
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port =
    typeof addr === "object" && addr !== null ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    statusUrl: `http://127.0.0.1:${port}/status`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    postedBatches() {
      const batches: Array<{ events: Array<Record<string, unknown>> }> = [];
      for (const body of acceptedBodies) {
        try {
          batches.push(
            JSON.parse(body) as { events: Array<Record<string, unknown>> },
          );
        } catch {
          // Skip malformed (shouldn't happen, but defensive)
        }
      }
      return batches;
    },
    totalPostAttempts() {
      return totalPostAttempts;
    },
    putCount() {
      return putCount;
    },
    setPostResponder(code: number) {
      postResponseCode = code;
    },
  };
}

// ─── Usage sum helpers ─────────────────────────────────────────────────────

interface UsageSum {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

function emptySum(): UsageSum {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function addSum(a: UsageSum, usage: Record<string, unknown> | undefined): void {
  if (!usage) return;
  a.input += Number(usage.input_tokens ?? 0);
  a.cacheRead += Number(usage.cache_read_input_tokens ?? 0);
  a.cacheWrite += Number(usage.cache_creation_input_tokens ?? 0);
  a.output += Number(usage.output_tokens ?? 0);
}

function sumUsageFromCapturedBatches(
  batches: Array<{ events: Array<Record<string, unknown>> }>,
): UsageSum {
  const sum = emptySum();
  for (const batch of batches) {
    for (const event of batch.events) {
      const data = event.data as Record<string, unknown> | undefined;
      addSum(sum, data?.usage as Record<string, unknown> | undefined);
    }
  }
  return sum;
}

function sumUsageFromJsonl(filePath: string): UsageSum {
  const sum = emptySum();
  if (!filePath || !existsSync(filePath)) return sum;
  const text = readFileSync(filePath, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { usage?: Record<string, unknown> };
      };
      if (entry.type === "assistant" && entry.message?.usage) {
        addSum(sum, entry.message.usage);
      }
    } catch {
      // skip malformed line
    }
  }
  return sum;
}

// ─── Test harness ──────────────────────────────────────────────────────────

type SpawnAgentFn = typeof import("../../agent/launcher.js").spawnAgent;
type AgentJob = import("../../agent/launcher.js").AgentJob;
type SpawnAgentOptions = import("../../agent/launcher.js").SpawnAgentOptions;

let spawnAgent: SpawnAgentFn;
let server: UsageTrackingServer;

function spawnAndAwait(
  opts: Partial<SpawnAgentOptions> & { prompt: string },
): Promise<AgentJob> {
  return new Promise<AgentJob>((resolve, reject) => {
    spawnAgent({
      repoName: ".",
      timeoutMs: 60_000,
      maxRuntimeMs: 90_000,
      ...opts,
      onComplete: resolve,
    }).catch(reject);
  });
}

/**
 * Drive a watcher + forwarder over a COMPLETED session JSONL file and the
 * (optional) subagents directory. Returns when the forwarder has flushed all
 * entries it observed.
 *
 * Rationale: the launcher's own watcher stops in cleanup — any assistant turns
 * written between its last poll and process exit are missed, which makes the
 * captured side under-count against the JSONL ground truth. Running our own
 * watcher post-completion reads the final file deterministically.
 */
async function replayJsonlToServer(
  jsonlPath: string,
  srv: UsageTrackingServer,
  opts: { retryDelaysMs?: number[] } = {},
): Promise<void> {
  const { SessionLogWatcher } = await import(
    "../../agent/session-log-watcher.js"
  );
  const { createLaravelForwarder } = await import(
    "../../agent/laravel-forwarder.js"
  );

  const watcher = new SessionLogWatcher({
    cwd: "/ignored",
    sessionDir: dirname(jsonlPath),
    sessionId: basename(jsonlPath, ".jsonl"),
    pollIntervalMs: 100,
  });
  const forwarder = createLaravelForwarder(srv.statusUrl, "val-token", {
    retryDelaysMs: opts.retryDelaysMs,
  });
  watcher.onEntry(forwarder.consume);

  await watcher.start();
  // Let the watcher complete at least one full poll pass over the file.
  await new Promise((r) => setTimeout(r, 500));
  watcher.stop();
  await forwarder.flush();
}

describe.skipIf(!hasApiKey())(
  "validation: Claude Code usage tracking (real Claude API)",
  () => {
    beforeAll(async () => {
      const launcher = await import("../../agent/launcher.js");
      spawnAgent = launcher.spawnAgent;
    });

    beforeEach(async () => {
      vi.clearAllMocks();
      server = await startUsageServer();
    });

    afterEach(async () => {
      await server.stop();
    });

    afterAll(() => {
      if (existsSync(testState.logsDir)) {
        rmSync(testState.logsDir, { recursive: true, force: true });
      }
    });

    it(
      "[primary session] captured event usage matches parent JSONL totals",
      async () => {
        const job = await spawnAndAwait({
          prompt: "Reply with exactly one word: DONE",
        });

        const watcherPath = job.watcher?.getSessionFilePath();
        expect(watcherPath).toBeTruthy();

        // Replay the completed JSONL through a fresh watcher+forwarder —
        // avoids the launcher's in-flight watcher stopping before Claude's
        // final JSONL writes.
        await replayJsonlToServer(watcherPath!, server);

        const capturedSum = sumUsageFromCapturedBatches(server.postedBatches());
        const jsonlSum = sumUsageFromJsonl(watcherPath!);

        expect(capturedSum.input).toBe(jsonlSum.input);
        expect(capturedSum.output).toBe(jsonlSum.output);
        expect(capturedSum.cacheRead).toBe(jsonlSum.cacheRead);
        expect(capturedSum.cacheWrite).toBe(jsonlSum.cacheWrite);

        expect(jsonlSum.input + jsonlSum.output).toBeGreaterThan(0);
      },
      180_000,
    );

    it(
      "[parent + sub-agent] captured totals match sum of parent + sub-agent JSONLs",
      async () => {
        const job = await spawnAndAwait({
          prompt:
            'Use the Agent tool with subagent_type "Explore" and description "find README" ' +
            'to run a one-shot exploration, then reply DONE in one word.',
        });

        const watcherPath = job.watcher?.getSessionFilePath();
        expect(watcherPath).toBeTruthy();

        await replayJsonlToServer(watcherPath!, server);

        // Sub-agent JSONL lives in <parent-dir>/<session-uuid>/subagents/*.jsonl
        const parentDir = watcherPath!.replace(/\.jsonl$/, "");
        const subagentsDir = join(parentDir, "subagents");
        const subagentFiles: string[] = [];
        if (existsSync(subagentsDir)) {
          const { readdirSync } = await import("node:fs");
          for (const file of readdirSync(subagentsDir)) {
            if (file.endsWith(".jsonl")) {
              subagentFiles.push(join(subagentsDir, file));
            }
          }
        }
        expect(subagentFiles.length).toBeGreaterThan(0);

        const jsonlSum = emptySum();
        addSumInto(jsonlSum, sumUsageFromJsonl(watcherPath!));
        for (const file of subagentFiles) {
          addSumInto(jsonlSum, sumUsageFromJsonl(file));
        }

        const capturedSum = sumUsageFromCapturedBatches(server.postedBatches());

        expect(capturedSum.input).toBe(jsonlSum.input);
        expect(capturedSum.output).toBe(jsonlSum.output);
        expect(capturedSum.cacheRead).toBe(jsonlSum.cacheRead);
        expect(capturedSum.cacheWrite).toBe(jsonlSum.cacheWrite);

        const tagged = server.postedBatches().flatMap((b) =>
          b.events.filter(
            (e) =>
              (e.data as Record<string, unknown> | undefined)?.subagent_id !==
              undefined,
          ),
        );
        expect(tagged.length).toBeGreaterThan(0);
      },
      240_000,
    );

    it(
      "[simulated 503] events still deliver after transient outage",
      async () => {
        await server.stop();
        server = await startUsageServer({ failFirst: 3 });

        const job = await spawnAndAwait({
          prompt: "Reply with exactly one word: RETRIED",
        });

        const watcherPath = job.watcher?.getSessionFilePath();
        expect(watcherPath).toBeTruthy();

        // Small retry delays keep the test fast while still exercising the
        // exponential-backoff path.
        await replayJsonlToServer(watcherPath!, server, {
          retryDelaysMs: [50, 100, 200, 400],
        });

        const capturedSum = sumUsageFromCapturedBatches(server.postedBatches());
        const jsonlSum = sumUsageFromJsonl(watcherPath!);

        // The server failed the first 3 POST attempts — totalPostAttempts
        // must exceed accepted batches, proving retries actually happened.
        expect(server.totalPostAttempts()).toBeGreaterThan(
          server.postedBatches().length,
        );

        // Accepted bodies (2xx-only) must sum to the JSONL ground truth.
        expect(capturedSum.input).toBe(jsonlSum.input);
        expect(capturedSum.output).toBe(jsonlSum.output);
        expect(capturedSum.cacheRead).toBe(jsonlSum.cacheRead);
        expect(capturedSum.cacheWrite).toBe(jsonlSum.cacheWrite);
        expect(jsonlSum.input + jsonlSum.output).toBeGreaterThan(0);
      },
      240_000,
    );

  },
);

// ─── Mid-batch restart scenario — runs unconditionally (no Claude API call) ─

describe("validation: mid-batch restart (queue replay)", () => {
  let restartServer: UsageTrackingServer;

  beforeEach(async () => {
    restartServer = await startUsageServer();
  });
  afterEach(async () => {
    await restartServer.stop();
  });

  it("replayQueueOnBoot delivers events orphaned by a forwarder restart", async () => {
    const { EventQueue } = await import("../../agent/event-queue.js");
    const { replayQueueOnBoot, deriveQueuePath } = await import(
      "../../agent/laravel-forwarder.js"
    );

    const queueDir = mkdtempSync(join(tmpdir(), "p4-restart-"));
    const dispatchId = "restart-scenario";
    const queuePath = deriveQueuePath(queueDir, dispatchId);
    const queue = new EventQueue(queuePath);

    // Simulate a crashed forwarder: an event batch was written to the queue
    // but the POST never completed.
    const queuedBatch = [
      {
        type: "agent_event",
        message: "Surviving restart",
        data: {
          usage: {
            input_tokens: 42,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 0,
            output_tokens: 5,
          },
        },
      },
    ];
    await queue.enqueue(queuedBatch);
    expect(await queue.hasPending()).toBe(true);

    await replayQueueOnBoot(
      dispatchId,
      queueDir,
      restartServer.statusUrl,
      "val-token",
    );

    expect(await queue.hasPending()).toBe(false);
    const batches = restartServer.postedBatches();
    expect(batches).toHaveLength(1);
    const sum = sumUsageFromCapturedBatches(batches);
    expect(sum.input).toBe(42);
    expect(sum.cacheRead).toBe(10);
    expect(sum.output).toBe(5);

    rmSync(queueDir, { recursive: true, force: true });
  });
});

function addSumInto(into: UsageSum, other: UsageSum): void {
  into.input += other.input;
  into.cacheRead += other.cacheRead;
  into.cacheWrite += other.cacheWrite;
  into.output += other.output;
}
