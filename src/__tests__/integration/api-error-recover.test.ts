/**
 * Integration test for the Claude API stream-idle auto-recover pipeline
 * (DX-261 — Phase 3 of DX-246).
 *
 * Exercises the REAL wiring end-to-end:
 *
 *     spawnAgent
 *       → SessionLogWatcher discovers fake-claude's synthetic JSONL pair
 *       → ApiErrorDetector arms the 5s confirmation window
 *       → handleApiErrorRecover increments the count, calls job.stop,
 *         POSTs /api/resume to the capture server
 *       → cap-exhausted path writes <repo>/.danxbot/CRITICAL_FAILURE
 *
 * Only the CLI binary is replaced (fake-claude via PATH override) and the
 * DB is mocked — the watcher, detector, recover handler, cleanup chain,
 * and HTTP call to /api/resume are all real production code. Unit tests
 * in `src/agent/attach-monitoring-stack.test.ts` already cover the
 * recover handler with mocked watcher; this suite is the pin against
 * end-to-end regressions where the JSONL → detector → recover wiring
 * silently drifts (e.g. detector subscribes too late, watcher misses
 * the synthetic entry, recoverContext loses a field across spawnAgent).
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
      logsDir: fs.mkdtempSync(path.join(os.tmpdir(), "danxbot-recover-logs-")),
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
// no-ops so the test exercises the JSONL+HTTP pipeline without a real DB.
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

// Slack listener pulls in @anthropic-ai/sdk transitively → reads
// `config.anthropic.apiKey` at module load. Mock decouples the recover
// suite from the Slack surface (no recover logic touches it).
vi.mock("../../slack/listener.js", () => ({
  getSlackClientForRepo: vi.fn(),
}));

// --- Real imports ---

import { spawnAgent, type AgentJob } from "../../agent/launcher.js";
import { deriveSessionDir } from "../../agent/session-log-watcher.js";
import { CaptureServer } from "./helpers/capture-server.js";
import { MAX_RECOVERS } from "../../agent/attach-monitoring-stack.js";
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

/** Capture-server port — recover handler POSTs to /api/resume on this port. */
function captureServerPort(): number {
  const m = captureServer.baseUrl.match(/:(\d+)$/);
  if (!m) throw new Error(`Cannot parse port from ${captureServer.baseUrl}`);
  return Number(m[1]);
}

/** Poll the capture server until a request matching `pred` lands or timeout. */
function waitForRequest(
  pred: (r: { method: string; path: string; body: string }) => boolean,
  timeoutMs = 12_000,
): Promise<{ method: string; path: string; body: string }> {
  return new Promise((resolveP, rejectP) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      const seen = captureServer.getRequests().map((r) => `${r.method} ${r.path}`);
      rejectP(
        new Error(
          `Timeout waiting for matching request after ${timeoutMs}ms. Seen: ${JSON.stringify(seen)}`,
        ),
      );
    }, timeoutMs);
    const poll = setInterval(() => {
      const match = captureServer.getRequests().find(pred);
      if (match) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolveP(match);
      }
    }, 50);
  });
}

/** Wait briefly to confirm a request did NOT happen — used for cap-exhausted assertion. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spawn an agent in the api-error scenario with the recover handler
 * wired against the capture server. Returns the job so callers can
 * await its completion (the recover handler kills the process via
 * job.stop; spawnAgent's onComplete fires after cleanup).
 */
function spawnRecoverAgent(opts: {
  jobId: string;
  initialRecoverCount: number;
  parentRecoverId?: string | null;
}): Promise<AgentJob> {
  // confirmationWindowMs in the detector is 5_000 — give the spawn a
  // generous 30s timeout so the watcher's 5s poll + the detector's
  // 5s confirmation + the recover handler's POST all complete before
  // the inactivity timer trips.
  return new Promise<AgentJob>((resolveP, rejectP) => {
    spawnAgent({
      jobId: opts.jobId,
      prompt: "Integration recover test",
      repoName: "test-repo",
      timeoutMs: 30_000,
      cwd: workspaceCwd,
      onComplete: resolveP,
      initialRecoverCount: opts.initialRecoverCount,
      parentRecoverId: opts.parentRecoverId ?? null,
      // dispatch: stamp so attachMonitoringStack starts a tracker → the
      // recover handler calls recordRecoverCount through it. The DB
      // mocks above turn that into a no-op.
      dispatch: {
        trigger: "api",
        metadata: {
          endpoint: "/api/launch",
          callerIp: null,
          statusUrl: null,
          initialPrompt: "Integration recover test",
        },
      } as never,
      recoverContext: {
        originalTask: "Original task body for resume",
        workspace: "integration-test",
        workerPort: captureServerPort(),
        repoLocalPath: repoDir,
      },
      env: {
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        FAKE_CLAUDE_SESSION_DIR: sessionDir,
        FAKE_CLAUDE_SCENARIO: "api-error",
        FAKE_CLAUDE_WRITE_DELAY_MS: "20",
        FAKE_CLAUDE_LINGER_MS: "0",
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

  tempDir = mkdtempSync(join(tmpdir(), "danxbot-recover-"));
  fakeBinDir = join(tempDir, "bin");
  mkdirSync(fakeBinDir);
  createClaudeWrapper(fakeBinDir);

  repoDir = join(tempDir, "repos", "test-repo");
  workspaceCwd = join(repoDir, ".danxbot", "workspaces", "integration-test");
  mkdirSync(join(workspaceCwd, ".claude"), { recursive: true });
  mkdirSync(join(repoDir, ".danxbot"), { recursive: true });
  writeFileSync(
    join(workspaceCwd, "workspace.yml"),
    "name: integration-test\ndescription: recover test\n" +
      "required-placeholders: []\noptional-placeholders: []\nrequired-gates: []\n",
  );
  writeFileSync(join(workspaceCwd, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  writeFileSync(
    join(workspaceCwd, ".claude", "settings.json"),
    JSON.stringify({ env: {} }),
  );
  writeFileSync(join(workspaceCwd, "CLAUDE.md"), "# recover workspace\n");

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

describe("Integration: API-error auto-recover pipeline (DX-261)", () => {
  it("fixture JSONL with synthetic error pair → detector fires within 5s → recover invoked → new dispatch chains via parent_recover_id", async () => {
    const jobId = "test-job-recover-1";
    const jobPromise = spawnRecoverAgent({
      jobId,
      initialRecoverCount: 0,
    });

    // Wait for the recover handler's POST to land on the capture server.
    // 12s budget covers watcher poll (5s) + detector confirmation (5s)
    // + handler awaits + HTTP roundtrip.
    const resumeReq = await waitForRequest(
      (r) => r.method === "POST" && r.path === "/api/resume",
      15_000,
    );

    // Body shape — the chain-stamping fields the dashboard reads on the
    // new dispatch row.
    const body = JSON.parse(resumeReq.body);
    expect(body).toEqual({
      repo: "test-repo",
      job_id: jobId,
      task: "Original task body for resume",
      workspace: "integration-test",
      recover_count: 1,
      parent_recover_id: jobId,
    });

    // The job reaches terminal via job.stop("api_error_recover", ...).
    const job = await jobPromise;
    expect(job.recoverCount).toBe(1);
    // `agent-stop.ts#mapCompleteToInMemory` collapses
    // `api_error_recover` → in-memory `"recovered"`. Pin the exact value
    // — a permissive "either kind ok" assertion would let a regression
    // in the collapse silently keep this test green.
    expect(job.status).toBe("recovered");
  }, 30_000);

  it.each([
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 2, to: 3 },
  ])(
    "recover_count increments from $from → $to across consecutive recovery attempts",
    async ({ from, to }) => {
      const jobId = `test-job-chain-${from}-to-${to}`;
      const jobPromise = spawnRecoverAgent({
        jobId,
        initialRecoverCount: from,
        parentRecoverId: from === 0 ? null : `parent-of-${from}`,
      });

      const resumeReq = await waitForRequest(
        (r) => r.method === "POST" && r.path === "/api/resume",
        15_000,
      );
      const body = JSON.parse(resumeReq.body);

      // Counter increments by exactly one — handler does
      // `newCount = recoverCount + 1` before persisting.
      expect(body.recover_count).toBe(to);
      // parent_recover_id always references THE CURRENT dispatch's id
      // (not its parent) because this dispatch is becoming the parent
      // of the next chain link.
      expect(body.parent_recover_id).toBe(jobId);

      const job = await jobPromise;
      expect(job.recoverCount).toBe(to);
      // Cap not yet hit at to=1,2,3 — handler took the recover-ok branch.
      expect(existsSync(flagPath(repoDir))).toBe(false);
    },
    30_000,
  );

  it(`MAX_RECOVERS cap: 4th attempt writes CRITICAL_FAILURE flag and does NOT POST /api/resume`, async () => {
    // Constant pinned in attach-monitoring-stack.ts. Seeding the
    // in-memory counter to MAX_RECOVERS guarantees the next increment
    // crosses the cap (MAX_RECOVERS + 1 > MAX_RECOVERS).
    expect(MAX_RECOVERS).toBe(3);

    const jobId = "test-job-cap-exhausted";
    const jobPromise = spawnRecoverAgent({
      jobId,
      initialRecoverCount: MAX_RECOVERS,
      parentRecoverId: "third-link-parent",
    });

    // Wait until the agent's job reaches terminal — the cap path calls
    // job.stop, which resolves onComplete.
    const job = await jobPromise;

    // The 4th attempted recover MUST have:
    //   - bumped the in-memory + persisted counter to 4 so operators
    //     reading the row see the full chain length
    expect(job.recoverCount).toBe(MAX_RECOVERS + 1);

    //   - written the CRITICAL_FAILURE flag into the repo's .danxbot/
    //     dir so the poller halts; the file contents include the
    //     synthetic error text as `detail`
    const payload = readFlag(repoDir);
    expect(payload).not.toBeNull();
    expect(payload!.source).toBe("agent");
    expect(payload!.dispatchId).toBe(jobId);
    expect(payload!.reason).toBe("API-error recover cap exhausted");
    expect(payload!.detail).toMatch(/API Error: Stream idle timeout/);

    //   - NOT POSTed to /api/resume — the chain ends here pending
    //     operator clear. Sleep a tick to confirm no late POST arrives.
    await sleep(200);
    const resumePosts = captureServer.getRequests().filter(
      (r) => r.method === "POST" && r.path === "/api/resume",
    );
    expect(resumePosts).toHaveLength(0);

    // Sanity-check the flag's JSON shape on disk too — the dashboard's
    // critical-failure reader will be parsing this exact file.
    const onDisk = JSON.parse(readFileSync(flagPath(repoDir), "utf-8"));
    expect(onDisk.source).toBe("agent");
    expect(onDisk.dispatchId).toBe(jobId);
  }, 30_000);
});
