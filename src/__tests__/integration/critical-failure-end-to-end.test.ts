/**
 * End-to-end integration test for the critical-failure halt-flag pipeline
 * (Trello 6AjSUCUQ — AC12 of EK8oSsWn).
 *
 * Wires fake-claude through the real worker HTTP server, dispatch core,
 * launcher, SessionLogWatcher, MCP settings file, handleStop, and
 * handleClearCriticalFailure. The two scenarios mirror the two write
 * paths of `<repo>/.danxbot/CRITICAL_FAILURE`:
 *
 *   1. Agent-signaled (`source: "agent"`):
 *      fake-claude POSTs `{status:"critical_failure", summary}` to the
 *      DANXBOT_STOP_URL it pulls from the per-dispatch MCP settings.
 *      Asserts the worker writes the flag, that `poll()` then halts
 *      (no `fetchTodoCards` call), and that `DELETE
 *      /api/poller/critical-failure` clears the flag and `poll()`
 *      resumes.
 *
 *   2. Post-dispatch-check (`source: "post-dispatch-check"`):
 *      fake-claude completes normally via `danxbot_complete` but the
 *      mocked Trello client reports the tracked card never moved out of
 *      ToDo. The poller's `onComplete` hook trips the flag.
 *
 * Why a real HTTP server: the dispatch core auto-injects
 * DANXBOT_STOP_URL = `http://localhost:<workerPort>/api/stop/<dispatchId>`
 * into the MCP settings file. fake-claude reads that URL and POSTs back —
 * if there's no listener, the worker never sees the critical_failure call
 * and the test verifies nothing real. Spinning up `startWorkerServer`
 * with the test's repo context provides exactly the same routing the
 * production worker exposes.
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
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

// --- Infrastructure mocks (mirror dispatch-pipeline.test.ts) ---

const { testState, mockConfig } = vi.hoisted(() => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  return {
    testState: {
      logsDir: fs.mkdtempSync(path.join(os.tmpdir(), "danxbot-cf-test-logs-")),
      reposBase: "/tmp/danxbot-cf-test-repos",
    },
    mockConfig: {
      runtime: "docker",
      isHost: false,
      dispatch: {
        defaultApiUrl: "http://localhost:80",
        agentTimeoutMs: 60_000,
        mcpProbeTimeoutMs: 3_000,
      },
      pollerIntervalMs: 60_000,
      pollerBackoffScheduleMs: [1_000, 2_000, 4_000],
      logsDir: "",
    },
  };
});

mockConfig.logsDir = testState.logsDir;

vi.mock("../../config.js", () => ({
  config: mockConfig,
  // isWorkerMode/isDashboardMode are read by repo-context.ts at module
  // load; we mock repo-context entirely below so the precise value here
  // doesn't matter. workerRepoName + repos shape is also irrelevant
  // because nothing in this test imports `index.ts` (where they would
  // actually be consulted).
  isWorkerMode: true,
  isDashboardMode: false,
  workerRepoName: "test-repo",
  repos: [],
}));

vi.mock("../../poller/constants.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../poller/constants.js")
  >("../../poller/constants.js");
  return {
    ...actual,
    getReposBase: () => testState.reposBase,
  };
});

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

vi.mock("../../worker/url-normalizer.js", () => ({
  normalizeCallbackUrl: (url: string | undefined) => url,
}));

vi.mock("../../agent/mcp-server-probe.js", () => ({
  probeAllMcpServers: vi.fn().mockResolvedValue({ ok: true, failures: [] }),
}));

// Slack listener pulled in transitively via worker/dispatch.ts. Stubbed
// because the critical-failure path doesn't touch it; importing the real
// module would require ANTHROPIC_API_KEY at module load time.
vi.mock("../../slack/listener.js", () => ({
  getSlackClientForRepo: vi.fn(),
  startSlackListener: vi.fn(),
}));

// repo-context.ts evaluates `repoContexts` at module load by reading
// process.env (DANXBOT_WORKER_PORT, etc). The poller imports it, so we
// stub the module to a no-op surface — every test calls `poll(repo)`
// with a hand-constructed RepoContext, never `repoContexts`.
vi.mock("../../repo-context.js", () => ({
  repoContexts: [],
  loadRepoContext: vi.fn(),
  getRepoContext: vi.fn(),
}));

// Shared mutable mock for the IssueTracker the poller resolves via
// `createIssueTracker(repo)`. Phase 5 of tracker-agnostic-agents (Trello
// 69f76d57359b5fe89f80ab22) retired the legacy direct Trello-HTTP calls
// from the poller hot path — every fetch / move / comment now goes
// through the IssueTracker abstraction. The mock exposes only the
// methods the poller actually calls; if a future scenario needs more,
// add a `vi.fn()` here. Defaults are set in beforeEach so each test
// gets a clean slate.
const trackerMock = vi.hoisted(() => ({
  fetchOpenCards: vi.fn(),
  getCard: vi.fn(),
  getComments: vi.fn(),
  moveToStatus: vi.fn(),
  addComment: vi.fn(),
  updateCard: vi.fn(),
}));

function seedHydratedCard(externalId: string, title: string): void {
  // Brand-new-card hydration path: `hydrateFromRemote` calls
  // `getCard(externalId)` and `getComments(externalId)`. Seed both with
  // the synthetic Issue the poller will see on this dispatch.
  trackerMock.getCard.mockResolvedValue({
    schema_version: 3 as const,
    tracker: "memory",
    id: "ISS-1",
    external_id: externalId,
    parent_id: null,
    children: [],
    dispatch_id: null,
    status: "ToDo" as const,
    type: "Feature" as const,
    title,
    description: "",
    triaged: { timestamp: "", status: "", explain: "" },
    ac: [],
    phases: [],
    comments: [],
    retro: { good: "", bad: "", action_items: [], commits: [] },
  });
  trackerMock.getComments.mockResolvedValue([]);
}

vi.mock("../../issue-tracker/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../issue-tracker/index.js")
  >("../../issue-tracker/index.js");
  return {
    ...actual,
    createIssueTracker: () => trackerMock,
  };
});

// Dispatches DB writes go through `dashboard/dispatches-db.js`. Stub so the
// integration test does not require a live MySQL connection — the launcher's
// dispatch tracker calls these helpers on every spawn/finalize. Real failures
// are caught and logged by the tracker, but stubbing keeps the test output
// clean.
vi.mock("../../dashboard/dispatches-db.js", () => ({
  insertDispatch: vi.fn().mockResolvedValue(undefined),
  updateDispatch: vi.fn().mockResolvedValue(undefined),
  getDispatchById: vi.fn().mockResolvedValue(null),
}));

// --- Real imports (the pipeline under test) ---

import { startWorkerServer } from "../../worker/server.js";
import { deriveSessionDir } from "../../agent/session-log-watcher.js";
import { _resetForTesting as resetDispatchCore } from "../../dispatch/core.js";
import { flagPath, readFlag } from "../../critical-failure.js";
import {
  poll,
  _resetForTesting as resetPollerState,
} from "../../poller/index.js";
import { CaptureServer } from "./helpers/capture-server.js";
import { makeRepoContext } from "../helpers/fixtures.js";
import type { RepoContext } from "../../types.js";

// --- Test helpers ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");
const fakeClaude = resolve(__dirname, "helpers/fake-claude.ts");
const tsxBin = resolve(projectRoot, "node_modules/.bin/tsx");

let captureServer: CaptureServer;
let workerServer: Server | undefined;
let workerPort: number;
let tempDir: string;
let repoDir: string;
let fakeBinDir: string;
let repo: RepoContext;
let originalPath: string | undefined;
let originalEnvKeys: Set<string>;

function createClaudeWrapper(binDir: string): void {
  const wrapperPath = join(binDir, "claude");
  writeFileSync(
    wrapperPath,
    `#!/bin/bash\nexec "${tsxBin}" "${fakeClaude}" "$@"\n`,
  );
  chmodSync(wrapperPath, 0o755);
}

/**
 * Materialize a minimal workspace fixture. `dispatch()` resolves the
 * named workspace under `<repo>/.danxbot/workspaces/<name>/` — the
 * fixture only needs to satisfy the resolver (workspace.yml +
 * .mcp.json + .claude/settings.json + CLAUDE.md). The dispatch core
 * merges in the danxbot infrastructure server itself, so an empty
 * `.mcp.json` is enough.
 */
function writeWorkspaceFixture(workspaceName: string): void {
  const wsDir = join(repoDir, ".danxbot", "workspaces", workspaceName);
  mkdirSync(join(wsDir, ".claude"), { recursive: true });
  writeFileSync(
    join(wsDir, "workspace.yml"),
    "name: " +
      workspaceName +
      "\n" +
      "description: e2e fixture\n" +
      "required-placeholders: []\n" +
      "optional-placeholders: []\n" +
      "required-gates: []\n",
  );
  writeFileSync(
    join(wsDir, ".mcp.json"),
    JSON.stringify({ mcpServers: {} }),
  );
  writeFileSync(
    join(wsDir, ".claude", "settings.json"),
    JSON.stringify({ env: {} }),
  );
  writeFileSync(
    join(wsDir, "CLAUDE.md"),
    "# " + workspaceName + " workspace\n",
  );
}

/**
 * Wait for a (sync or async) predicate to become true, polling at 50 ms.
 * Throws on timeout.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Reserve an ephemeral port by listening on 0, capturing the port, then closing. */
async function reservePort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const tmp = createServer();
    tmp.unref();
    tmp.on("error", rej);
    tmp.listen(0, () => {
      const addr = tmp.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      tmp.close(() => res(port));
    });
  });
}

// --- Lifecycle ---

beforeAll(() => {
  captureServer = new CaptureServer();
  originalPath = process.env.PATH;
  originalEnvKeys = new Set(Object.keys(process.env));
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Default tracker behaviors: empty open list, empty comments. Tests
  // override what they need.
  trackerMock.fetchOpenCards.mockResolvedValue([]);
  trackerMock.getComments.mockResolvedValue([]);
  trackerMock.moveToStatus.mockResolvedValue(undefined);
  trackerMock.addComment.mockResolvedValue({ id: "cmt-1", timestamp: "" });
  trackerMock.updateCard.mockResolvedValue(undefined);
  mockConfig.isHost = false;
  await captureServer.start();

  tempDir = mkdtempSync(join(tmpdir(), "danxbot-cf-integ-"));
  fakeBinDir = join(tempDir, "bin");
  mkdirSync(fakeBinDir);
  createClaudeWrapper(fakeBinDir);

  testState.reposBase = join(tempDir, "repos");
  repoDir = join(testState.reposBase, "test-repo");
  mkdirSync(join(repoDir, ".danxbot"), { recursive: true });

  // Both workspaces the tests use:
  //   - issue-worker: poller path (post-dispatch-check variant)
  //   - integration-test: handleLaunch path (agent-signaled variant)
  writeWorkspaceFixture("issue-worker");
  writeWorkspaceFixture("integration-test");

  // Reserve an ephemeral port BEFORE creating RepoContext so the
  // dispatch core's auto-injected DANXBOT_STOP_URL points at our test
  // server.
  workerPort = await reservePort();

  repo = makeRepoContext({
    name: "test-repo",
    localPath: repoDir,
    workerPort,
    trello: {
      apiKey: "test-trello-key",
      apiToken: "test-trello-token",
      boardId: "test-board",
      reviewListId: "list-review",
      todoListId: "list-todo",
      inProgressListId: "list-inprog",
      needsHelpListId: "list-needshelp",
      doneListId: "list-done",
      cancelledListId: "list-cancelled",
      actionItemsListId: "list-actionitems",
      bugLabelId: "label-bug",
      featureLabelId: "label-feature",
      epicLabelId: "label-epic",
      needsHelpLabelId: "label-needshelp",
    },
  });

  // PATH override for the spawned claude wrapper. Per-scenario env vars
  // are set in each test body.
  process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
  process.env.FAKE_CLAUDE_LINGER_MS = "300";
  process.env.FAKE_CLAUDE_WRITE_DELAY_MS = "10";

  workerServer = await startWorkerServer(repo);
});

afterEach(async () => {
  if (workerServer) {
    await new Promise<void>((res) => workerServer!.close(() => res()));
    workerServer = undefined;
  }
  await captureServer.stop();
  resetPollerState();
  // _resetForTesting drains activeJobs AND clears the TTL eviction timers
  // — no separate clearJobCleanupIntervals() call needed.
  resetDispatchCore();

  // Restore env to its pre-test snapshot. We never delete keys that
  // existed before the suite; we only delete those introduced during the
  // test (FAKE_CLAUDE_*, PATH override).
  process.env.PATH = originalPath;
  for (const key of Object.keys(process.env)) {
    if (!originalEnvKeys.has(key)) {
      delete process.env[key];
    }
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

describe("Integration: critical-failure end-to-end (Trello AC12)", () => {
  it("agent-signaled critical_failure writes flag with source=agent and supplied summary", async () => {
    const wsSessionDir = deriveSessionDir(
      join(repoDir, ".danxbot", "workspaces", "integration-test"),
    );
    process.env.FAKE_CLAUDE_SCENARIO = "critical-failure";
    process.env.FAKE_CLAUDE_SESSION_DIR = wsSessionDir;
    process.env.FAKE_CLAUDE_CRITICAL_SUMMARY =
      "MCP Trello tools failed to load";

    const launchRes = await fetch(`http://localhost:${workerPort}/api/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: "integration-test",
        task: "Signal critical_failure to verify the halt-flag pipeline",
        api_token: "test-token",
        status_url: captureServer.statusUrl,
      }),
    });
    expect(launchRes.status).toBe(200);
    const launchBody = (await launchRes.json()) as { job_id: string };
    const jobId = launchBody.job_id;
    expect(jobId).toBeTruthy();

    // The flag file appears synchronously after handleStop runs. Wait
    // for the file to exist on disk; pulling a `fetchCard` mock is not
    // a viable signal here because the agent-signaled path bypasses the
    // Trello check entirely.
    await waitFor(
      () => existsSync(flagPath(repoDir)),
      15_000,
      "critical-failure flag file",
    );

    const flag = readFlag(repoDir);
    expect(flag).toMatchObject({
      source: "agent",
      dispatchId: jobId,
      reason: "Agent-signaled critical failure",
      detail: "MCP Trello tools failed to load",
    });
    // Re-parse from disk to assert the persisted timestamp shape, which
    // `readFlag` doesn't validate.
    const onDisk = JSON.parse(readFileSync(flagPath(repoDir), "utf-8"));
    expect(onDisk.source).toBe("agent");
    expect(onDisk.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Pin the deliberate asymmetry documented in
    // `worker/dispatch.ts:869-898` and
    // `.claude/rules/agent-dispatch.md`: the response advertises
    // "critical_failure" but `job.stop` runs the "failed" lifecycle.
    // `/api/status` must report status=failed even though the agent
    // signaled critical_failure — `job.status` only tracks
    // completed/failed; the halt signal lives on disk.
    await waitFor(
      async () => {
        const statusRes = await fetch(
          `http://localhost:${workerPort}/api/status/${jobId}`,
        );
        if (statusRes.status !== 200) return false;
        const body = (await statusRes.json()) as { status: string };
        return body.status === "failed";
      },
      5_000,
      "/api/status to report failed",
    );
    const statusRes = await fetch(
      `http://localhost:${workerPort}/api/status/${jobId}`,
    );
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toMatchObject({
      job_id: jobId,
      status: "failed",
      summary: "MCP Trello tools failed to load",
    });

    // Halt: poll() must return WITHOUT calling the tracker.
    // After the flag clears, the resume tick falls through to the
    // ideator branch (no cards in ToDo). `fetchOpenCards` returning [] is
    // sufficient for both Needs Help / ToDo / Review filters in the
    // resume tick — they all derive from the single tracker call.
    trackerMock.fetchOpenCards.mockResolvedValue([]);
    await poll(repo);
    expect(trackerMock.fetchOpenCards).not.toHaveBeenCalled();

    // Clear via the worker DELETE endpoint (mirrors the dashboard
    // proxy's request shape, including the same path).
    const clearRes = await fetch(
      `http://localhost:${workerPort}/api/poller/critical-failure`,
      { method: "DELETE" },
    );
    expect(clearRes.status).toBe(200);
    const cleared = (await clearRes.json()) as { cleared: boolean };
    expect(cleared.cleared).toBe(true);
    expect(existsSync(flagPath(repoDir))).toBe(false);

    // Resume: poll() must now reach the tracker. The mock returns [] so
    // the tick falls through to the no-cards branch — the assertion is
    // only that the halt gate let us through.
    await poll(repo);
    expect(trackerMock.fetchOpenCards).toHaveBeenCalled();

    // A second clear is idempotent — already-absent file returns
    // {cleared: false}, NOT 404.
    const secondClear = await fetch(
      `http://localhost:${workerPort}/api/poller/critical-failure`,
      { method: "DELETE" },
    );
    expect(secondClear.status).toBe(200);
    expect(((await secondClear.json()) as { cleared: boolean }).cleared).toBe(
      false,
    );
  }, 30_000);

  it("post-dispatch-check writes flag with source=post-dispatch-check when the agent completes but the tracked card stays in ToDo", async () => {
    const wsSessionDir = deriveSessionDir(
      join(repoDir, ".danxbot", "workspaces", "issue-worker"),
    );
    process.env.FAKE_CLAUDE_SCENARIO = "complete-only";
    process.env.FAKE_CLAUDE_SESSION_DIR = wsSessionDir;
    process.env.FAKE_CLAUDE_COMPLETE_STATUS = "completed";
    process.env.FAKE_CLAUDE_COMPLETE_SUMMARY = "claimed-done";

    const STUCK_CARD_ID = "card-stuck-in-todo";
    const STUCK_TITLE = "A card that never moves";

    // The poller now drives every fetch / move / status check through
    // the cached IssueTracker. fetchOpenCards returns the stuck ToDo
    // card so `_poll` dispatches against it; the post-completion
    // `checkCardProgressedOrHalt` calls `getCard` and writes the flag
    // when status is still "ToDo".
    trackerMock.fetchOpenCards.mockResolvedValue([
      {
        id: "",
        external_id: STUCK_CARD_ID,
        title: STUCK_TITLE,
        status: "ToDo",
      },
    ]);
    // Hydrate path needs getCard + getComments. Critical for the halt
    // assertion: status === "ToDo" — that's the signal
    // `checkCardProgressedOrHalt` uses to decide the agent never moved
    // the card. The same getCard mock satisfies both the hydrate-time
    // call and the post-dispatch progress check.
    seedHydratedCard(STUCK_CARD_ID, STUCK_TITLE);

    expect(existsSync(flagPath(repoDir))).toBe(false);

    // Drive the poller path. poll() resolves once the agent is spawned
    // (it does NOT await completion); the post-dispatch handler fires
    // asynchronously inside the dispatch core's onComplete.
    await poll(repo);

    // Wait for the flag to appear — handleAgentCompletion writes it
    // synchronously after fetchCard returns.
    await waitFor(
      () => existsSync(flagPath(repoDir)),
      30_000,
      "post-dispatch-check flag file",
    );

    const flag = readFlag(repoDir);
    expect(flag).toMatchObject({
      source: "post-dispatch-check",
      cardId: STUCK_CARD_ID,
      cardUrl: `https://trello.com/c/${STUCK_CARD_ID}`,
      reason:
        `Tracked card "${STUCK_TITLE}" did not move out of ToDo after dispatch`,
    });
    expect(flag?.detail).toContain(STUCK_CARD_ID);
    expect(flag?.detail).toContain(STUCK_TITLE);
    // dispatchId is the spawn's jobId — opaque to the test, but the
    // worker must persist it so operators can correlate the flag with
    // the failed dispatch.
    expect(flag?.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);
});
