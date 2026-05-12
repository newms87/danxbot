import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startSlackListener } from "./slack/listener.js";
import { startThreadCleanup } from "./threads.js";
import { startDashboard } from "./dashboard/server.js";
import { startWorkerServer } from "./worker/server.js";
import { startRetentionCron } from "./dashboard/retention.js";
import { initShutdownHandlers } from "./shutdown.js";
import { createLogger } from "./logger.js";
import { runMigrations } from "./db/migrate.js";
import { getPool, initPlatformPool } from "./db/connection.js";
import { startIssuesMirror } from "./db/issues-mirror.js";
import {
  reconcileIssue,
  setReconcileSchedulerHookForRepo,
  setReconcileSystemErrorHookForRepo,
  setReconcileTrackerForRepo,
} from "./issue/reconcile.js";
import { bootRescheduleRetryQueue } from "./issue-tracker/retry-queue.js";
import { setCircuitLogger } from "./issue-tracker/circuit-breaker.js";
import { createIssueTracker } from "./issue-tracker/index.js";
import {
  bootRehydrate,
  bootScheduler,
  onReconcileResult,
} from "./dispatch/scheduler.js";
import {
  listDispatchableYamls,
  listInProgressYamls,
} from "./poller/local-issues.js";
import { clearDispatchAndWrite, loadLocal } from "./poller/yaml-lifecycle.js";
import { tryMultiAgentDispatch } from "./poller/multi-agent-pick.js";
import { recordSystemError } from "./dashboard/system-errors.js";
import { setRepoName } from "./poller/repo-name.js";
import { config, isWorkerMode, workerRepoName } from "./config.js";
import { repoContexts } from "./repo-context.js";
import {
  healOrphanInvariantViolations,
  runInvariantHeal,
} from "./poller/heal.js";
import { isPidAlive } from "./agent/host-pid.js";
import { hostname as osHostname } from "node:os";
import { start as startCronSync } from "./cron/sync-and-audit.js";
import { syncRepoFiles } from "./inject/sync.js";
import {
  getIssuePollerPickupPrefix,
  syncSettingsFileOnBoot,
} from "./settings-file.js";
import { watchRepoEnvFile } from "./dashboard/repo-env-writer.js";
import { reattachOrResolveDispatches } from "./worker/reattach.js";
import { reapOrphans } from "./worker/process-scan.js";
import { ensurePortableRepoPath } from "./agent/portable-path.js";
import { createWorktreeManager } from "./agent/worktree-manager.js";
import { ensureWorktreesProvisioned } from "./agent/ensure-worktrees-provisioned.js";
import { replayStopQueue } from "./worker/replay-stop-queue.js";
import { cleanupLegacyNeedsApproval } from "./worker/legacy-cleanup.js";

const log = createLogger("startup");

// DX-300: wire the Trello circuit-breaker's log surface to the
// project logger ONCE at module load (before any tracker call can
// trip the breaker). Without this the breaker's open/close lines
// would land on the default no-op logger and the operator would
// have no signal a rate-limit cooldown is in effect.
setCircuitLogger(createLogger("trello-circuit"));

/**
 * Assert that the Claude Code session-log directory is accessible and writable.
 *
 * In docker runtime, Claude Code writes JSONL session logs to
 * `~/.claude/projects/` inside the worker container. The compose.yml volume
 * mount (`./repos/<name>/claude-projects:/home/danxbot/.claude/projects`)
 * makes those logs visible to the host so the dashboard can read them via the
 * per-repo override mounts. If that bind mount is missing or read-only, the
 * dashboard will silently see no session data.
 *
 * This function detects and warns about such mismatches at startup rather than
 * waiting for a live dispatch to fail silently.
 *
 * The optional `dir` parameter exists for testability; production callers omit
 * it and use the real Claude Code projects path.
 */
export async function assertJsonlDirectoryAccess(
  repoName: string,
  dir: string = join(homedir(), ".claude", "projects"),
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
    log.info(`[${repoName}] JSONL projects dir OK: ${dir}`);
  } catch (err) {
    log.warn(
      `[${repoName}] JSONL projects dir NOT writable: ${dir} — ` +
        `ensure the compose.yml volume mount is correct so the dashboard can ` +
        `read session logs via the per-repo claude-projects bind. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Dashboard mode: runs shared infrastructure (migrations, dashboard server, cleanup).
 * No poller, no Slack — those run in per-repo worker containers.
 */
async function startDashboardMode(): Promise<void> {
  log.info("Starting Danxbot dashboard...");

  await runMigrations();

  const threadCleanupInterval = startThreadCleanup();
  const retentionInterval = startRetentionCron();

  await startDashboard();

  initShutdownHandlers({ threadCleanupInterval, retentionInterval });

  log.info("Dashboard mode ready — no poller or Slack (workers handle those)");
}

/**
 * Worker mode: manages a single repo (poller, Slack listener, dispatch API).
 * No dashboard — that runs in the shared infrastructure container.
 */
async function startWorkerMode(): Promise<void> {
  log.info(`Starting Danxbot worker for repo: ${workerRepoName}...`);

  const repo = repoContexts[0];
  if (!repo) {
    throw new Error(`Worker mode: no repo context loaded for "${workerRepoName}"`);
  }

  // Fail-loud assert canonical path; see src/agent/portable-path.ts.
  ensurePortableRepoPath(repo.localPath, repo.hostPath);

  // Sync `.danxbot/settings.json` display section from RepoContext on
  // every worker boot. Creates the file on first boot AND refreshes
  // display on every restart so deploys (which always restart the
  // worker) automatically surface the latest masked config — operator
  // `overrides` are preserved across restarts. See
  // `.claude/rules/settings-file.md`.
  await syncSettingsFileOnBoot(repo, config.runtime);

  // DX-303: Watch `<repo>/.danxbot/.env` for credential rotations from
  // the dashboard's PATCH /api/agents/:repo/trello-credentials route
  // (or hand-edits from the operator). The worker's cached
  // `repoContexts[0]` reference is captured at boot and threaded into
  // ~20 downstream consumers (issues mirror, dispatch path, MCP
  // injection, reattach), so swapping the reference live would require
  // invalidating every cached copy across the worker — a parallel
  // refactor the DX-303 AC explicitly allows skipping. The watcher
  // logs a clear "restart required" line so the operator knows to
  // recycle the worker; the PATCH route's response carries
  // `restartRequired: true` to surface the same hint on the dashboard.
  // Full live-reload can ship as a follow-up card once the consumer-
  // side fan-out is stable enough to swap the cached context safely.
  // The handle registers itself with `unwatchAllRepoEnvFiles`, which
  // the shutdown path drains on SIGTERM — no per-handle stashing needed.
  watchRepoEnvFile({
    localPath: repo.localPath,
    onChange: (localPath) => {
      log.warn(
        `[${repo.name}] .env at ${localPath}/.danxbot/.env changed — ` +
          `restart this worker to pick up the new credentials. The worker's ` +
          `cached RepoContext does NOT reload from disk; dispatched agents ` +
          `continue using the old secrets until restart.`,
      );
    },
  });

  // Run the inject pipeline once at boot regardless of poller toggle.
  // Workspace fixtures, danx-* rules, skills, tools, and the mcp-servers/
  // symlink must exist for every dispatched agent — including agents from
  // /api/launch and Slack — even when the Trello poller is disabled. The
  // poll loop re-runs this on every tick when the poller is enabled, but
  // it never runs at all when the poller is disabled, which is why this
  // boot-time call is required.
  syncRepoFiles(repo);

  // Assert that the JSONL projects directory is accessible and writable.
  // Catches missing or misconfigured bind mounts early so operators see a
  // clear warning at startup rather than discovering it via a failed dispatch.
  await assertJsonlDirectoryAccess(repo.name);

  // DX-242 + DX-244: self-heal `<worktree>/node_modules` AND
  // `<worktree>/.env` for every existing agent worktree. Existing
  // worktrees from before either bootstrap-time fix lack the
  // corresponding symlink; this catches them on the next worker boot
  // without operator action. Per-agent failures surface as
  // `worktree`-source system errors so the dashboard agent card flags
  // broken state instead of letting a dispatched agent silently ENOENT
  // on `tsx` resolution (DX-242) or "Missing required environment
  // variable: DANXBOT_DB_USER" at vitest module-load (DX-244).
  try {
    await ensureWorktreesProvisioned(repo, createWorktreeManager());
  } catch (err) {
    // The function itself swallows per-agent failures; an exception
    // here means the settings.json read or the manager constructor
    // itself blew up — log + continue so the rest of boot proceeds.
    // The poller's pre-claim DB guard still keeps things consistent.
    log.error(`[${repo.name}] ensureWorktreesProvisioned failed`, err);
  }

  // Platform pool must be ready before any sql:execute block runs.
  // Disabled repos skip pool creation.
  initPlatformPool(repo.db);

  // Propagate resolved DB credentials to process.env so that child processes
  // (the Claude CLI and any Bash tool it spawns, e.g. describe-tables.sh)
  // can reach the same database the worker is using. Resolved values —
  // docker-service-name → 127.0.0.1 translation has already happened in
  // repo-context when running on host.
  if (repo.db.enabled) {
    process.env.DANX_DB_HOST = repo.db.host;
    process.env.DANX_DB_PORT = String(repo.db.port);
    process.env.DANX_DB_USER = repo.db.user;
    process.env.DANX_DB_PASSWORD = repo.db.password;
    process.env.DANX_DB_NAME = repo.db.database;
  }

  // DX-242: replay queued `danxbot_complete` signals from agents that
  // signaled completion while this worker (or a prior incarnation) was
  // down. The MCP server's fallback chain writes
  // `<repo>/.danxbot/dispatch-stops/<dispatchId>.json` when the stop
  // URL is unreachable; we read each entry, run the same auto-sync +
  // dispatch-row finalization the live `handleStop` runs, then delete
  // the file. Per-entry failures surface as `stop-replay`-source
  // system errors. Run BEFORE `reattachOrResolveDispatches` — that
  // pass marks any still-non-terminal row `failed` based on host_pid
  // liveness, and we want the agent's actual terminal reason to win
  // over the synthetic "orphaned" reason.
  try {
    const replayResult = await replayStopQueue(repo);
    if (
      replayResult.replayed.length > 0 ||
      replayResult.failed.length > 0
    ) {
      log.info(
        `[${repo.name}] Replayed ${replayResult.replayed.length} queued stops, ${replayResult.failed.length} failed`,
      );
    }
  } catch (err) {
    log.error(`[${repo.name}] Stop-queue replay failed`, err);
  }

  // DB-driven full-stack reattach (Phase 2c, DX-209). Supersedes the
  // legacy `reconcileOrphanedDispatches` boot pass:
  //   - Dead-PID rows (and null/non-positive PID) are marked `failed`
  //     with `pid_terminated_at` stamped — same observable behavior as
  //     the prior reconcile, locked by `src/worker/reattach.test.ts`.
  //   - Alive-PID rows are reattached: an `AgentHandle` shim wraps the
  //     existing PID; `attachMonitoringStack` re-wires the watcher /
  //     inactivity timer / cleanup / stop chain; the job is registered
  //     into `activeJobs` so `/api/status`, `/api/cancel`, `/api/stop`
  //     observe parity with newly-spawned dispatches.
  //   - The per-dispatch MCP settings file is rewritten in place when
  //     the worker comes back on a different port (same-port restart
  //     is the production-pinned case → no-op).
  // Failures are logged + swallowed — DB consistency is a side-channel
  // and must not block the worker from serving live dispatches.
  try {
    await reattachOrResolveDispatches(repo.name, {
      currentWorkerPort: repo.workerPort,
      repo,
    });
  } catch (err) {
    log.error(`[${repo.name}] Dispatch reattach failed`, err);
  }

  // Phase 3 (DX-142): process-table orphan scan. Catches dispatched
  // claude processes the durable state (DB row + YAML) lost track of —
  // the May-7 incident shape, where a `script -q -f` parent reparented
  // to PID 1 and survived the worker death after its row went terminal.
  // Runs AFTER `reattachOrResolveDispatches` so any alive non-terminal
  // row already has its monitoring stack rewired; the reaper sees only
  // genuine orphans (terminal-row-but-alive-process / no-row-at-all).
  // Failures swallowed — the worker's primary mission is serving live
  // dispatches, not running a perfect scan tick.
  try {
    const reaped = await reapOrphans({
      repoName: repo.name,
      repoLocalPath: repo.localPath,
    });
    if (
      reaped.scanned > 0 ||
      reaped.reaped.length > 0 ||
      reaped.mismatched.length > 0
    ) {
      log.info(
        `[${repo.name}] Orphan reaper (boot): scanned=${reaped.scanned} reaped=${reaped.reaped.length} mismatched=${reaped.mismatched.length} healthy=${reaped.healthy}`,
      );
    }
  } catch (err) {
    log.error(`[${repo.name}] Orphan reaper (boot) failed`, err);
    // Boot reap failure is observably different from a per-tick
    // failure: per-tick recovers next tick (~60s); a boot failure
    // means the worker came up without ever scanning, so orphans
    // from a prior crash can keep running for the entire poller
    // cadence (hours if the poller is idle). Escalate to the
    // dashboard banner so the operator sees the gap.
    recordSystemError({
      source: "orphan-reaper",
      severity: "error",
      repo: repo.name,
      message: `Orphan reaper boot pass failed — orphans from a prior crash are NOT being reaped this boot; next poller tick will retry`,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // Boot the issues DB mirror (DX-154) BEFORE the poller — the poller's
  // bulk-sync writes go through writeIssue, which awaits the mirror's
  // read-your-writes ack. The mirror's boot scan blocks here so the DB
  // is consistent with disk before any reader queries it. Phase 4+ (DX-
  // 155 / DX-156) swaps internal readers from YAML scans to SQL; until
  // then the mirror runs silently and the YAMLs remain authoritative.
  //
  // Failure here is fatal — the mirror MUST be running before the poller
  // dispatches anything that writes a YAML. Falling through with a
  // dead mirror would leave every subsequent `writeIssue` racing the
  // 5s `awaitMirror` timeout and the DB drifting silently. The mirror's
  // own `reportFailure` writes CRITICAL_FAILURE on per-event errors;
  // a boot-scan failure that propagates here is a hard wiring bug.
  // Reconcile cadence is overridable via env for test fixtures + ops
  // tooling. Production runs the default 10-minute cadence; the
  // poller-fixture system tests squash it to 1s so reconcile-tagged
  // history rows show up in the test window.
  const reconcileIntervalMs =
    process.env.DANXBOT_ISSUES_RECONCILE_INTERVAL_MS !== undefined
      ? Number(process.env.DANXBOT_ISSUES_RECONCILE_INTERVAL_MS)
      : undefined;
  // Phase 4 (DX-155): register the repo's canonical name so the
  // DB-backed readers (`loadLocal`, `findByExternalId`,
  // `listDispatchableYamls`, etc.) can map the worker's `repoLocalPath`
  // into the `repo_name` column on the `issues` table. Must happen
  // BEFORE the mirror boot scan finishes — readers fired from the
  // poller's first tick rely on the registration.
  setRepoName(repo.localPath, repo.name);

  await startIssuesMirror(
    { name: repo.name, localPath: repo.localPath },
    {
      pool: getPool(),
      ...(reconcileIntervalMs !== undefined && { reconcileIntervalMs }),
      // Phase 1 of Event-Driven Worker (DX-216) — reconcile fires after
      // every watcher upsert. Phase 1 body is a no-op chokepoint; later
      // phases activate derived-state computation, tracker push, and
      // scheduler poke.
      onWatcherUpsert: (id) =>
        reconcileIssue(
          {
            name: repo.name,
            localPath: repo.localPath,
            issuePrefix: repo.issuePrefix,
          },
          id,
          "watcher",
        ).then(() => undefined),
    },
  );
  log.info(`[${repo.name}] Issues mirror started`);

  // One-shot boot heal: walk every open YAML and clear any card violating
  // the `(dispatch !== null) === (assigned_agent !== null)` co-ownership
  // invariant when the underlying dispatch is verifiably dead. Covers BOTH
  // orphan directions in one pass:
  //   - `assigned_agent != null + dispatch == null` — orphan claim from
  //     pre-DX-286 producers (the `dispatch` slot was cleared but the
  //     `assigned_agent` stamp survived). These cards block the multi-
  //     agent picker forever — `pickCardForAgent` treats them as owned by
  //     a different agent and silently skips every tick.
  //   - `dispatch != null + assigned_agent == null` — orphan pre-stamp
  //     (DX-286). The picker stamped the dispatch{} block but the spawn
  //     never landed in the DB (paired-write rollback, chokidar race,
  //     mid-spawn crash). Cards in this state drop out of
  //     `listDispatchableYamls` (filter rejects `dispatch != null`) and
  //     were unrecoverable until boot reattach's dead-pid clearing pass.
  // Liveness gate via `checkYamlDispatchLiveness` skips dispatches caught
  // genuinely mid-spawn (alive PID, within TTL, on this host). Runs AFTER
  // the mirror is up (so `writeIssue` awaitMirror resolves) and BEFORE
  // the poller dispatches its first tick. The same scan runs at the top
  // of every poll tick (`src/cron/sync-and-audit.ts`) for ongoing self-heal.
  await runInvariantHeal(repo, "boot");

  // DX-286 — boot pass for the OTHER direction of the invariant:
  // `dispatch != null + assigned_agent == null` (orphan pre-stamp).
  // The picker on a prior boot stamped the dispatch{} block but the
  // dispatch never landed in the DB (paired-write rollback, chokidar
  // race, mid-spawn crash). The card drops out of `listDispatchableYamls`
  // (filter rejects `dispatch != null`) and is unrecoverable until a
  // worker restart triggers boot reattach's dead-pid clearing pass.
  // This boot scan + the per-tick wiring in `_poll` close that gap.
  // Liveness check skips dispatches that are genuinely mid-flight
  // (paired-write between stamp and PID-enrichment).
  try {
    const invariantHeal = await healOrphanInvariantViolations(
      repo.localPath,
      repo.issuePrefix,
      { currentHost: osHostname(), now: Date.now(), isPidAlive },
    );
    if (invariantHeal.healed.length > 0 || invariantHeal.errors.length > 0) {
      log.info(
        `[${repo.name}] Orphan invariant heal: scanned=${invariantHeal.scanned} cleared=${invariantHeal.healed.length} errors=${invariantHeal.errors.length}`,
      );
      for (const h of invariantHeal.healed) {
        const verdict = h.verdict ? ` verdict=${h.verdict}` : "";
        log.warn(
          `[${repo.name}] heal: cleared invariant violation on ${h.id} (kind=${h.kind}${verdict}, dispatch=${h.staleDispatchId ?? "null"}, agent=${h.staleAgent ?? "null"})`,
        );
      }
      for (const e of invariantHeal.errors) {
        log.warn(
          `[${repo.name}] heal: invariant scan error at ${e.path}: ${e.message}`,
        );
      }
    }
  } catch (err) {
    log.error(`[${repo.name}] Orphan invariant heal failed`, err);
  }

  // Phase 3 of Event-Driven Worker (DX-218): register the per-repo
  // tracker with reconcile + the retry-queue scheduler so step 7 (the
  // outbound push) can resolve the tracker without threading it through
  // every callsite. Boot-rescan persisted retry entries and arm their
  // setTimeout timers so a worker restart resumes failed pushes on
  // schedule. Cheap: boot scan walks `<repo>/.danxbot/.trello-retry/`
  // once, typically empty.
  const repoTracker = createIssueTracker(repo);
  const retrySystemErrorHook = (message: string): void => {
    recordSystemError({
      source: "retry-queue",
      severity: "error",
      repo: repo.name,
      message,
    });
  };
  setReconcileTrackerForRepo(repo.name, repoTracker);
  setReconcileSystemErrorHookForRepo(repo.name, retrySystemErrorHook);

  // Phase 4 of Event-Driven Worker (DX-219) — boot the per-repo
  // dispatch scheduler. Validates TrelloTracker credentials fail-loud
  // BEFORE any dispatch fires (AC #3) and registers the tracker so
  // the post-dispatch progress check (AC #4) can resolve it without
  // threading the tracker through every dispatch's onComplete callback.
  // MemoryTracker skips the credential check (constructs without
  // creds) but is still registered for the post-dispatch path.
  //
  // Phase 4b.1 (DX-288) wires the `runPicker` callback so reconcile's
  // dispatchableChanged poke fires the multi-agent picker without
  // waiting for the next `_poll` tick. The closure re-reads card
  // state on each fire so we observe the latest YAML truth (DB-backed
  // via `listDispatchableYamls`). Phase 4b.3 (DX-290) deleted the
  // legacy `_poll` picker invocation; this `runPicker` is now the SOLE
  // dispatcher — fired by reconcile's `onReconcileResult` and
  // settings-watch's `onAgentRosterChange` through the scheduler's
  // single-flight mutex.
  bootScheduler({
    repo,
    tracker: repoTracker,
    runPicker: async ({ now }) => {
      const allCards = await listDispatchableYamls(
        repo.localPath,
        repo.issuePrefix,
      );
      const inProgress = await listInProgressYamls(
        repo.localPath,
        repo.issuePrefix,
      );
      // DX-290: operator-facing pickup-name-prefix filter. Migrated
      // from `_poll`'s deleted dispatch-decision block so the toggle in
      // `<repo>/.danxbot/settings.json` continues to work — when set,
      // ONLY YAMLs whose `title` starts with the prefix are eligible
      // for dispatch. Used by the system-test harness for race-free
      // isolation; operators can also use it to limit the worker to
      // one card class without disabling the poller entirely. Filter
      // here (closure for runPicker) rather than in
      // `listDispatchableYamls` so the in-process settings hot-path
      // observes operator toggles without a worker restart.
      const pickupPrefix = getIssuePollerPickupPrefix(repo.localPath);
      const cards = pickupPrefix
        ? allCards.filter((c) => c.title.startsWith(pickupPrefix))
        : allCards;
      await tryMultiAgentDispatch({
        repo,
        cards,
        inProgress,
        tracker: repoTracker,
        now,
      });
    },
    // Phase 4b.2 (DX-289) — wire reconcile so bootScheduler can start
    // the settings.json file-watch + boot-scan triage timer re-arm.
    reconcile: reconcileIssue,
  });
  setReconcileSchedulerHookForRepo(repo.name, onReconcileResult);

  // Phase 5 (DX-220) — consolidated boot rehydrate. Clears dead-PID /
  // cross-host / dead-TTL dispatch records from open YAMLs (replaces
  // pre-Phase-5 `runStartupReattach`), arms a fresh TTL timer for
  // every alive non-terminal dispatch in the DB, and runs the triage
  // timer boot scan. Tolerates per-card failures internally; never
  // throws past this call site. Runs AFTER `startIssuesMirror` (DB is
  // consistent with disk) and BEFORE the cron's first tick.
  await bootRehydrate({
    repo,
    reconcile: reconcileIssue,
    ttlMs: 2 * 60 * 60 * 1000,
    ttlTimerDeps: {
      isPidAlive,
      reconcile: reconcileIssue,
      clearDispatch: clearDispatchAndWrite,
      loadIssue: loadLocal,
    },
  });

  // DX-265: one-shot cleanup of legacy `Needs Approval` Trello list +
  // label (retired in DX-231; DX-234 left the fossils in place "for
  // the operator to remove by hand" — this is the automated
  // follow-through). Idempotent + per-step graceful-degradation; a
  // failure logs warn-level system events but never blocks boot. Runs
  // AFTER `bootScheduler` (so the tracker is fully registered) and
  // BEFORE `startPoller` (so the poller's first tick sees the
  // post-cleanup board state).
  try {
    await cleanupLegacyNeedsApproval({ repo, tracker: repoTracker });
  } catch (err) {
    log.error(`[${repo.name}] Legacy cleanup pass failed`, err);
    recordSystemError({
      source: "legacy-cleanup",
      severity: "warn",
      repo: repo.name,
      message: `Legacy cleanup pass threw — next boot will retry`,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }


  const reschedule = bootRescheduleRetryQueue({
    repoLocalPath: repo.localPath,
    repoName: repo.name,
    issuePrefix: repo.issuePrefix,
    tracker: repoTracker,
    recordSystemError: retrySystemErrorHook,
  });
  if (reschedule.rearmed > 0 || reschedule.malformed > 0) {
    log.info(
      `[${repo.name}] Retry queue boot-rescheduled: ${reschedule.rearmed} armed, ${reschedule.malformed} malformed`,
    );
  }

  // Start the worker HTTP server (dispatch API + health)
  await startWorkerServer(repo);

  // Start Slack listener for this repo (if configured)
  if (repo.slack.enabled) {
    await startSlackListener(repo);
    log.info(`[${repo.name}] Slack integration enabled`);
  } else {
    log.info(`[${repo.name}] Slack not configured`);
  }

  // Start the cron sync sweep for this repo (renamed from `startPoller`
  // in Phase 5 / DX-220 — the per-minute body is now sync + audit only,
  // dispatch decisions moved to the scheduler engine via DX-287's 4b
  // chain).
  await startCronSync();
  log.info(`[${repo.name}] Cron sync started`);

  initShutdownHandlers({});

  log.info(`Worker mode ready for repo: ${repo.name}`);
}

async function main(): Promise<void> {
  if (isWorkerMode) {
    await startWorkerMode();
  } else {
    await startDashboardMode();
  }
}

main().catch((error) => {
  log.error("Fatal error", error);
  process.exit(1);
});
