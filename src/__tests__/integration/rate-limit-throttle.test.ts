/**
 * Integration test for the Anthropic rate-limit throttle pipeline
 * (DX-322).
 *
 * Exercises the REAL wiring end-to-end:
 *
 *     spawnAgent (FAKE_CLAUDE_SCENARIO=rate-limit)
 *       → SessionLogWatcher discovers the synthetic JSONL pair
 *       → ApiErrorDetector classifies kind="rate_limit" + parses
 *         resume_at via Intl.DateTimeFormat
 *       → handleRateLimitThrottle writes throttle flag with resume_at
 *         + kills the dispatch (status="throttled")
 *
 * Two distinct assertions vs the stream-idle pipeline:
 *
 *   1. The throttle handler does NOT increment `recoverCount` — even
 *      starting at recoverCount=0, the first rate-limit synthetic
 *      jumps straight to the throttle handler (no /api/resume POST,
 *      no MAX_RECOVERS cap walk).
 *
 *   2. The flag file lands with `source: "throttle"` + a parseable
 *      `resume_at` ISO. `readFlag` past the deadline auto-unlinks
 *      the file and returns null — that's the poller's "I can
 *      dispatch again" signal, with no operator action required.
 *
 * Only the CLI binary is replaced (fake-claude via PATH override).
 * The DB and Slack listener are mocked exactly like
 * `api-error-recover.test.ts` does; the watcher, detector,
 * throttle handler, cleanup chain, and flag I/O are all real
 * production code.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// --- Infrastructure mocks (not logic under test) ---

const { testState, mockConfig } = vi.hoisted(() => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  return {
    testState: {
      logsDir: fs.mkdtempSync(
        path.join(os.tmpdir(), "danxbot-throttle-logs-"),
      ),
    },
    mockConfig: {
      runtime: "docker",
      isHost: false,
      dispatch: {
        defaultApiUrl: "http://localhost:80",
        agentTimeoutMs: 30_000,
        mcpProbeTimeoutMs: 3_000,
      },
      logsDir: "",
    },
  };
});

mockConfig.logsDir = testState.logsDir;

vi.mock("../../config.js", () => ({ config: mockConfig }));

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

// dispatches-db stub — the recover path calls `recordRecoverCount` →
// `updateDispatch` and the spawn tracking starts a row. Treat both as
// no-ops so the test exercises the JSONL+throttle pipeline without a
// real DB.
vi.mock("../../dashboard/dispatches-db.js", () => ({
  insertDispatch: vi.fn().mockResolvedValue(undefined),
  updateDispatch: vi.fn().mockResolvedValue(undefined),
  getDispatchById: vi.fn().mockResolvedValue(null),
  findNonTerminalDispatches: vi.fn().mockResolvedValue([]),
  findLatestDispatchBySlackThread: vi.fn().mockResolvedValue(null),
  listDispatches: vi.fn().mockResolvedValue([]),
  deleteOldDispatches: vi.fn().mockResolvedValue([]),
  countDispatchesByRepo: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../slack/listener.js", () => ({
  getSlackClientForRepo: vi.fn(),
}));

// --- Real imports ---

import { spawnAgent, type AgentJob } from "../../agent/launcher.js";
import { deriveSessionDir } from "../../agent/session-log-watcher.js";
import { CaptureServer } from "./helpers/capture-server.js";
import { flagPath, readFlag } from "../../critical-failure.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");
const fakeClaude = resolve(__dirname, "helpers/fake-claude.ts");
const tsxBin = resolve(projectRoot, "node_modules/.bin/tsx");

let captureServer: CaptureServer;
let tempDir: string;
let repoDir: string;
let workspaceCwd: string;
let sessionDir: string;
let fakeBinDir: string;

function createClaudeWrapper(binDir: string): void {
  const wrapperPath = join(binDir, "claude");
  writeFileSync(
    wrapperPath,
    `#!/bin/bash\nexec "${tsxBin}" "${fakeClaude}" "$@"\n`,
  );
  chmodSync(wrapperPath, 0o755);
}

function captureServerPort(): number {
  const m = captureServer.baseUrl.match(/:(\d+)$/);
  if (!m) throw new Error(`Cannot parse port from ${captureServer.baseUrl}`);
  return Number(m[1]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spawn an agent in the rate-limit scenario. The flag file is the
 * primary assertion target — we await job completion, then inspect
 * the flag + dispatch state.
 */
function spawnThrottleAgent(opts: {
  jobId: string;
  resetText?: string;
  initialRecoverCount?: number;
}): Promise<AgentJob> {
  return new Promise<AgentJob>((resolveP, rejectP) => {
    spawnAgent({
      jobId: opts.jobId,
      prompt: "Integration throttle test",
      repoName: "test-repo",
      timeoutMs: 30_000,
      cwd: workspaceCwd,
      onComplete: resolveP,
      initialRecoverCount: opts.initialRecoverCount ?? 0,
      parentRecoverId: null,
      dispatch: {
        trigger: "api",
        metadata: {
          endpoint: "/api/launch",
          callerIp: null,
          statusUrl: null,
          initialPrompt: "Integration throttle test",
        },
      } as never,
      recoverContext: {
        originalTask: "Original task body",
        workspace: "integration-test",
        workerPort: captureServerPort(),
        repoLocalPath: repoDir,
      },
      env: {
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        FAKE_CLAUDE_SESSION_DIR: sessionDir,
        FAKE_CLAUDE_SCENARIO: "rate-limit-once",
        FAKE_CLAUDE_WRITE_DELAY_MS: "20",
        FAKE_CLAUDE_LINGER_MS: "0",
        ...(opts.resetText
          ? { FAKE_CLAUDE_RATE_LIMIT_RESET: opts.resetText }
          : {}),
      },
    }).catch(rejectP);
  });
}

beforeAll(() => {
  captureServer = new CaptureServer();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockConfig.isHost = false;
  captureServer.clear();
  await captureServer.start();

  tempDir = mkdtempSync(join(tmpdir(), "danxbot-throttle-"));
  fakeBinDir = join(tempDir, "bin");
  mkdirSync(fakeBinDir);
  createClaudeWrapper(fakeBinDir);

  repoDir = join(tempDir, "repos", "test-repo");
  workspaceCwd = join(repoDir, ".danxbot", "workspaces", "integration-test");
  mkdirSync(join(workspaceCwd, ".claude"), { recursive: true });
  mkdirSync(join(repoDir, ".danxbot"), { recursive: true });
  writeFileSync(
    join(workspaceCwd, "workspace.yml"),
    "name: integration-test\ndescription: throttle test\n" +
      "required-placeholders: []\noptional-placeholders: []\nrequired-gates: []\n",
  );
  writeFileSync(
    join(workspaceCwd, ".mcp.json"),
    JSON.stringify({ mcpServers: {} }),
  );
  writeFileSync(
    join(workspaceCwd, ".claude", "settings.json"),
    JSON.stringify({ env: {} }),
  );
  writeFileSync(join(workspaceCwd, "CLAUDE.md"), "# throttle workspace\n");

  sessionDir = deriveSessionDir(workspaceCwd);
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

describe("Integration: Anthropic rate-limit throttle pipeline (DX-322)", () => {
  it("synthetic rate-limit JSONL → throttle flag with parsed resume_at; dispatch ends `throttled`; readFlag past deadline auto-unlinks", async () => {
    const jobId = "test-throttle-1";
    const job = await spawnThrottleAgent({ jobId });

    // Dispatch ended via the throttle handler, NOT the recover loop.
    expect(job.status).toBe("throttled");
    // No /api/resume POST — the throttle path skips it entirely.
    const resumePosts = captureServer.getRequests().filter(
      (r) => r.method === "POST" && r.path === "/api/resume",
    );
    expect(resumePosts).toHaveLength(0);

    // Throttle flag landed on disk with the right shape.
    const payload = readFlag(repoDir);
    expect(payload).not.toBeNull();
    expect(payload!.source).toBe("throttle");
    expect(payload!.dispatchId).toBe(jobId);
    expect(payload!.throttle_kind).toBe("rate_limit");
    expect(payload!.resume_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/,
    );
    // Detail surfaces the original error text so operators reading
    // `cat CRITICAL_FAILURE` see what the agent saw.
    expect(payload!.detail).toMatch(/hit your limit/);
    // The file itself is JSON shape we expect.
    const onDisk = JSON.parse(readFileSync(flagPath(repoDir), "utf-8"));
    expect(onDisk.source).toBe("throttle");
    expect(onDisk.resume_at).toBe(payload!.resume_at);

    // Past-deadline auto-clear — readFlag unlinks + returns null.
    const cleared = readFlag(
      repoDir,
      () => Date.parse(payload!.resume_at!) + 1,
    );
    expect(cleared).toBeNull();
    expect(existsSync(flagPath(repoDir))).toBe(false);
  }, 30_000);

  it("recover-loop bypass — at recoverCount=0 the rate-limit handler skips the cap walk (no /api/resume, recoverCount stays 0)", async () => {
    const jobId = "test-throttle-bypass";
    const job = await spawnThrottleAgent({
      jobId,
      initialRecoverCount: 0,
    });

    // recoverCount MUST stay 0 — the throttle handler does NOT call
    // job.recoverCount++. A regression that routes rate-limit through
    // handleApiErrorRecover would bump it to 1.
    expect(job.recoverCount).toBe(0);
    expect(job.status).toBe("throttled");

    // No /api/resume POST.
    const resumePosts = captureServer.getRequests().filter(
      (r) => r.method === "POST" && r.path === "/api/resume",
    );
    expect(resumePosts).toHaveLength(0);

    // Confirm no late POST after a brief settle.
    await sleep(200);
    expect(
      captureServer.getRequests().filter(
        (r) => r.method === "POST" && r.path === "/api/resume",
      ),
    ).toHaveLength(0);
  }, 30_000);
});
