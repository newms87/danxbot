import { mkdtempSync } from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeRepoContext } from "./__tests__/helpers/fixtures.js";

// --- Mocks (top-level, before dynamic import) ---

const mockStartThreadCleanup = vi.fn().mockReturnValue("mock-thread-interval");
const mockStartDashboard = vi.fn().mockResolvedValue(undefined);
const mockStartWorkerServer = vi.fn().mockResolvedValue(undefined);
const mockStartSlackListener = vi.fn().mockResolvedValue(undefined);
const mockInitShutdownHandlers = vi.fn();
const mockRunMigrations = vi.fn().mockResolvedValue(undefined);
const mockStartPoller = vi.fn();
const mockInitPlatformPool = vi.fn();

const MOCK_REPO = makeRepoContext();

vi.mock("./slack/listener.js", () => ({
  startSlackListener: mockStartSlackListener,
  stopSlackListener: vi.fn(),
  isSlackConnected: vi.fn().mockReturnValue(true),
}));

vi.mock("./threads.js", () => ({
  startThreadCleanup: mockStartThreadCleanup,
  stopThreadCleanup: vi.fn(),
  getOrCreateThread: vi.fn(),
  addMessageToThread: vi.fn(),
  updateSessionId: vi.fn(),
  isBotParticipant: vi.fn(),
  cleanupOldThreads: vi.fn(),
}));

vi.mock("./dashboard/server.js", () => ({
  startDashboard: mockStartDashboard,
}));

vi.mock("./worker/server.js", () => ({
  startWorkerServer: mockStartWorkerServer,
}));

vi.mock("./shutdown.js", () => ({
  initShutdownHandlers: mockInitShutdownHandlers,
}));

vi.mock("./db/migrate.js", () => ({
  runMigrations: mockRunMigrations,
}));

vi.mock("./db/connection.js", () => ({
  initPlatformPool: mockInitPlatformPool,
  getPlatformPool: vi.fn(),
  closePlatformPool: vi.fn(),
  getPool: vi.fn(),
  getAdminPool: vi.fn(),
  closePool: vi.fn(),
  closeAdminPool: vi.fn(),
  // DX-217 (Event-Driven Worker Phase 2): `reconcileIssue` (wired into
  // index.ts at boot) transitively imports `query` via
  // `src/poller/issues-db.ts`. The mock must export it so module load
  // doesn't trip vitest's strict "No <name> export is defined on the
  // mock" guard.
  query: vi.fn(),
}));

const mockSyncRepoFiles = vi.fn();
vi.mock("./cron/sync-and-audit.js", () => ({
  start: mockStartPoller,
}));

// DX-551 — `startWorkerCronLoop` would otherwise hit the real
// `reap-orphan-dispatches` env asserts (DANXBOT_DB_USER missing in the
// unit test env) and throw on the boot pass. Stub it with a no-op
// handle so worker-mode tests reason about the shutdown wiring
// deterministically.
const mockWorkerCronLoopStop = vi.fn();
const mockStartWorkerCronLoop = vi
  .fn()
  .mockResolvedValue({ stop: mockWorkerCronLoopStop });
vi.mock("./cron/worker-loop.js", () => ({
  startWorkerCronLoop: mockStartWorkerCronLoop,
}));

// DX-636 — stub the event-loop monitor so worker-mode tests can assert
// the shutdown-handler wiring deterministically without spinning a real
// perf_hooks histogram.
const mockEventLoopMonitorStop = vi.fn();
const mockStartEventLoopMonitor = vi.fn().mockReturnValue({
  stop: mockEventLoopMonitorStop,
  tickNow: vi.fn(),
});
vi.mock("./observability/event-loop-monitor.js", () => ({
  startEventLoopMonitor: mockStartEventLoopMonitor,
  getLatestEventLoopSample: vi.fn().mockReturnValue(null),
}));
vi.mock("./inject/sync.js", () => ({
  syncRepoFiles: mockSyncRepoFiles,
}));

const mockStartRetentionCron = vi.fn().mockReturnValue("mock-retention-interval");
vi.mock("./dashboard/retention.js", () => ({
  startRetentionCron: mockStartRetentionCron,
}));

const mockSyncSettingsFileOnBoot = vi.fn().mockResolvedValue(undefined);
const mockWatchSettingsFile = vi.fn().mockReturnValue({
  unwatch: vi.fn().mockResolvedValue(undefined),
});
vi.mock("./settings-file.js", async () => {
  // Spread the real module so DX-365 strike helpers (which import
  // AGENT_STRIKE_TERMINAL_STATUSES + STRIKES_MAX + STRIKES_HISTORY_CAP
  // at module init) resolve all named exports. The test only overrides
  // the boot-flow surfaces below; everything else routes to the real
  // implementation.
  const actual =
    await vi.importActual<typeof import("./settings-file.js")>(
      "./settings-file.js",
    );
  return {
    ...actual,
    syncSettingsFileOnBoot: mockSyncSettingsFileOnBoot,
    watchSettingsFile: mockWatchSettingsFile,
    settingsFilePath: vi.fn((p: string) => `${p}/.danxbot/settings.json`),
    settingsLockPath: vi.fn((p: string) => `${p}/.danxbot/.settings.lock`),
    // DX-329 — boot path now reads the agent roster for the orphan-IP heal.
    readAgents: vi.fn().mockReturnValue([]),
  };
});

// DX-583 — boot path seeds `<repo>/.danxbot/lists.yaml` via ensureListsFile.
// The mock repo path is a string literal, not a real disk path; stub the
// helper so the boot pipeline doesn't try to mkdir/write under it.
const mockEnsureListsFile = vi.fn().mockResolvedValue(undefined);
vi.mock("./lists-file.js", async () => {
  const actual =
    await vi.importActual<typeof import("./lists-file.js")>("./lists-file.js");
  return { ...actual, ensureListsFile: mockEnsureListsFile };
});

// DX-609 — boot path also seeds `<repo>/.danxbot/trello-list-map.yaml` via
// ensureTrelloListMapFile. Same reasoning as the lists-file mock — the
// mock repo path is a string literal, not a real disk path.
const mockEnsureTrelloListMapFile = vi.fn().mockResolvedValue(undefined);
vi.mock("./trello-list-map.js", async () => {
  const actual =
    await vi.importActual<typeof import("./trello-list-map.js")>(
      "./trello-list-map.js",
    );
  return { ...actual, ensureTrelloListMapFile: mockEnsureTrelloListMapFile };
});

const mockStartIssuesMirror = vi.fn().mockResolvedValue({
  repoName: "mock",
  repoLocalPath: "/mock",
  simulateWatcherEvent: vi.fn().mockResolvedValue(undefined),
  reconcileNow: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
});
vi.mock("./db/issues-mirror.js", () => ({
  startIssuesMirror: mockStartIssuesMirror,
  getMirrorByLocalPath: vi.fn().mockReturnValue(undefined),
  hasAnyMirror: vi.fn().mockReturnValue(false),
  createPgIssuesMirrorDb: vi.fn(),
}));

// Default: dashboard mode (no DANXBOT_REPO_NAME, no repo contexts)
// These mocks are overridden in worker describe blocks via vi.doMock
let mockIsWorkerMode = false;
let mockIsDashboardMode = true;
let mockWorkerRepoName = "";
let mockRepoContexts: typeof MOCK_REPO[] = [];
// DX-325 — drives the `if (config.isHost)` guard on the systemd preflight
// call site in startWorkerMode. Default `true` matches the prior behavior
// (this test file's existing config mock had `runtime: "host"` only) and
// reflects the worker's expected production runtime.
let mockIsHost = true;

vi.mock("./config.js", () => ({
  get config() { return { runtime: "host", isHost: mockIsHost }; },
  get isWorkerMode() { return mockIsWorkerMode; },
  get isDashboardMode() { return mockIsDashboardMode; },
  get workerRepoName() { return mockWorkerRepoName; },
}));

// DX-325: mock the systemd boot preflight so the test can assert on the
// wiring without actually probing the host's systemd state. The actual
// preflight has its own dedicated unit suite at
// `src/agent/systemd-preflight.test.ts` covering every probe branch.
const mockPreflightSystemdRun = vi
  .fn<() => Promise<{ ok: boolean; reason?: string; summary?: string }>>()
  .mockResolvedValue({ ok: true });
class MockSystemdPreflightError extends Error {
  readonly reason: string;
  constructor(result: { reason: string; summary: string }) {
    super(result.summary);
    this.name = "SystemdPreflightError";
    this.reason = result.reason;
  }
}
vi.mock("./agent/systemd-preflight.js", () => ({
  preflightSystemdRun: mockPreflightSystemdRun,
  SystemdPreflightError: MockSystemdPreflightError,
}));

vi.mock("./repo-context.js", () => ({
  get repoContexts() { return mockRepoContexts; },
}));

vi.mock("./logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// DX-242: stub the boot-time worktree provisioner + replay so the test
// doesn't hit real filesystem / DB code paths. The boot wiring assertion
// belongs in the dedicated unit suites for each module.
vi.mock("./agent/worktree-manager.js", () => ({
  createWorktreeManager: () => ({
    worktreePath: () => "/unused",
    bootstrap: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    validate: vi.fn().mockResolvedValue({ state: "clean" }),
    syncWorktree: vi.fn().mockResolvedValue({ kind: "noop" }),
    ensureProvisioned: vi.fn().mockResolvedValue(undefined),
    fetchOrigin: vi.fn().mockResolvedValue(true),
  }),
}));
vi.mock("./agent/ensure-worktrees-provisioned.js", () => ({
  ensureWorktreesProvisioned: vi.fn().mockResolvedValue({
    scanned: 0,
    provisioned: [],
    failed: [],
  }),
}));
vi.mock("./worker/replay-stop-queue.js", () => ({
  replayStopQueue: vi
    .fn()
    .mockResolvedValue({ scanned: 0, replayed: [], skipped: [], failed: [] }),
  STOP_QUEUE_DIR: ".danxbot/dispatch-stops",
}));
const mockReattachOrResolveDispatches = vi.fn().mockResolvedValue({
  scanned: 0,
  orphaned: [],
  alive: [],
  reattached: [],
  failedReattach: [],
});
vi.mock("./worker/reattach.js", () => ({
  reattachOrResolveDispatches: mockReattachOrResolveDispatches,
}));
const mockReapOrphans = vi.fn().mockResolvedValue({
  scanned: 0,
  reaped: [],
  mismatched: [],
  healthy: 0,
});
vi.mock("./worker/process-scan.js", () => ({
  reapOrphans: mockReapOrphans,
}));

// --- Test setup ---

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();

  // Re-wire mocks after resetModules clears them
  mockRunMigrations.mockResolvedValue(undefined);
  mockStartThreadCleanup.mockReturnValue("mock-thread-interval");
  mockStartDashboard.mockResolvedValue(undefined);
  mockStartWorkerServer.mockResolvedValue(undefined);
  mockStartSlackListener.mockResolvedValue(undefined);
  mockPreflightSystemdRun.mockResolvedValue({ ok: true });
  mockIsHost = true;
});

// Helper: import index.ts (which runs main() immediately) and flush the full
// async pipeline. main() in worker mode awaits syncSettingsFileOnBoot →
// assertJsonlDirectoryAccess (real fs mkdir/access on ~/.claude/projects) →
// initPlatformPool → startWorkerServer → optional startSlackListener →
// startPoller → initShutdownHandlers. Each await is a fresh microtask + the
// real fs op adds a macrotask boundary. One setTimeout(0) flush is not
// enough — we need to drain until the pipeline quiesces. 30× setTimeout(0)
// gives enough margin under full-suite parallel load that no individual
// boot-pipeline await escapes the drain (DX-244 saw 1-of-3 flake at
// 10× when the test-file count crossed ~220 and per-tick CPU pressure
// spiked); total wait is still <100ms, deterministic across platforms.
async function importIndex(): Promise<void> {
  await import("./index.js");
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ============================================================
// Worker mode tests (DANXBOT_REPO_NAME set)
// ============================================================

// Cold-start cost on this describe block is high because every test
// re-imports `src/index.ts`, which pulls the worker-mode module graph
// (poller, scheduler, settings-watch, triage timers, reattach, ...).
// The first test that lands the import bears the full cost (~4–5s);
// subsequent tests reuse vitest's transform cache. Bump per-test
// timeout so the first test does not flake under CI load.
describe("worker mode startup flow", { timeout: 15_000 }, () => {
  beforeEach(() => {
    mockIsWorkerMode = true;
    mockIsDashboardMode = false;
    mockWorkerRepoName = "test-repo";
    mockRepoContexts = [MOCK_REPO];
  });

  afterEach(() => {
    // Reset to dashboard defaults
    mockIsWorkerMode = false;
    mockIsDashboardMode = true;
    mockWorkerRepoName = "";
    mockRepoContexts = [];
  });

  it("calls startWorkerServer with repo context", async () => {
    await importIndex();

    expect(mockStartWorkerServer).toHaveBeenCalledWith(MOCK_REPO);
  });

  // DX-325 — systemd scope preflight wiring (Phase 2 of DX-323).
  // Each branch is asserted because a regression in `startWorkerMode`
  // (missing guard, swallowed throw, wrong ordering) would silently
  // boot the worker into the broken-env state the preflight was
  // added to prevent.
  describe("systemd-run boot preflight (DX-325)", () => {
    it("calls preflightSystemdRun on host runtime", async () => {
      mockIsHost = true;
      await importIndex();

      expect(mockPreflightSystemdRun).toHaveBeenCalledOnce();
    });

    it("runs the preflight BEFORE startWorkerServer + startPoller (refuses to accept dispatches when scope confinement is unavailable)", async () => {
      mockIsHost = true;
      await importIndex();

      expect(mockPreflightSystemdRun).toHaveBeenCalledBefore(mockStartWorkerServer);
      expect(mockPreflightSystemdRun).toHaveBeenCalledBefore(mockStartPoller);
    });

    it("skips the preflight on docker runtime (container boundary already confines the process tree)", async () => {
      mockIsHost = false;
      await importIndex();

      expect(mockPreflightSystemdRun).not.toHaveBeenCalled();
      // The worker still finishes booting — docker is unaffected.
      expect(mockStartWorkerServer).toHaveBeenCalledOnce();
    });

    it("throws SystemdPreflightError when the preflight fails (worker refuses to boot)", async () => {
      mockIsHost = true;
      mockPreflightSystemdRun.mockResolvedValueOnce({
        ok: false,
        reason: "systemd-run-missing",
        summary: "systemd-run --user --version not on PATH",
      });

      // main() catches the error and calls process.exit(1). Replace
      // exit with a no-op spy that records the call — throwing here
      // would lift to an unhandled rejection because main()'s
      // .catch() is fire-and-forget.
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);

      await importIndex();

      expect(mockPreflightSystemdRun).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
      // Preflight failure → worker boot aborts → these subsequent
      // boot steps never run. Pinning each individually so a future
      // refactor that swallows the throw is caught.
      expect(mockStartWorkerServer).not.toHaveBeenCalled();
      expect(mockStartPoller).not.toHaveBeenCalled();

      exitSpy.mockRestore();
    });
  });

  it("calls initPlatformPool with repo.db before starting the worker server", async () => {
    await importIndex();

    expect(mockInitPlatformPool).toHaveBeenCalledWith(MOCK_REPO.db);
    expect(mockInitPlatformPool).toHaveBeenCalledBefore(mockStartWorkerServer);
  });

  it("syncs the settings file display section before starting the worker server", async () => {
    await importIndex();

    expect(mockSyncSettingsFileOnBoot).toHaveBeenCalledWith(MOCK_REPO, "host");
    expect(mockSyncSettingsFileOnBoot).toHaveBeenCalledBefore(mockInitPlatformPool);
    expect(mockSyncSettingsFileOnBoot).toHaveBeenCalledBefore(mockStartWorkerServer);
  });

  it("starts poller", async () => {
    await importIndex();

    expect(mockStartPoller).toHaveBeenCalledOnce();
  });

  it("calls reapOrphans (DX-142 process-table orphan scan) after reattachOrResolveDispatches with the repo's name + localPath", async () => {
    await importIndex();

    expect(mockReapOrphans).toHaveBeenCalledWith({
      repoName: MOCK_REPO.name,
      repoLocalPath: MOCK_REPO.localPath,
    });
    // Reap runs AFTER reattach (rationale in src/index.ts: alive rows
    // get rewired first; reaper sees only genuine orphans). Locking
    // the order with a CalledBefore assertion catches a future
    // refactor that subtly swaps them.
    expect(mockReattachOrResolveDispatches).toHaveBeenCalledBefore(
      mockReapOrphans,
    );
  });

  it("does not crash the worker boot pipeline when reapOrphans rejects (failure is swallowed + surfaced via system_errors)", async () => {
    mockReapOrphans.mockRejectedValueOnce(new Error("pgrep exploded"));

    await importIndex();

    // startPoller still runs — proves the catch around reapOrphans
    // did not propagate the failure up through main().
    expect(mockStartPoller).toHaveBeenCalledOnce();
  });

  it("starts Slack listener when repo has Slack enabled", async () => {
    await importIndex();

    expect(mockStartSlackListener).toHaveBeenCalledWith(MOCK_REPO);
  });

  it("skips Slack listener when repo has Slack disabled", async () => {
    mockRepoContexts = [makeRepoContext({
      slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    })];

    await importIndex();

    expect(mockStartSlackListener).not.toHaveBeenCalled();
  });

  it("does NOT start dashboard or run migrations", async () => {
    await importIndex();

    expect(mockStartDashboard).not.toHaveBeenCalled();
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  it("does NOT start thread cleanup", async () => {
    await importIndex();

    expect(mockStartThreadCleanup).not.toHaveBeenCalled();
  });

  it("registers shutdown handlers in worker mode", async () => {
    await importIndex();

    // DX-551 — worker mode passes the in-worker cron loop handle to
    // the shutdown handler so SIGTERM clears the interval.
    expect(mockInitShutdownHandlers).toHaveBeenCalledWith({
      workerCronLoop: { stop: mockWorkerCronLoopStop },
      eventLoopMonitor: {
        stop: mockEventLoopMonitorStop,
        tickNow: expect.any(Function),
      },
    });
  });

  it("throws when no repo context is loaded", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    mockRepoContexts = [];

    await importIndex();

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  describe("DANX_DB_* process.env export", () => {
    const DB_ENV_KEYS = [
      "DANX_DB_HOST",
      "DANX_DB_PORT",
      "DANX_DB_USER",
      "DANX_DB_PASSWORD",
      "DANX_DB_NAME",
    ];

    beforeEach(() => {
      for (const key of DB_ENV_KEYS) delete process.env[key];
    });

    afterEach(() => {
      for (const key of DB_ENV_KEYS) delete process.env[key];
    });

    it("exports resolved repo.db values to process.env when db.enabled", async () => {
      mockRepoContexts = [makeRepoContext({
        db: {
          host: "127.0.0.1",
          port: 3306,
          user: "sail",
          password: "secret",
          database: "flytedesk-dev",
          enabled: true,
        },
      })];

      await importIndex();

      expect(process.env.DANX_DB_HOST).toBe("127.0.0.1");
      expect(process.env.DANX_DB_PORT).toBe("3306");
      expect(process.env.DANX_DB_USER).toBe("sail");
      expect(process.env.DANX_DB_PASSWORD).toBe("secret");
      expect(process.env.DANX_DB_NAME).toBe("flytedesk-dev");
    });

    it("does NOT set DANX_DB_* when repo.db.enabled is false", async () => {
      mockRepoContexts = [makeRepoContext({
        db: {
          host: "",
          port: 3306,
          user: "",
          password: "",
          database: "",
          enabled: false,
        },
      })];

      await importIndex();

      for (const key of DB_ENV_KEYS) {
        expect(process.env[key]).toBeUndefined();
      }
    });
  });
});

// ============================================================
// Dashboard mode tests (isDashboardMode + no repos)
// ============================================================

describe("dashboard mode startup flow", () => {
  beforeEach(() => {
    mockIsWorkerMode = false;
    mockIsDashboardMode = true;
    mockWorkerRepoName = "";
    mockRepoContexts = [];
  });

  afterEach(() => {
    mockRepoContexts = [];
  });

  it("runs migrations", async () => {
    await importIndex();

    expect(mockRunMigrations).toHaveBeenCalledOnce();
  });

  it("starts dashboard server", async () => {
    await importIndex();

    expect(mockStartDashboard).toHaveBeenCalledOnce();
  });

  it("starts thread cleanup", async () => {
    await importIndex();

    expect(mockStartThreadCleanup).toHaveBeenCalledOnce();
  });

  it("does NOT start poller or Slack", async () => {
    await importIndex();

    expect(mockStartPoller).not.toHaveBeenCalled();
    expect(mockStartSlackListener).not.toHaveBeenCalled();
  });

  it("does NOT start worker server", async () => {
    await importIndex();

    expect(mockStartWorkerServer).not.toHaveBeenCalled();
  });

  it("does NOT initialize the platform pool", async () => {
    await importIndex();

    expect(mockInitPlatformPool).not.toHaveBeenCalled();
  });

  it("does NOT sync the settings file (workers do that, not dashboards)", async () => {
    await importIndex();

    expect(mockSyncSettingsFileOnBoot).not.toHaveBeenCalled();
  });

  it("calls initShutdownHandlers with thread cleanup + retention interval", async () => {
    mockStartThreadCleanup.mockReturnValue("dash-thread-interval");

    await importIndex();

    expect(mockInitShutdownHandlers).toHaveBeenCalledWith(
      expect.objectContaining({
        threadCleanupInterval: "dash-thread-interval",
        retentionInterval: expect.anything(),
      }),
    );
  });
});

// ============================================================
// assertJsonlDirectoryAccess unit tests
// ============================================================

describe("assertJsonlDirectoryAccess", () => {
  // Import the exported function directly (does not trigger main())
  let assertJsonlDirectoryAccess: (
    repoName: string,
    dir?: string,
  ) => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    ({ assertJsonlDirectoryAccess } = await import("./index.js"));
  });

  it("resolves without throwing when the directory exists and is writable", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "danxbot-assert-ok-"));
    await expect(
      assertJsonlDirectoryAccess("test-repo", tmpDir),
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing when the directory does not exist yet (mkdir creates it)", async () => {
    const newDir = join(mkdtempSync(join(tmpdir(), "danxbot-assert-new-")), "sub");
    await expect(
      assertJsonlDirectoryAccess("test-repo", newDir),
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing when the directory is not writable (logs warn instead)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "danxbot-assert-ro-"));
    // Remove write permission so access(W_OK) fails
    chmodSync(tmpDir, 0o555);
    try {
      await expect(
        assertJsonlDirectoryAccess("test-repo", tmpDir),
      ).resolves.toBeUndefined();
    } finally {
      // Restore permissions so tmp cleanup can remove the dir
      chmodSync(tmpDir, 0o755);
    }
  });
});
