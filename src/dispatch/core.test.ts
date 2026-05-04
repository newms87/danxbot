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
import {
  dispatch,
  listActiveJobs,
  _drainPendingCleanupsForTesting,
  _resetForTesting,
} from "./core.js";
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

  it("a caller-supplied DANXBOT_WORKER_PORT in the overlay wins over the auto-injected value (precedence contract documented on `DispatchInput.overlay`)", async () => {
    // The `DispatchInput.overlay` docstring says "Caller overlay wins
    // over auto-injected values — tests rely on that." Pin that
    // contract: pass an explicit override and verify the spawn env
    // carries the override, not `String(slackRepo.workerPort)`. This is
    // load-bearing for future refactors that might be tempted to flip
    // the merge order.
    const overrideValue = "9999";
    await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: { DANXBOT_WORKER_PORT: overrideValue },
      apiDispatchMeta: SLACK_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.env.DANXBOT_WORKER_PORT).toBe(overrideValue);
    expect(opts.env.DANXBOT_WORKER_PORT).not.toBe(String(slackRepo.workerPort));
  });

  it("auto-injects DANXBOT_WORKER_PORT from repo.workerPort so callers never duplicate the same `String(repo.workerPort)` line (Phase 5 hotfix, Trello 69f7764f...)", async () => {
    // The slack-worker workspace's `.claude/settings.json` references
    // `${DANXBOT_WORKER_PORT}` and declares it in `required-placeholders`.
    // Pre-hotfix, every dispatch caller (poller, slack listener, HTTP
    // `/api/launch` smoke tests) had to pass it manually; HTTP launches
    // without an overlay therefore failed at workspace resolution time
    // (verified by `make test-system-yaml-memory`). Auto-injection in
    // dispatch core fixes that without forcing every caller to know
    // about the placeholder.
    const result = await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: SLACK_META,
    });

    // The slack-worker's `.claude/settings.json` env block declares
    // `DANXBOT_WORKER_PORT: "${DANXBOT_WORKER_PORT}"`. Auto-injection
    // makes the placeholder resolvable without a caller overlay; the
    // resolver hands the substituted env block to `dispatch`, which
    // forwards it as `env` on the spawnAgent options.
    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.env.DANXBOT_WORKER_PORT).toBe(String(slackRepo.workerPort));
    // The dispatch row's id is the same dispatchId returned to the
    // caller — sanity check that auto-injection used `repo.workerPort`,
    // not some other source.
    expect(result.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("auto-injects DANXBOT_SLACK_REPLY_URL and DANXBOT_SLACK_UPDATE_URL into the overlay so callers never pre-compute dispatchId-derived URLs", async () => {
    // The listener passes ONLY `DANXBOT_WORKER_PORT`; the dispatch core
    // fills in the rest. Observable boundary: the danxbot MCP server's
    // env in the written settings.json must contain both URLs pointing
    // at the worker's per-dispatch endpoints.
    const result = await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: {},
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
    // Phase 3 (tracker-agnostic-agents): the issue-tracker URLs are
    // auto-injected the same way the Slack URLs are. Both land in the
    // danxbot MCP server's env so `danx_issue_save` / `danx_issue_create`
    // can POST back to the worker. A regression that drops these would
    // silently disable the entire issue-tool surface.
    expect(env.DANXBOT_ISSUE_SAVE_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/issue-save/${result.dispatchId}`,
    );
    expect(env.DANXBOT_ISSUE_CREATE_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/issue-create/${result.dispatchId}`,
    );
  });

  it("never passes an allowedTools field to spawnAgent — the allowlist concept is gone", async () => {
    await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: {},
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
        overlay: {},
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
      overlay: {},
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
        overlay: {},
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
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });
      const { job: jobB } = await dispatch({
        repo: testRepo,
        task: "task B",
        workspace: "slack-worker",
        overlay: {},
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
        overlay: {},
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
 * Pin the test-only drain helper added for Trello 69f77e9b77472aefac1317b2:
 * the `yaml-lifecycle-memory-tracker.test.ts` teardown leak. The helper
 * iterates `activeJobs` and awaits each `_cleanup()` + `_forwarderFlush`
 * so test teardown can `rmSync(<config.logsDir>)` without racing the
 * fire-and-forget forwarder flush the launcher kicks off in `runCleanup`.
 *
 * Helper signature is intentionally narrow — these tests guard against
 * regressions that drop one of the two awaited handles, or stop
 * snapshotting `activeJobs` upfront.
 */
describe("_drainPendingCleanupsForTesting", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
  });

  function makeJobWithSpies(id: string): {
    job: ReturnType<typeof makeRunningJob> & {
      _cleanup: ReturnType<typeof vi.fn>;
      _forwarderFlush: Promise<void>;
    };
    cleanupSpy: ReturnType<typeof vi.fn>;
    flushResolve: () => void;
  } {
    const cleanupSpy = vi.fn().mockResolvedValue(undefined);
    let flushResolve!: () => void;
    const flushPromise = new Promise<void>((resolve) => {
      flushResolve = resolve;
    });
    const job = {
      ...makeRunningJob(),
      id,
      _cleanup: cleanupSpy,
      _forwarderFlush: flushPromise,
    };
    return { job, cleanupSpy, flushResolve };
  }

  it("awaits both _cleanup() and _forwarderFlush for every job in the registry", async () => {
    // Two jobs, each with distinct cleanup spy + flush promise. The
    // helper must await BOTH per job — a regression that drops
    // `_forwarderFlush` from the awaited list (or vice versa) is
    // exactly the failure mode this test catches.
    const a = makeJobWithSpies("job-a");
    const b = makeJobWithSpies("job-b");

    const slackWorkerSrc = resolve(
      __dirname,
      "..",
      "poller",
      "inject",
      "workspaces",
      "slack-worker",
    );
    const tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-drain-"));
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

      mockSpawnAgent.mockResolvedValueOnce(a.job);
      mockSpawnAgent.mockResolvedValueOnce(b.job);

      await dispatch({
        repo: testRepo,
        task: "task A",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });
      await dispatch({
        repo: testRepo,
        task: "task B",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      // Drain hangs until both flush promises resolve — proves the
      // helper actually awaits `_forwarderFlush` (not just `_cleanup()`).
      const drainPromise = _drainPendingCleanupsForTesting();
      let drained = false;
      void drainPromise.then(() => {
        drained = true;
      });

      // Yield twice — long enough for any non-awaiting helper variant
      // to early-resolve. If `drained` flips here, the helper is NOT
      // awaiting `_forwarderFlush`.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(drained).toBe(false);

      a.flushResolve();
      b.flushResolve();
      await drainPromise;

      expect(a.cleanupSpy).toHaveBeenCalledTimes(1);
      expect(b.cleanupSpy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmpRepoDir, { recursive: true, force: true });
    }
  });

  it("is a no-op when activeJobs is empty (resolves without error)", async () => {
    // Defensive baseline: a fresh registry should drain instantly.
    // Guards against a future refactor that adds a side effect (e.g.
    // logging) which could throw on an empty input.
    await expect(
      _drainPendingCleanupsForTesting(),
    ).resolves.toBeUndefined();
  });

  it("skips the _forwarderFlush await when the job has no forwarder (poller-style dispatch)", async () => {
    // Poller dispatches gate `eventForwarding` on (statusUrl &&
    // apiToken). When apiToken is absent, the launcher leaves
    // `_forwarderFlush` undefined. The helper must not crash on
    // `await undefined` — TypeScript's `if (job._forwarderFlush)`
    // guard is the contract, this test pins it.
    const cleanupSpy = vi.fn().mockResolvedValue(undefined);
    const job = {
      ...makeRunningJob(),
      id: "poller-job",
      _cleanup: cleanupSpy,
      // _forwarderFlush deliberately undefined.
    };

    const slackWorkerSrc = resolve(
      __dirname,
      "..",
      "poller",
      "inject",
      "workspaces",
      "slack-worker",
    );
    const tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-drain-noflush-"));
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

      mockSpawnAgent.mockResolvedValueOnce(job);

      await dispatch({
        repo: testRepo,
        task: "poller task",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      await expect(
        _drainPendingCleanupsForTesting(),
      ).resolves.toBeUndefined();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
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
      overlay: {},
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
      overlay: {},
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

describe("dispatch() — dispatchId override", () => {
  // Phase 2 of the tracker-agnostic-agents epic (Trello ZDb7FOGO) needs the
  // poller to pre-generate the dispatchId so it can stamp it into the YAML
  // file BEFORE the spawn happens. The optional `dispatchId` override is the
  // mechanism: callers that don't pass one keep getting `randomUUID()`
  // generated inside `dispatch()`; callers that do pass one see it threaded
  // through to `result.dispatchId`, the spawn's `jobId`, and every
  // dispatchId-derived URL in the danxbot MCP server's env block.
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
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-dispatchid-"));
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });
    testRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("uses the caller-supplied dispatchId verbatim when provided", async () => {
    const explicitId = "11111111-2222-3333-4444-555555555555";
    const result = await dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      dispatchId: explicitId,
    });

    expect(result.dispatchId).toBe(explicitId);

    const opts = mockSpawnAgent.mock.calls[0][0] as { jobId: string };
    expect(opts.jobId).toBe(explicitId);
  });

  it("propagates the override into every dispatchId-derived URL in the MCP env", async () => {
    const explicitId = "deadbeef-1234-5678-9abc-deadbeef0000";
    await dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      dispatchId: explicitId,
    });

    const opts = mockSpawnAgent.mock.calls[0][0] as { mcpConfigPath: string };
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    const env = settings.mcpServers.danxbot.env;
    expect(env.DANXBOT_STOP_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/stop/${explicitId}`,
    );
    expect(env.DANXBOT_SLACK_REPLY_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/slack/reply/${explicitId}`,
    );
    expect(env.DANXBOT_SLACK_UPDATE_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/slack/update/${explicitId}`,
    );
    expect(env.DANXBOT_ISSUE_SAVE_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/issue-save/${explicitId}`,
    );
    expect(env.DANXBOT_ISSUE_CREATE_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/issue-create/${explicitId}`,
    );
  });

  it("falls back to randomUUID when no dispatchId is provided (existing callers unchanged)", async () => {
    const result = await dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    // RFC 4122 UUID v4 shape — 8-4-4-4-12 hex.
    expect(result.dispatchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
