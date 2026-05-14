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
import { createMockReqWithBody, createMockRes } from "../helpers/http-mocks.js";
import { makeRepoContext } from "../helpers/fixtures.js";

// --- Infrastructure mocks (not logic under test) ---

// vi.hoisted uses require() because it runs before ESM imports are available
const { testState, mockConfig } = vi.hoisted(() => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  return {
    testState: {
      logsDir: fs.mkdtempSync(path.join(os.tmpdir(), "danxbot-test-logs-")),
      reposBase: "/tmp/danxbot-test-repos",
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

// URL normalizer mock: integration tests run on the host, so localhost URLs are
// valid as-is — bypassing the docker rewrite keeps status callbacks reachable.
vi.mock("../../worker/url-normalizer.js", () => ({
  normalizeCallbackUrl: (url: string | undefined) => url,
}));

// MCP probe mock: the HTTP dispatch path calls buildMcpSettings, which
// generates a real settings.json pointing at the schema + danxbot MCP
// servers. The probe would try to run them for real, but these tests use
// `fake-claude` via PATH override and never intended to exercise real
// server binaries. The probe is covered by its own dedicated unit tests in
// `src/agent/mcp-server-probe.test.ts`; stubbing it here keeps this suite
// focused on the HTTP + JSONL pipeline it was written to verify.
vi.mock("../../agent/mcp-server-probe.js", () => ({
  probeAllMcpServers: vi.fn().mockResolvedValue({ ok: true, failures: [] }),
}));

// worker/dispatch.ts (Phase 1) imports `getSlackClientForRepo` from
// `../../slack/listener.js`. The listener transitively pulls in the
// heartbeat manager → `@anthropic-ai/sdk`, which reads
// `config.anthropic.apiKey` at module load — absent from this test's
// `mockConfig`. Mocking the listener decouples the pipeline integration
// tests from the Slack surface, which has no business in this suite.
vi.mock("../../slack/listener.js", () => ({
  getSlackClientForRepo: vi.fn(),
}));

// Stub dispatches-db so the launcher's `pairedWriteHostPid` (DX-140)
// doesn't try to talk to a real MySQL pool. The HTTP+JSONL pipeline
// these tests exercise has nothing to do with the dispatch row's
// host_pid stamp; treating the DB as a no-op here matches the
// pre-existing pattern (`startDispatchTracking`'s `insertDispatch` call
// is also a no-op in this suite — it's swallowed by the tracker's
// internal try/catch). Without this mock the paired-write throws on
// every spawn and `handleLaunch` returns 500 instead of 200.
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
 * Jobs spawned via `runToCompletion` are pushed here from their
 * `onComplete` callback so `afterEach` can drain `_cleanup` +
 * `_forwarderFlush` BEFORE `captureServer.stop()` releases the
 * ephemeral port.
 *
 * `runToCompletion` is the ONLY helper in this file that wires
 * `eventForwarding` (so it's the only producer of forwarder-side
 * POSTs that can leak). Direct `spawnAgent` callsites in this file
 * pass `statusUrl` for heartbeat but never `eventForwarding`, so no
 * `LaravelForwarder` is constructed and `job._forwarderFlush` stays
 * undefined — they have nothing to drain.
 *
 * Without this drain, the Laravel forwarder's retry tail (default
 * `[1s,2s,4s,8s,16s,30s]` in `laravel-forwarder.ts`) outlives the
 * test body — `runCleanup` stashes `forwarderFlush?.()` on
 * `job._forwarderFlush` as fire-and-forget (`agent-cleanup.ts:119`)
 * to keep production cleanup latency short. The next test's
 * `captureServer.start()` (port 0) often gets the SAME ephemeral port
 * the OS just released; an in-flight POST from the prior dispatch
 * then lands on the new server (singleton, shared `requests[]`),
 * polluting assertions like `posts.length === 0` in the "no statusUrl"
 * test.
 *
 * Mirrors `_drainPendingCleanupsForTesting` (`dispatch/core.ts:232`)
 * for jobs spawned via direct `spawnAgent()` (which doesn't register
 * them in `activeJobs`). Both promises swallow internal errors per
 * their contracts; the `Promise.race` against a 5s timeout is
 * defense-in-depth so a genuinely hung POST cannot freeze teardown.
 */
const trackedJobs: AgentJob[] = [];

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

/**
 * Create a shell wrapper script named `systemd-run` that captures its
 * argv to $SYSTEMD_RUN_ARGV_FILE (one element per line) then execs the
 * inner command after the POSIX `--` separator.
 *
 * Used by the scope-wrapper test to verify the launcher passes the
 * canonical argv (`--user --scope --unit danxbot-dispatch-<id> --quiet
 * --collect --`) without actually running real systemd — the test
 * environment may not have a user systemd instance available (CI,
 * docker-based runners), so this shim stands in.
 */
function createSystemdRunShim(binDir: string): void {
  const wrapperPath = join(binDir, "systemd-run");
  writeFileSync(
    wrapperPath,
    `#!/bin/bash
# DX-325 dispatch-pipeline test shim. NOT a real systemd-run.
if [[ -n "$SYSTEMD_RUN_ARGV_FILE" ]]; then
  printf '%s\\n' "$@" > "$SYSTEMD_RUN_ARGV_FILE"
fi
# Walk argv to the POSIX -- separator, then exec what follows.
while [[ $# -gt 0 && "$1" != "--" ]]; do shift; done
if [[ $# -eq 0 ]]; then
  echo "systemd-run shim: no -- separator in argv" >&2
  exit 64
fi
shift  # consume the --
exec "$@"
`,
  );
  chmodSync(wrapperPath, 0o755);
}

/**
 * Create a shell wrapper script named `systemctl` that captures its argv
 * to $SYSTEMCTL_ARGV_FILE (one element per line) then exits 0.
 *
 * Used by the DX-326 cancel/stop tests to verify the new
 * `stopAgentTree` helper invokes the canonical `--user stop
 * <scope>.scope` command without needing real systemd available in
 * the test runner.
 */
function createSystemctlShim(binDir: string): void {
  const wrapperPath = join(binDir, "systemctl");
  writeFileSync(
    wrapperPath,
    `#!/bin/bash
# DX-326 dispatch-pipeline test shim. NOT a real systemctl.
if [[ -n "$SYSTEMCTL_ARGV_FILE" ]]; then
  printf '%s\\n' "$@" > "$SYSTEMCTL_ARGV_FILE"
fi
# Simulate a clean stop. Exit code matches \`systemctl --user stop\` on
# a unit that transitioned to inactive cleanly.
exit 0
`,
  );
  chmodSync(wrapperPath, 0o755);
}

/** Predicate: is this a PUT with the given status in the body? */
function isStatusPut(status: string) {
  return (r: { method: string; body: string }) => {
    if (r.method !== "PUT") return false;
    try {
      return JSON.parse(r.body).status === status;
    } catch {
      return false;
    }
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
      reject(
        new Error(
          `Expected ${count} matching requests, got ${matching.length} within ${timeoutMs}ms. ` +
            `Total requests: ${captureServer.getRequests().length}`,
        ),
      );
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
      cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
      statusUrl,
      apiToken,
      eventForwarding: overrides?.eventForwarding ?? { statusUrl, apiToken },
      onComplete: (job) => {
        trackedJobs.push(job);
        resolve(job);
      },
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
  // Reset mutable config to defaults between tests to prevent state leakage
  mockConfig.isHost = false;
  trackedJobs.length = 0;
  captureServer.clear();
  await captureServer.start();

  tempDir = mkdtempSync(join(tmpdir(), "danxbot-integ-"));
  fakeBinDir = join(tempDir, "bin");
  mkdirSync(fakeBinDir);
  createClaudeWrapper(fakeBinDir);
  createSystemdRunShim(fakeBinDir);
  createSystemctlShim(fakeBinDir);

  testState.reposBase = join(tempDir, "repos");
  repoDir = join(testState.reposBase, "test-repo");

  // Every dispatch (both `runToCompletion` driving `spawnAgent`
  // directly AND `handleLaunch` integration tests) cwds into the
  // plural workspace at `<repo>/.danxbot/workspaces/integration-test/`.
  // The singular legacy `<repo>/.danxbot/workspace/` was retired with
  // the workspace-dispatch cleanup. Create the workspace fixture once;
  // every test in this suite uses it.
  const integrationWs = join(
    repoDir,
    ".danxbot",
    "workspaces",
    "integration-test",
  );
  mkdirSync(join(integrationWs, ".claude"), { recursive: true });
  writeFileSync(
    join(integrationWs, "workspace.yml"),
    "name: integration-test\n" +
      "description: integration-test workspace fixture\n" +
      "required-placeholders: []\n" +
      "optional-placeholders: []\n" +
      "required-gates: []\n",
  );
  writeFileSync(
    join(integrationWs, ".mcp.json"),
    JSON.stringify({ mcpServers: {} }),
  );
  writeFileSync(
    join(integrationWs, ".claude", "settings.json"),
    JSON.stringify({ env: {} }),
  );
  writeFileSync(
    join(integrationWs, "CLAUDE.md"),
    "# integration-test workspace\n",
  );

  // sessionDir derives from the integration-test workspace cwd —
  // every dispatch in this suite lands there.
  sessionDir = deriveSessionDir(integrationWs);
});

afterEach(async () => {
  // Drain every dispatch's `_cleanup` + `_forwarderFlush` BEFORE the
  // capture server releases its port. See `trackedJobs` header for the
  // port-reuse race this guards against. Race against a 5s timeout so
  // a hung POST cannot freeze teardown; both promises are documented
  // not to reject, so `allSettled` is purely a defense-in-depth shape.
  //
  // `_cleanup` is the cached idempotent promise from
  // `agent-cleanup.ts` (cleanupPromise) — re-awaiting it after the
  // close handler invoked it is a no-op once resolved, but the
  // re-await is what guarantees `_forwarderFlush` is set (it's
  // populated at step 6 inside `runCleanup`, AFTER the awaited
  // `watcher.drain` + `watcher.stop`).
  const drains = trackedJobs.map(async (j) => {
    if (j._cleanup) await j._cleanup();
    if (j._forwarderFlush) await j._forwarderFlush;
  });
  await Promise.race([
    Promise.allSettled(drains),
    new Promise<void>((res) => setTimeout(res, 5_000)),
  ]);
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

    it("captures last assistant text when final block is written between watcher polls", async () => {
      // Deterministic reproduction of the close-handler race that left
      // `job.summary` carrying an intermediate assistant block instead of
      // the agent's final text. With pollIntervalMs hardcoded at 5_000 in
      // the launcher and writeDelayMs=2500 between fake-claude entries:
      //   t=0:    user written
      //   t=2500: assistant1 ("I'll help you with that task.")
      //   t=5000: tool_result
      //   t=7500: assistant2 ("Task completed successfully")
      //   t=10000: result
      //   t=10100: process exits (lingerMs=100)
      // Watcher polls land at ~t=1000 (discovery immediate) and ~t=6000
      // (interval). The next interval at ~t=11000 never fires — fake-claude
      // already exited. Without `drain()` before summary capture in the
      // close handler, lastAssistantText is "I'll help…" when summary is
      // read. Drain ensures the JSONL bytes for assistant2 + result are
      // pulled in before the close handler reads getLastAssistantText().
      const job = await runToCompletion({
        writeDelayMs: 2500,
        lingerMs: 100,
        timeoutMs: 15_000,
      });

      expect(job.status).toBe("completed");
      expect(job.summary).toContain("Task completed successfully");
    }, 30_000);

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

      await waitForRequests(
        (r) => r.method === "POST" && r.path === "/events",
        1,
      );

      const posts = captureServer.getRequestsByPath("/events");
      expect(posts.length).toBeGreaterThanOrEqual(1);

      for (const post of posts) {
        const body = JSON.parse(post.body);
        expect(body.events).toBeDefined();
        expect(Array.isArray(body.events)).toBe(true);
        expect(body.events.length).toBeGreaterThan(0);
      }

      const allEvents = posts.flatMap((p) => JSON.parse(p.body).events);
      const eventTypes = new Set(
        allEvents.map((e: { type: string }) => e.type),
      );
      expect(eventTypes.has("agent_event") || eventTypes.has("tool_call")).toBe(
        true,
      );
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

      const failedPut = captureServer
        .getRequestsByMethod("PUT")
        .find(isStatusPut("failed"));
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
        cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
        statusUrl: captureServer.statusUrl,
        apiToken: "test-token",
        env: fakeClasudeEnv({ scenario: "slow" }),
      });

      expect(job.status).toBe("running");

      // Cancel after a brief delay to let the process start
      await new Promise((r) => setTimeout(r, 500));
      await cancelJob(job, "test-token");

      // cancelJob sets job.status="canceled" BEFORE sending SIGTERM, so the
      // docker close handler and host onExit both early-return without
      // overwriting it — the local status matches the remote PUT.
      expect(job.status).toBe("canceled");
      expect(job.completedAt).toBeInstanceOf(Date);

      await waitForRequests(isStatusPut("canceled"), 1);

      const cancelPut = captureServer
        .getRequestsByMethod("PUT")
        .find(isStatusPut("canceled"));
      expect(cancelPut).toBeDefined();
    }, 20_000);

    it("on host runtime, cancel invokes `systemctl --user stop danxbot-dispatch-<jobId>.scope` (DX-326)", async () => {
      // Pin the Phase 3 stop path. Pre-DX-326, cancelJob SIGTERMed the
      // tracked script-wrapper PID — backgrounded grandchildren reparented
      // to PID 1 and survived. The new helper targets the cgroup atomically
      // via systemctl; this test verifies the integration path through
      // `cancelJob → stopAgentTree → spawn("systemctl", …)` without needing
      // a real user systemd instance in the runner.
      mockConfig.isHost = true;
      const argvFile = join(tempDir, "systemctl-argv.txt");
      // stopAgentTree spawns `systemctl` without an explicit env — it
      // inherits process.env. Prepend the shim dir so the spawn resolves
      // to our test double instead of the host's real systemctl.
      const savedPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}:${savedPath ?? ""}`;
      process.env.SYSTEMCTL_ARGV_FILE = argvFile;
      try {
        const job = await spawnAgent({
          prompt: "Integration test task",
          repoName: "test-repo",
          timeoutMs: 30_000,
          cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
          statusUrl: captureServer.statusUrl,
          apiToken: "test-token",
          env: fakeClasudeEnv({ scenario: "slow" }),
        });

        expect(job.status).toBe("running");
        // DX-326 spawn-preflight stamps scopeName on the AgentJob so
        // downstream callers (stopAgentTree, future reaper) never have to
        // recompute it. Pin the stamped value here.
        expect(job.scopeName).toBe(`danxbot-dispatch-${job.id}`);

        await new Promise((r) => setTimeout(r, 500));
        await cancelJob(job, "test-token");

        expect(job.status).toBe("canceled");

        const captured = readFileSync(argvFile, "utf-8")
          .split("\n")
          .filter((s) => s.length > 0);
        expect(captured).toEqual([
          "--user",
          "stop",
          `danxbot-dispatch-${job.id}.scope`,
        ]);
      } finally {
        process.env.PATH = savedPath;
        delete process.env.SYSTEMCTL_ARGV_FILE;
      }
    }, 20_000);

    it("on host runtime, agent self-stop (`job.stop`) flows through the same `systemctl --user stop` path (DX-326)", async () => {
      // Mirrors the cancel test but exercises the MCP-callback path:
      // `danxbot_complete` → worker `/api/stop/<id>` → `job.stop` →
      // `stopAgentTree` → `systemctl`. Single entry point, no parallel
      // code paths — AC #4 of DX-326.
      mockConfig.isHost = true;
      const argvFile = join(tempDir, "systemctl-argv-jobstop.txt");
      const savedPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}:${savedPath ?? ""}`;
      process.env.SYSTEMCTL_ARGV_FILE = argvFile;
      try {
        const job = await spawnAgent({
          prompt: "Integration test task",
          repoName: "test-repo",
          timeoutMs: 30_000,
          cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
          statusUrl: captureServer.statusUrl,
          apiToken: "test-token",
          env: fakeClasudeEnv({ scenario: "slow" }),
        });

        await new Promise((r) => setTimeout(r, 500));
        await job.stop("completed", "Integration test self-stop");

        const captured = readFileSync(argvFile, "utf-8")
          .split("\n")
          .filter((s) => s.length > 0);
        expect(captured).toEqual([
          "--user",
          "stop",
          `danxbot-dispatch-${job.id}.scope`,
        ]);
        expect(job.status).toBe("completed");
        expect(job.summary).toBe("Integration test self-stop");
      } finally {
        process.env.PATH = savedPath;
        delete process.env.SYSTEMCTL_ARGV_FILE;
      }
    }, 20_000);

    it("on docker runtime, cancel does NOT spawn systemctl — container boundary owns the cgroup (DX-326 anti-goal)", async () => {
      // Docker worker mode is UNCHANGED. The container PID namespace
      // already confines the dispatched process tree, so scope wrapping
      // is bypassed at spawn time AND the stop path stays on the
      // SIGTERM-then-SIGKILL handle.kill primitive. A regression that
      // routed every dispatch through systemctl would break docker
      // production where systemctl is intentionally absent.
      mockConfig.isHost = false;
      const argvFile = join(tempDir, "systemctl-argv-docker.txt");
      const savedPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}:${savedPath ?? ""}`;
      process.env.SYSTEMCTL_ARGV_FILE = argvFile;
      try {
        const job = await spawnAgent({
          prompt: "Integration test task",
          repoName: "test-repo",
          timeoutMs: 30_000,
          cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
          statusUrl: captureServer.statusUrl,
          apiToken: "test-token",
          env: fakeClasudeEnv({ scenario: "slow" }),
        });

        // Docker spawn omits the scope wrap, so spawn-preflight leaves
        // job.scopeName undefined — stopAgentTree's branch falls to the
        // handle.kill path.
        expect(job.scopeName).toBeUndefined();

        await new Promise((r) => setTimeout(r, 500));
        await cancelJob(job, "test-token");

        expect(existsSync(argvFile)).toBe(false);
        expect(job.status).toBe("canceled");
      } finally {
        process.env.PATH = savedPath;
        delete process.env.SYSTEMCTL_ARGV_FILE;
      }
    }, 20_000);
  });

  describe("cleanup", () => {
    it("stops watcher and clears heartbeat on completion", async () => {
      const job = await runToCompletion();

      expect(job.heartbeatInterval).toBeUndefined();
    }, 20_000);

    it("flushes forwarder on completion", async () => {
      await runToCompletion();

      await waitForRequests(
        (r) => r.method === "POST" && r.path === "/events",
        1,
      );

      const eventPosts = captureServer.getRequestsByPath("/events");
      expect(eventPosts.length).toBeGreaterThanOrEqual(1);
    }, 20_000);
  });

  describe("systemd scope wrapper (DX-325 / DX-323)", () => {
    it("on host runtime, the headless spawn argv begins with `systemd-run --user --scope --unit danxbot-dispatch-<jobId> --quiet --collect --`", async () => {
      // Pin the canonical wrapper for the headless spawn path. Without
      // the per-dispatch scope unit, backgrounded grandchildren (`yes >
      // /dev/null &`, double-forks) reparent to PID 1 and outlive the
      // dispatch — the prod incident class DX-323 fixes. The host pre-
      // flight (`systemd-preflight.ts`) makes the dispatcher refuse to
      // boot without `systemd-run --user --version`; this test pins the
      // shape that goes into that real `systemd-run`.
      mockConfig.isHost = true;
      const argvFile = join(tempDir, "systemd-run-argv.txt");
      const env = {
        ...fakeClasudeEnv(),
        SYSTEMD_RUN_ARGV_FILE: argvFile,
      };

      const job = await new Promise<AgentJob>((resolve, reject) => {
        spawnAgent({
          prompt: "Integration test task",
          repoName: "test-repo",
          timeoutMs: 10_000,
          cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
          statusUrl: captureServer.statusUrl,
          apiToken: "test-token",
          onComplete: resolve,
          env,
        }).catch(reject);
      });

      expect(job.status).toBe("completed");

      // Shim captured one argv element per line.
      const captured = readFileSync(argvFile, "utf-8")
        .split("\n")
        .filter((s) => s.length > 0);
      expect(captured.slice(0, 6)).toEqual([
        "--user",
        "--scope",
        "--unit",
        `danxbot-dispatch-${job.id}`,
        "--quiet",
        "--collect",
      ]);
      // `--` separator is mandatory — without it, `--unit <name>`'s
      // value would parse incorrectly if a future option becomes
      // variadic.
      expect(captured[6]).toBe("--");
      // The inner command is the claude wrapper.
      expect(captured[7]).toBe("claude");
    }, 20_000);

    it("on docker runtime, the headless spawn is NOT wrapped — container boundary is the cgroup", async () => {
      // Anti-goal in DX-325: docker worker mode is UNCHANGED. The
      // container PID namespace already confines the dispatched
      // process tree; wrapping inside the container would require a
      // user systemd instance that intentionally is not present in
      // the worker image.
      mockConfig.isHost = false;
      const argvFile = join(tempDir, "systemd-run-argv-docker.txt");
      const env = {
        ...fakeClasudeEnv(),
        SYSTEMD_RUN_ARGV_FILE: argvFile,
      };

      const job = await new Promise<AgentJob>((resolve, reject) => {
        spawnAgent({
          prompt: "Integration test task",
          repoName: "test-repo",
          timeoutMs: 10_000,
          cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
          statusUrl: captureServer.statusUrl,
          apiToken: "test-token",
          onComplete: resolve,
          env,
        }).catch(reject);
      });

      expect(job.status).toBe("completed");
      // The shim was never invoked → no capture file.
      expect(existsSync(argvFile)).toBe(false);
    }, 20_000);

    it("on host runtime, dispatched agent env carries DANXBOT_DISPATCH_SCOPE=danxbot-dispatch-<jobId> (children + observers identify their owning scope without parsing argv)", async () => {
      // Host-runtime invariant: the env var names a REAL scope unit
      // that `systemctl --user status` can address. Phase 3 wires the
      // reaper to read this var.
      mockConfig.isHost = true;
      const envFile = join(tempDir, "captured-env.txt");
      const argvFile = join(tempDir, "systemd-run-argv-host-env.txt");
      const env = {
        ...fakeClasudeEnv(),
        FAKE_CLAUDE_ENV_CAPTURE_FILE: envFile,
        SYSTEMD_RUN_ARGV_FILE: argvFile,
      };

      const job = await new Promise<AgentJob>((resolve, reject) => {
        spawnAgent({
          prompt: "Integration test task",
          repoName: "test-repo",
          timeoutMs: 10_000,
          cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
          statusUrl: captureServer.statusUrl,
          apiToken: "test-token",
          onComplete: resolve,
          env,
        }).catch(reject);
      });

      expect(job.status).toBe("completed");
      const captured = readFileSync(envFile, "utf-8");
      expect(captured).toContain(
        `DANXBOT_DISPATCH_SCOPE=danxbot-dispatch-${job.id}`,
      );
    }, 20_000);

    it("on docker runtime, DANXBOT_DISPATCH_SCOPE is NOT set (no scope unit exists in the container)", async () => {
      // Setting the var in docker would mislead future consumers (the
      // reaper, ops tooling) that read it as proof of scope existence.
      // Container PID namespace is the cgroup boundary; there is no
      // per-dispatch systemd unit to address.
      mockConfig.isHost = false;
      const envFile = join(tempDir, "captured-env-docker.txt");
      const env = {
        ...fakeClasudeEnv(),
        FAKE_CLAUDE_ENV_CAPTURE_FILE: envFile,
      };

      const job = await new Promise<AgentJob>((resolve, reject) => {
        spawnAgent({
          prompt: "Integration test task",
          repoName: "test-repo",
          timeoutMs: 10_000,
          cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
          statusUrl: captureServer.statusUrl,
          apiToken: "test-token",
          onComplete: resolve,
          env,
        }).catch(reject);
      });

      expect(job.status).toBe("completed");
      const captured = readFileSync(envFile, "utf-8");
      expect(captured).not.toMatch(/^DANXBOT_DISPATCH_SCOPE=/m);
    }, 20_000);
  });

  describe("no statusUrl", () => {
    it("completes without sending heartbeat PUTs", async () => {
      const job = await new Promise<AgentJob>((resolve, reject) => {
        spawnAgent({
          prompt: "Integration test task",
          repoName: "test-repo",
          timeoutMs: 10_000,
          cwd: join(repoDir, ".danxbot", "workspaces", "integration-test"),
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
      const { handleLaunch, clearJobCleanupIntervals } = await import(
        "../../worker/dispatch.js"
      );

      const repo = makeRepoContext({ name: "test-repo", localPath: repoDir });

      // P5 cwd: dispatched agent lands in <repo>/.danxbot/workspaces/<name>/
      // — point fake-claude at the matching session dir so the launcher's
      // SessionLogWatcher (scanning that cwd) finds the JSONL.
      const wsSessionDir = deriveSessionDir(
        join(repoDir, ".danxbot", "workspaces", "integration-test"),
      );
      const originalPath = process.env.PATH;
      const baseEnv = fakeClasudeEnv();
      const envSnapshot = {
        ...baseEnv,
        FAKE_CLAUDE_SESSION_DIR: wsSessionDir,
      };
      const envKeys = Object.keys(envSnapshot);
      Object.assign(process.env, envSnapshot);

      try {
        const req = createMockReqWithBody("POST", {
          workspace: "integration-test",
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

    it("GET /api/status counts a duplicated msg_id JSONL pair exactly once (multi-block-turn dedup)", async () => {
      // End-to-end pin for the msg_id usage dedup contract: fake-claude
      // writes TWO assistant entries sharing the same `message.id` (text +
      // tool_use), the watcher feeds both into the launcher's accumulator,
      // DispatchTracker.finalize writes job.usage to the dispatches row,
      // /api/status renders it. Without dedup every field doubles —
      // production reproduction (gpt-manager job 830cbd99) showed
      // in=12/out=220/cache_creation=200,724 against real charge of
      // in=6/out=110/cache_creation=100,362.
      const { handleLaunch, handleStatus, clearJobCleanupIntervals } =
        await import("../../worker/dispatch.js");

      const repo = makeRepoContext({ name: "test-repo", localPath: repoDir });

      const wsSessionDir = deriveSessionDir(
        join(repoDir, ".danxbot", "workspaces", "integration-test"),
      );
      const originalPath = process.env.PATH;
      const baseEnv = fakeClasudeEnv({ scenario: "dup-msg-id" });
      const envSnapshot = {
        ...baseEnv,
        FAKE_CLAUDE_SESSION_DIR: wsSessionDir,
      };
      const envKeys = Object.keys(envSnapshot);
      Object.assign(process.env, envSnapshot);

      try {
        const launchReq = createMockReqWithBody("POST", {
          workspace: "integration-test",
          task: "msg_id dedup end-to-end",
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

        // The "dup-msg-id" scenario writes two assistant entries with the
        // SAME message.id and the SAME usage block; the deduped job.usage
        // must reflect the response ONCE.
        expect(status).toMatchObject({
          job_id,
          status: "completed",
          input_tokens: 6,
          output_tokens: 110,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 100_362,
        });

        clearJobCleanupIntervals();
      } finally {
        process.env.PATH = originalPath;
        for (const key of envKeys) {
          if (key !== "PATH") delete process.env[key];
        }
      }
    }, 30_000);

    it("GET /api/status returns summed token usage from the dispatch JSONL", async () => {
      const { handleLaunch, handleStatus, clearJobCleanupIntervals } =
        await import("../../worker/dispatch.js");

      const repo = makeRepoContext({ name: "test-repo", localPath: repoDir });

      const wsSessionDir = deriveSessionDir(
        join(repoDir, ".danxbot", "workspaces", "integration-test"),
      );
      const originalPath = process.env.PATH;
      const baseEnv = fakeClasudeEnv();
      const envSnapshot = {
        ...baseEnv,
        FAKE_CLAUDE_SESSION_DIR: wsSessionDir,
      };
      const envKeys = Object.keys(envSnapshot);
      Object.assign(process.env, envSnapshot);

      try {
        const launchReq = createMockReqWithBody("POST", {
          workspace: "integration-test",
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
