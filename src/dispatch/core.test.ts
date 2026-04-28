/**
 * Integration tests for `dispatch()` — the unified workspace-shaped entry
 * point for all dispatches. These tests cover the boundary between the
 * caller-facing `DispatchInput` and what ships to claude:
 *
 *   - the on-disk MCP settings file (`--mcp-config <path>`) contents
 *   - the `--allowed-tools` CLI flag contents
 *   - the infrastructure invariants (danxbot always present, stopUrl wired)
 *
 * `spawnAgent` is mocked so we can capture the flag set without actually
 * spawning claude. The settings file is written for real (to a temp dir) —
 * reading it back is the observable boundary that downstream claude would
 * see, which is exactly what we want to assert.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";

const mockSpawnAgent = vi.fn();

vi.mock("../agent/launcher.js", async () => {
  const actual = await vi.importActual<
    typeof import("../agent/launcher.js")
  >("../agent/launcher.js");
  return {
    ...actual,
    spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  };
});

vi.mock("../config.js", () => ({
  config: {
    isHost: false,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 3600000,
    },
    logsDir: "/tmp/danxbot-dispatch-core-logs",
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Hoisted shared state so tests can read what core.ts handed to its
// collaborators. `capturedStallOpts` lets stall-recovery tests trigger the
// onStall callback directly without faking JSONL contents; `mockUpdateDispatch`
// lets the nudge-count test assert on the exact (dispatchId, patch) pair the
// stall callback writes to the dispatches DB.
const { capturedStallOpts, mockUpdateDispatch } = vi.hoisted(() => ({
  capturedStallOpts: [] as Array<{
    onStall: () => void | Promise<void>;
  }>,
  mockUpdateDispatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../dashboard/dispatches-db.js", () => ({
  updateDispatch: (...args: unknown[]) => mockUpdateDispatch(...args),
}));

vi.mock("../agent/terminal-output-watcher.js", () => ({
  TerminalOutputWatcher: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock("../agent/stall-detector.js", () => ({
  StallDetector: class {
    start = vi.fn();
    stop = vi.fn();
    constructor(opts: { onStall: () => void | Promise<void> }) {
      capturedStallOpts.push(opts);
    }
  },
  DEFAULT_MAX_NUDGES: 3,
}));

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { dispatch, listActiveJobs } from "./core.js";
// The mocked `../config.js` module exposes a plain mutable object. The cast
// to `{ isHost: boolean }` defeats the readonly type from the real config
// module — in the mocked factory, the object is a plain literal and writes
// are safe. Used by the `openTerminal` mirror / default tests.
import { config as realConfig } from "../config.js";
const mockedConfig = realConfig as unknown as { isHost: boolean };

const MOCK_REPO = makeRepoContext();
const DEFAULT_DISPATCH_META: DispatchTriggerMetadata = {
  trigger: "api",
  metadata: {
    endpoint: "/api/launch",
    callerIp: "127.0.0.1",
    statusUrl: null,
    initialPrompt: "test task",
  },
};

function makeRunningJob() {
  return {
    id: "mock-job-id",
    status: "running" as const,
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

beforeEach(() => {
  vi.clearAllMocks();
  // capturedStallOpts is a plain array (vi.clearAllMocks resets vi.fn()
  // call history but does NOT touch arrays), so reset it explicitly so a
  // prior test's StallDetector instance doesn't leak into the next.
  capturedStallOpts.length = 0;
  mockSpawnAgent.mockResolvedValue(makeRunningJob());
  mockUpdateDispatch.mockResolvedValue(undefined);
});



describe("dispatch() — slack-worker integration", () => {
  // Copy the real `src/poller/inject/workspaces/slack-worker/` fixture
  // into a per-test tmpdir so the resolver walks actual slack-worker
  // files (workspace.yml + .mcp.json + CLAUDE.md + .claude/). This
  // validates the published workspace contract end-to-end without
  // needing to mock resolveWorkspace.
  //
  // The `makeRepoContext` default has `slack.enabled = true`, so the
  // `settings.slack.enabled ≠ false` gate passes without a
  // `.danxbot/settings.json` file.
  const slackWorkerSrc = resolve(
    __dirname,
    "..",
    "poller",
    "inject",
    "workspaces",
    "slack-worker",
  );

  let tmpRepoDir: string;
  let slackRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-slack-dispatch-"));
    const dest = resolve(
      tmpRepoDir,
      ".danxbot",
      "workspaces",
      "slack-worker",
    );
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });
    slackRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  const SLACK_META: DispatchTriggerMetadata = {
    trigger: "slack",
    metadata: {
      channelId: "C123",
      threadTs: "1700.001",
      messageTs: "1700.002",
      user: "U1",
      userName: null,
      messageText: "why the deploy is stuck?",
    },
  };

  it("auto-injects DANXBOT_SLACK_REPLY_URL and DANXBOT_SLACK_UPDATE_URL into the overlay so callers never pre-compute dispatchId-derived URLs", async () => {
    // The listener passes ONLY `DANXBOT_WORKER_PORT`; the dispatch core
    // fills in the rest. Observable boundary: the danxbot MCP server's
    // env in the written settings.json must contain both URLs pointing
    // at the worker's per-dispatch endpoints.
    const result = await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: { DANXBOT_WORKER_PORT: String(slackRepo.workerPort) },
      apiDispatchMeta: SLACK_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    const env = settings.mcpServers.danxbot.env;
    expect(env.DANXBOT_SLACK_REPLY_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/slack/reply/${result.dispatchId}`,
    );
    expect(env.DANXBOT_SLACK_UPDATE_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/slack/update/${result.dispatchId}`,
    );
    expect(env.DANXBOT_STOP_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/stop/${result.dispatchId}`,
    );
  });

  it("never passes an allowedTools field to spawnAgent — the allowlist concept is gone", async () => {
    await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: { DANXBOT_WORKER_PORT: String(slackRepo.workerPort) },
      apiDispatchMeta: SLACK_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    // The workspace's `.mcp.json` (combined with `--strict-mcp-config`)
    // is the single source of truth for the agent's MCP surface.
    // `allowedTools` no longer exists on SpawnAgentOptions; danxbot_complete
    // is reachable because the danxbot MCP server registers it, not because
    // it's listed in any allowlist.
    expect(opts.allowedTools).toBeUndefined();
  });

  it("rejects the dispatch BEFORE spawnAgent when the workspace contains a stale allowed-tools.txt (loud-fail end-to-end)", async () => {
    // Closes the loop with the resolver-level WorkspaceLegacyFileError test.
    // Drops `allowed-tools.txt` into the slack-worker fixture and asserts
    // `dispatch()` rejects without ever reaching the spawn boundary —
    // proves the resolver's loud-fail actually halts the dispatch path,
    // not just the resolver in isolation.
    const slackWorkerDest = resolve(
      tmpRepoDir,
      ".danxbot",
      "workspaces",
      "slack-worker",
    );
    writeFileSync(resolve(slackWorkerDest, "allowed-tools.txt"), "Read\n");

    await expect(
      dispatch({
        repo: slackRepo,
        task: "investigate",
        workspace: "slack-worker",
        overlay: { DANXBOT_WORKER_PORT: String(slackRepo.workerPort) },
        apiDispatchMeta: SLACK_META,
      }),
    ).rejects.toThrow(/allowed-tools\.txt/);

    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("lands the agent's cwd in the slack-worker workspace directory", async () => {
    await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: { DANXBOT_WORKER_PORT: String(slackRepo.workerPort) },
      apiDispatchMeta: SLACK_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.cwd).toBe(
      resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker"),
    );
  });

  it("refuses to resolve when operator flipped overrides.slack.enabled to false — settings.slack.enabled ≠ false gate fails", async () => {
    // Three-valued settings toggle: operator sets overrides.slack.enabled
    // to false on the Agents tab, the gate fails, dispatch
    // rejects before spawnAgent is ever called. The poller-halt contract
    // uses CRITICAL_FAILURE for env-level breakage; operator toggles are
    // gated at the workspace entry.
    const { writeFileSync } = await import("node:fs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(resolve(tmpRepoDir, ".danxbot"), { recursive: true });
    writeFileSync(
      resolve(tmpRepoDir, ".danxbot", "settings.json"),
      JSON.stringify({
        overrides: {
          slack: { enabled: false },
          trelloPoller: { enabled: null },
          dispatchApi: { enabled: null },
        },
        display: {},
        meta: { updatedAt: "2026-04-24T00:00:00Z", updatedBy: "setup" },
      }),
    );

    await expect(
      dispatch({
        repo: slackRepo,
        task: "should not spawn",
        workspace: "slack-worker",
        overlay: { DANXBOT_WORKER_PORT: String(slackRepo.workerPort) },
        apiDispatchMeta: SLACK_META,
      }),
    ).rejects.toThrow(/settings\.slack\.enabled/);

    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

describe("listActiveJobs()", () => {
  it("returns every job currently in the activeJobs map", async () => {
    const slackWorkerSrc = resolve(
      __dirname,
      "..",
      "poller",
      "inject",
      "workspaces",
      "slack-worker",
    );
    const tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-list-"));
    try {
      const dest = resolve(
        tmpRepoDir,
        ".danxbot",
        "workspaces",
        "slack-worker",
      );
      mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
        recursive: true,
      });
      cpSync(slackWorkerSrc, dest, { recursive: true });
      const testRepo = makeRepoContext({ localPath: tmpRepoDir });

      const { job: jobA } = await dispatch({
        repo: testRepo,
        task: "task A",
        workspace: "slack-worker",
        overlay: { DANXBOT_WORKER_PORT: String(testRepo.workerPort) },
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });
      const { job: jobB } = await dispatch({
        repo: testRepo,
        task: "task B",
        workspace: "slack-worker",
        overlay: { DANXBOT_WORKER_PORT: String(testRepo.workerPort) },
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      const tracked = listActiveJobs();
      expect(tracked).toContain(jobA);
      expect(tracked).toContain(jobB);
    } finally {
      rmSync(tmpRepoDir, { recursive: true, force: true });
    }
  });

  it("returns an array snapshot — mutating it does not mutate internal state", async () => {
    const slackWorkerSrc = resolve(
      __dirname,
      "..",
      "poller",
      "inject",
      "workspaces",
      "slack-worker",
    );
    const tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-snapshot-"));
    try {
      const dest = resolve(
        tmpRepoDir,
        ".danxbot",
        "workspaces",
        "slack-worker",
      );
      mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
        recursive: true,
      });
      cpSync(slackWorkerSrc, dest, { recursive: true });
      const testRepo = makeRepoContext({ localPath: tmpRepoDir });

      await dispatch({
        repo: testRepo,
        task: "task",
        workspace: "slack-worker",
        overlay: { DANXBOT_WORKER_PORT: String(testRepo.workerPort) },
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      const first = listActiveJobs();
      first.length = 0;
      const second = listActiveJobs();
      expect(second.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmpRepoDir, { recursive: true, force: true });
    }
  });
});

/**
 * Tests for the `apiDispatchMeta` plumbing inside `dispatch()`. The HTTP
 * handlers (in `src/worker/dispatch.ts`) build the meta from the request body
 * and hand it to dispatch(); these tests assert that dispatch() forwards it
 * verbatim to the initial spawn and explicitly drops it on stall-recovery
 * respawns. The respawn path also writes `nudgeCount` to the dispatches DB —
 * verified at the same boundary so the column the dashboard reads can never
 * silently regress to zero.
 */
describe("dispatch() — apiDispatchMeta wiring", () => {
  // Fixture and helpers shared across every test in this describe. The
  // workspace is the real on-disk slack-worker (so resolveWorkspace runs
  // for real); the per-test mkdtemp gives each `dispatch()` call its own
  // ~/.danxbot/workspaces/slack-worker tree without leaking between tests.
  const slackWorkerSrc = resolve(
    __dirname,
    "..",
    "poller",
    "inject",
    "workspaces",
    "slack-worker",
  );

  let tmpRepoDir: string;
  let testRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-meta-"));
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });
    testRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
    mockedConfig.isHost = false;
  });

  // setupStallDetection short-circuits unless watcher + terminalLogPath are
  // both present on the spawned job AND statusUrl is on the input. Wrapping
  // the production conditions in a factory keeps the tests focused on the
  // behavior under test, not the harness shape.
  function makeStallReadyJob(suffix: string) {
    return {
      ...makeRunningJob(),
      watcher: { subscribe: vi.fn() },
      terminalLogPath: `/fake/log-${suffix}.txt`,
      stop: vi.fn().mockResolvedValue(undefined),
      _cleanup: vi.fn().mockResolvedValue(undefined),
    };
  }

  // The minimal `DispatchInput` for triggering stall detection — both
  // statusUrl AND apiToken must be set, isHost must be true, and the
  // returned job must have watcher+terminalLogPath. The two stall tests
  // share this exact configuration.
  async function dispatchWithStallEnabled(
    meta: DispatchTriggerMetadata,
  ): Promise<{ dispatchId: string }> {
    return dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: { DANXBOT_WORKER_PORT: String(testRepo.workerPort) },
      apiDispatchMeta: meta,
      statusUrl: "https://forwarder.example/status",
      apiToken: "tok-stall",
    });
  }

  it("apiDispatchMeta is forwarded verbatim to spawnAgent on the initial spawn", async () => {
    // The dispatch row's `trigger` and `triggerMetadata` columns are
    // populated from this struct via spawnAgent → DispatchTracker. Forwarding
    // it verbatim (not reshaping it inside dispatch()) is the contract — the
    // worker handler is responsible for the build, dispatch() just plumbs it.
    const meta: DispatchTriggerMetadata = {
      trigger: "api",
      metadata: {
        endpoint: "/api/launch",
        callerIp: "10.0.0.42",
        statusUrl: null,
        initialPrompt: "investigate failure",
      },
    };

    await dispatch({
      repo: testRepo,
      task: "investigate failure",
      workspace: "slack-worker",
      overlay: { DANXBOT_WORKER_PORT: String(testRepo.workerPort) },
      apiDispatchMeta: meta,
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const opts = mockSpawnAgent.mock.calls[0][0] as {
      dispatch: DispatchTriggerMetadata | undefined;
    };
    expect(opts.dispatch).toEqual(meta);
  });

  it("does NOT pass dispatch on stall-recovery respawn — only the initial spawn records the dispatch row", async () => {
    // Stall-recovery respawns reuse the same dispatchId in `activeJobs`
    // and must NOT create a second row for the same conceptual run. Forgetting
    // this would surface as duplicate dispatch rows in the dashboard, with
    // the second one stamped as a fresh "api" trigger and orphaned from the
    // original caller's correlation ID.
    mockedConfig.isHost = true;
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("initial"));
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("respawn"));

    const meta: DispatchTriggerMetadata = {
      trigger: "api",
      metadata: {
        endpoint: "/api/launch",
        callerIp: null,
        statusUrl: "https://forwarder.example/status",
        initialPrompt: "do thing",
      },
    };

    await dispatchWithStallEnabled(meta);

    // setupStallDetection ran → exactly one StallDetector was
    // constructed and we captured its onStall callback.
    expect(capturedStallOpts).toHaveLength(1);
    await capturedStallOpts[0].onStall();

    // Two spawnAgent calls now: initial + respawn. Initial carries
    // the meta; respawn must have `dispatch: undefined`.
    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    const initialOpts = mockSpawnAgent.mock.calls[0][0] as {
      dispatch: DispatchTriggerMetadata | undefined;
    };
    const respawnOpts = mockSpawnAgent.mock.calls[1][0] as {
      dispatch: DispatchTriggerMetadata | undefined;
    };
    expect(initialOpts.dispatch).toEqual(meta);
    expect(respawnOpts.dispatch).toBeUndefined();
  });

  it("stall callback records nudgeCount on the dispatch row via updateDispatch — increments across multiple stalls", async () => {
    // The stall detector tracks nudge attempts in-memory via `resumeCount`,
    // but the dashboard reads `nudgeCount` off the dispatches table. Without
    // this updateDispatch call the dashboard would silently report zero
    // nudges for every dispatch that recovered via stall — and the cost-
    // attribution ("how often does the stall recovery actually save a run?")
    // would be invisible in production. Asserting both the first and second
    // calls also catches an off-by-one or accidental reset on respawn.
    mockedConfig.isHost = true;
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("initial"));
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("respawn-1"));
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("respawn-2"));

    const result = await dispatchWithStallEnabled(DEFAULT_DISPATCH_META);

    // First stall → resumeCount becomes 1, fresh StallDetector wired up
    // for the respawned job.
    await capturedStallOpts[0].onStall();
    expect(mockUpdateDispatch).toHaveBeenNthCalledWith(1, result.dispatchId, {
      nudgeCount: 1,
    });

    // Second stall on the respawned job → resumeCount becomes 2. The
    // dispatchId on the patch must remain the original — the column is
    // keyed by dispatchId, not by the launcher's internal jobId (which
    // changes on every respawn). And the count must increment, not reset.
    expect(capturedStallOpts).toHaveLength(2);
    await capturedStallOpts[1].onStall();
    expect(mockUpdateDispatch).toHaveBeenNthCalledWith(2, result.dispatchId, {
      nudgeCount: 2,
    });
  });
});
