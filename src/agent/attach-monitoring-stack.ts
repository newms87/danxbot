/**
 * Attach the monitoring + lifecycle chain to an `AgentJob` skeleton.
 *
 * Phase 2b extraction of the watcher / usage / forwarder /
 * inactivity-timer / heartbeat / max-runtime / cleanup / stop wiring
 * that used to live inline in `spawnAgent`. Behavior-preserving — the
 * code, ordering, and side effects are byte-identical to the
 * pre-extraction implementation; only the seam is new.
 *
 * Why: Phase 2c (DB-driven full-stack reattach, DX-141) needs to bolt
 * the same monitoring stack onto a job whose handle was created by a
 * reattach shim instead of a fresh `runHostModeFork` /
 * `spawnDockerMode`. Inlining the wiring inside `spawnAgent` forced
 * the reattach path to either re-implement it (drift) or call
 * `spawnAgent` itself (which forks a new claude process). This
 * extraction is the seam Phase 2c attaches to.
 *
 * Consumers (Phase 2b only `spawnAgent`; Phase 2c will add the
 * reattach pass) provide:
 *   - `job` — the partial AgentJob from `runSpawnPreflight` OR a
 *     reattach shim. Must already carry id/usage/status — the helper
 *     stamps `watcher`, `_cleanup`, `_onComplete`, `stop`, and (when
 *     tracking) `dispatchTracker`.
 *   - `agentCwd` — the resolved workspace dir, used by
 *     `SessionLogWatcher` to scope its JSONL search.
 *   - `promptDir` — the prompt temp dir from `buildClaudeInvocation`,
 *     or null when the prompt was inlined. Threaded through to the
 *     cleanup builder so it removes the dir on terminal state.
 *   - `options` — the original `SpawnAgentOptions` so the helper can
 *     decide event forwarding / dispatch tracking / heartbeat / max
 *     runtime per the same flags `spawnAgent` reads today.
 *   - `existingDispatchTracker?` (Phase 2c forward-compat seam) —
 *     when set, the helper SKIPS `startDispatchTracking` and uses the
 *     supplied tracker. Phase 2b leaves this unset; fresh-spawn
 *     behavior is unchanged.
 *
 * Returns the lifecycle handles the runtime fork + the `spawnAgent`
 * caller need:
 *   - `cleanup` — the cached, idempotent teardown (same semantics as
 *     before)
 *   - `stop` — the agent self-stop handler returned to `job.stop`
 *   - `dispatchTracker?` — set when fresh-spawn opted into tracking
 *     OR when `existingDispatchTracker` was passed in
 *   - `getLastAssistantText` — runtime-fork accessor for the running
 *     summary (host fork classifies exit on this; docker fork picks
 *     the close-time summary off it)
 *   - `registerTermDir` — the host fork registers the `script -q -f`
 *     temp dir here so the cleanup closure removes it on terminal
 *     state
 */

import { join } from "node:path";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { createInactivityTimer } from "./process-utils.js";
import { SessionLogWatcher } from "./session-log-watcher.js";
import {
  createLaravelForwarder,
  deriveQueuePath,
} from "./laravel-forwarder.js";
import { EventQueue } from "./event-queue.js";
import { getDanxbotCommit } from "./danxbot-commit.js";
import {
  startDispatchTracking,
  type DispatchTracker,
} from "../dashboard/dispatch-tracker.js";
import { startHeartbeat, notifyTerminalStatus } from "./agent-status.js";
import { attachUsageAccumulator } from "./usage-accumulator.js";
import { buildCleanup } from "./agent-cleanup.js";
import { buildJobStopHandler } from "./agent-stop.js";
import { stopAgentTree } from "./job-stop.js";
import { ApiErrorDetector, type ApiErrorInfo } from "./api-error-detector.js";
import { writeFlag } from "../critical-failure.js";
import type { AgentJob, SpawnAgentOptions } from "./agent-types.js";

const log = createLogger("attach-monitoring-stack");

/**
 * DX-260 (Phase 2 of DX-246) — recover cap. The first `MAX_RECOVERS`
 * consecutive API-error synthetic events in a dispatch chain trigger
 * an auto-recover via `POST /api/resume`; the next one writes the
 * per-repo `CRITICAL_FAILURE` flag and ends the chain. Hardcoded
 * because the cap is the same for every dispatch — operator
 * intervention is the only path past it. Exported so tests can import
 * the same constant the production handler reads.
 */
export const MAX_RECOVERS = 3;

export interface AttachMonitoringStackOptions {
  /** Partially-constructed job from preflight (or reattach shim). */
  job: AgentJob;
  /** Stable id used by the watcher's dispatch-tag matcher + log lines. */
  jobId: string;
  /** Resolved workspace dir — scopes the SessionLogWatcher's JSONL search. */
  agentCwd: string;
  /** Prompt temp dir from `buildClaudeInvocation`, or null when inlined. */
  promptDir: string | null;
  /** Pass-through to the dispatch tracker / forwarder / heartbeat / etc. */
  options: SpawnAgentOptions;
  /**
   * Phase 2c reattach seam. When provided, the helper SKIPS the
   * `startDispatchTracking` call (no new row inserted) and uses this
   * tracker as the canonical dispatch row for the spawn. Phase 2b
   * leaves this unset — fresh-spawn behavior is unchanged.
   *
   * Lifecycle ownership invariant the caller MUST honor: the row this
   * tracker references is still in `running` state, AND no other
   * dispatch is currently driving its `finalize`. The helper wires
   * the tracker into `agent-cleanup.ts`'s teardown, which calls
   * `tracker.finalize(...)` exactly once when the spawn reaches a
   * terminal state. Passing in an already-finalized tracker would
   * double-finalize the row; passing in a tracker still claimed by a
   * sibling spawn would race the finalize. Phase 2c reattach honors
   * this by claiming the row (status check + lock acquisition)
   * before passing the tracker here.
   */
  existingDispatchTracker?: DispatchTracker;
  /**
   * Phase 2c reattach seam. When set, the SessionLogWatcher uses this
   * directory directly instead of deriving it from `agentCwd`. Reattach
   * has the JSONL's parent directory stamped on the dispatch row but
   * does not retain the original `cwd` (which is destructive-encoded
   * under `~/.claude/projects/` and not perfectly invertible). Passing
   * the resolved sessionDir avoids reverse-engineering the cwd.
   *
   * Fresh-spawn callers leave this unset; the watcher derives sessionDir
   * from `agentCwd` via `deriveSessionDir` exactly as before.
   */
  sessionDir?: string;
  /**
   * Phase 2c reattach seam. When `true`, the watcher seeds its initial
   * byte offset to the file's current size — historical JSONL entries
   * are NOT re-emitted. Required for reattach: the prior worker
   * incarnation already accumulated the file into the dispatch row's
   * usage / tool-call counters, so replaying would double-count every
   * token and tool call.
   */
  fromEof?: boolean;
  /**
   * Phase 2c reattach seam. Subscribers wired to the watcher BEFORE
   * `watcher.start()` runs so they observe entries from the very first
   * poll cycle. Necessary for reattach because `SessionLogWatcher.start`
   * awaits the first poll before returning — any `onEntry` subscriber
   * registered after `attachMonitoringStack` returns would miss
   * `tool_use` blocks emitted in that first cycle, producing
   * undercounts on `toolCallCount` / `subagentCount` for reattached
   * rows. Fresh-spawn callers leave this unset.
   */
  extraOnEntry?: ReadonlyArray<
    (entry: import("../types.js").AgentLogEntry) => void
  >;
}

export interface AttachedMonitoringStack {
  /**
   * Cached, idempotent cleanup closure. Concurrent callers (close
   * handler racing cancelJob, defensive re-runs) all observe the same
   * drain + finalize chain. See `agent-cleanup.ts` for the ordering
   * contract.
   */
  cleanup: () => Promise<void>;
  /**
   * Agent self-stop handler — assigned to `job.stop`. The helper has
   * already stamped `job.stop` with this; it's surfaced on the result
   * for callers that want to register additional wrappers.
   */
  stop: AgentJob["stop"];
  /**
   * Set when `options.dispatch` triggered a `startDispatchTracking`
   * call OR when `existingDispatchTracker` was passed in. Forwarded
   * to `spawnAgent` so paired-write / reattach can observe the same
   * tracker reference.
   */
  dispatchTracker?: DispatchTracker;
  /**
   * Most-recent assistant text accessor. Runtime forks read this at
   * close time — host classifies the exit on it, docker stamps the
   * summary from it.
   */
  getLastAssistantText: () => string;
  /**
   * Host runtime fork uses this to share its `script -q -f` settings
   * dir with the cleanup closure. Docker fork doesn't allocate one
   * and leaves this unused.
   */
  registerTermDir: (dir: string) => void;
}

/**
 * Wire the watcher / usage / forwarder / inactivity-timer / heartbeat
 * / max-runtime / cleanup / stop chain onto `job`. Mutates `job` —
 * sets `watcher`, `dispatchTracker`, `_cleanup`, `_onComplete`, and
 * `stop`. Returns the lifecycle handles the caller needs to drive
 * the runtime fork.
 */
export async function attachMonitoringStack(
  opts: AttachMonitoringStackOptions,
): Promise<AttachedMonitoringStack> {
  const {
    job,
    jobId,
    agentCwd,
    promptDir,
    options,
    existingDispatchTracker,
    sessionDir,
    fromEof,
    extraOnEntry,
  } = opts;

  // --- SessionLogWatcher: the single monitoring mechanism, runs identically in
  //     both docker and host modes (see `.claude/rules/agent-dispatch.md`). ---
  //     Phase 2c reattach passes `sessionDir` directly + `fromEof: true` so
  //     historical bytes are not replayed into the usage accumulator.
  const watcher = new SessionLogWatcher({
    cwd: agentCwd,
    ...(sessionDir !== undefined ? { sessionDir } : {}),
    pollIntervalMs: 5_000,
    dispatchId: jobId,
    ...(fromEof ? { fromEof: true } : {}),
  });
  job.watcher = watcher;

  // Watcher subscriber: tracks last assistant text for job summary,
  // accumulates per-turn usage (with multi-block dedup), and resets the
  // inactivity timer on every entry. See `usage-accumulator.ts` for the
  // dedup contract.
  const usageAccumulator = attachUsageAccumulator({
    job,
    watcher,
    onActivity: () => inactivityTimer.reset(),
  });

  // --- Optional event forwarding ---
  let forwarderFlush: (() => Promise<void>) | undefined;
  if (options.eventForwarding) {
    const queue = new EventQueue(
      deriveQueuePath(join(config.logsDir, "event-queue"), jobId),
    );
    const forwarder = createLaravelForwarder(
      options.eventForwarding.statusUrl,
      options.eventForwarding.apiToken,
      { queue },
    );
    watcher.onEntry(forwarder.consume);
    forwarderFlush = forwarder.flush;
  }

  // --- Optional dispatch tracking: create a dispatches row and finalize it
  //     when a terminal state is reached. Callers that should not appear in
  //     dispatch history (e.g., Slack router-only) omit options.dispatch.
  //     Phase 2c reattach passes `existingDispatchTracker` to skip the
  //     insert and reuse the row created by the prior dispatch. ---
  let dispatchTracker: DispatchTracker | undefined = existingDispatchTracker;
  if (!dispatchTracker && options.dispatch) {
    dispatchTracker = await startDispatchTracking({
      jobId,
      repoName: options.repoName,
      repoLocalPath: options.repoLocalPath ?? null,
      trigger: options.dispatch,
      runtimeMode: config.isHost ? "host" : "docker",
      danxbotCommit: getDanxbotCommit(),
      watcher,
      startedAtMs: job.startedAt.getTime(),
      parentJobId: options.parentJobId ?? null,
      issueId: options.issueId ?? null,
      agentName: options.agentName ?? null,
      mcpSettingsPath: options.mcpSettingsPath ?? null,
      // DX-260 (Phase 2 of DX-246): recover-chain stamps. Fresh launches
      // pass undefined and the tracker defaults both to chain origin
      // (0 / null); recover-spawned resumes thread the parent's
      // post-increment count + the parent's id here so the chain is
      // queryable from the dashboard.
      recoverCount: options.initialRecoverCount,
      parentRecoverId: options.parentRecoverId ?? null,
    });
  }
  if (dispatchTracker) {
    job.dispatchTracker = dispatchTracker;
  }

  // DX-260 (Phase 2 of DX-246) — API-error auto-recover. Seed the
  // in-memory counter from the inherited value (resume children carry
  // the parent's post-increment count) and wire `ApiErrorDetector`
  // onto the same watcher every other observer reads. The detector's
  // 5s confirmation window debounces transient API stutter; the
  // recover handler implements the cap check + recover POST.
  job.recoverCount = options.initialRecoverCount ?? 0;
  // Keep the detector reference so cleanup can `.stop()` it — the
  // detector's 5s confirmation-window timer is the only setTimeout
  // that survives `watcher.stop()` on its own. Without an explicit
  // `.stop()`, a synthetic that armed within the last 5 seconds
  // before terminal would fire the recover handler AFTER cleanup ran,
  // creating a race where the handler observes a half-disposed job.
  // The `job.status !== "running"` guard at the top of
  // `handleApiErrorRecover` is the second line of defense, but
  // clearing the timer at cleanup time is the first.
  const apiErrorDetector = new ApiErrorDetector({
    jobId,
    watcher,
    getRecoverCount: () => job.recoverCount,
    onApiError: (info) => {
      // DX-322 — route on `info.kind` BEFORE incrementing the recover
      // counter. Rate-limit hits at ANY `recoverCount` jump straight to
      // the throttle handler; retrying inside the limit window is
      // guaranteed waste. Stream-idle synthetics still go through the
      // legacy recover-cap path.
      //
      // We guard on `info.kind` alone, not also on `info.resume_at` —
      // `classifyApiError` already falls back to `kind: "stream_idle"`
      // when the reset is unparseable, so a `rate_limit` kind without
      // `resume_at` is an internal contract violation. The throttle
      // handler's own `if (!info.resume_at)` check (below) surfaces it
      // loudly as `api_error_failed` rather than silently rerouting
      // back to the recover loop.
      if (info.kind === "rate_limit") {
        void handleRateLimitThrottle({ info, job, jobId, options });
        return;
      }
      void handleApiErrorRecover({
        info,
        job,
        jobId,
        dispatchTracker,
        options,
      });
    },
  });

  // Phase 2c (DX-209) — register caller-supplied subscribers BEFORE
  // `watcher.start()`. The watcher's first `poll()` runs inside `start`
  // and emits any pre-existing entries (or — for fresh spawns — any
  // entries that have already landed by the time discovery completes).
  // Subscribers registered AFTER `start()` returns miss that first
  // batch. The reattach pass uses this slot to wire its tool-counter
  // subscriber so post-restart `tool_use` blocks are counted from
  // entry 0 onward.
  if (extraOnEntry) {
    for (const subscriber of extraOnEntry) {
      watcher.onEntry(subscriber);
    }
  }

  watcher.start();

  let termSettingsDirToClean: string | undefined;

  // --- Inactivity timer: resets on watcher entries, reaps the agent tree
  //     via the runtime-aware primitive (host: `systemctl --user stop
  //     <scope>.scope` walks the cgroup; docker: SIGTERM + grace + SIGKILL
  //     on the tracked PID). DX-338 — a direct `job.handle.kill(signal)`
  //     here would only signal the script wrapper on host, re-orphaning
  //     backgrounded grandchildren in the scope's cgroup. ---
  const inactivityTimer = createInactivityTimer(
    () => stopAgentTree({ job, scopeName: job.scopeName }),
    options.timeoutMs,
    (j) => {
      // Fire-and-forget: cleanup awaits drain + finalize internally so the
      // dispatch row converges on its own. The external Laravel PUT is a
      // separate store; a brief order skew vs. the local DB is acceptable.
      void cleanup();
      // The docker close-handler wrapper only PUTs when job.status === "running"
      // at close time; by the time the child exits here it will not issue a
      // terminal PUT. notifyTerminalStatus is the only signal the dispatcher
      // receives for an inactivity timeout.
      notifyTerminalStatus(j, options, "timeout", j.summary);
    },
    job,
  );

  // --- Optional heartbeat ---
  if (options.statusUrl && options.apiToken) {
    startHeartbeat(job, options.apiToken);
  }

  // --- Optional max runtime ---
  let maxRuntimeHandle: ReturnType<typeof setTimeout> | undefined;
  if (options.maxRuntimeMs) {
    maxRuntimeHandle = setTimeout(() => {
      if (job.status === "running") {
        log.info(
          `[Job ${jobId}] Max runtime exceeded — ${options.maxRuntimeMs! / 1000}s — stopping agent tree`,
        );
        // DX-338 — route through stopAgentTree so host runtime reaps
        // the whole cgroup (backgrounded grandchildren included)
        // instead of only signaling the `script -q -f` wrapper.
        // Fire-and-forget: cleanup is invoked unconditionally below
        // and awaits drain + finalize for the dispatch row.
        void stopAgentTree({ job, scopeName: job.scopeName });
        job.status = "timeout";
        job.summary = `Agent exceeded max runtime of ${Math.round(options.maxRuntimeMs! / 1000 / 60)} minutes`;
        job.completedAt = new Date();
        // See inactivity-timer comment — fire-and-forget; cleanup awaits
        // drain + finalize internally.
        void cleanup();
        // See the inactivity-timer comment above — docker close-handler will
        // not issue a terminal PUT once job.status !== "running".
        notifyTerminalStatus(job, options, "timeout", job.summary);
      }
    }, options.maxRuntimeMs);
  }

  // Cache the in-flight cleanup promise so concurrent callers (e.g. the
  // close handler's `void cleanup()` racing cancelJob's `await
  // job._cleanup()`) all observe the SAME drain + finalize chain, instead of
  // the second caller short-circuiting on a flag and resolving its await
  // before the first chain has actually finished. A bare boolean flag would
  // satisfy idempotency but defeat the only reason cancelJob and job.stop
  // await the cleanup at all (sequencing the external `putStatus` PUT after
  // the dispatch row's finalize commit). The un-cached payload lives in
  // `agent-cleanup.ts`; this closure adds the cache + the catch.
  const runCleanup = buildCleanup({
    job,
    jobId,
    watcher,
    inactivityTimer,
    getMaxRuntimeHandle: () => maxRuntimeHandle,
    forwarderFlush,
    dispatchTracker,
    promptDir,
    getTermSettingsDir: () => termSettingsDirToClean,
  });
  let cleanupPromise: Promise<void> | undefined;
  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    // DX-260: stop the API-error detector FIRST so the confirmation-
    // window timer (5s default) can't fire after cleanup begins. The
    // detector subscribes to watcher.onEntry, but a timer armed
    // BEFORE the cleanup is independent of watcher state; without
    // this explicit stop, a synthetic-error fire mid-cleanup races
    // with `dispatchTracker.finalize` and the recover handler ends
    // up calling `job.stop` on a half-disposed job.
    apiErrorDetector.stop();
    // Catch so fire-and-forget callers (close handler, inactivity timer,
    // host onExit) never raise an unhandled rejection if drain/finalize
    // throw. Errors are logged via the inner try/catch around
    // `dispatchTracker.finalize`; this outer .catch is a defense-in-depth
    // net for everything else (drain itself, watcher.stop, forwarderFlush).
    cleanupPromise = runCleanup().catch((err) => {
      log.error(`[Job ${jobId}] Cleanup failed`, err);
    });
    return cleanupPromise;
  }

  job._cleanup = cleanup;
  job._onComplete = () => options.onComplete?.(job);

  // --- Agent-initiated stop mechanism ---
  // The agent calls stop() via the HTTP /api/stop/:jobId endpoint when lifecycle
  // tools signal completion. This is distinct from cancelJob() (user-initiated).
  // See `agent-stop.ts` for the SIGTERM/SIGKILL grace pattern + cleanup
  // ordering rationale.
  const stop = buildJobStopHandler({
    job,
    jobId,
    cleanup,
    statusUrl: options.statusUrl,
    apiToken: options.apiToken,
    onComplete: options.onComplete,
  });
  job.stop = stop;

  return {
    cleanup,
    stop,
    dispatchTracker,
    getLastAssistantText: usageAccumulator.getLastAssistantText,
    registerTermDir: (dir) => {
      termSettingsDirToClean = dir;
    },
  };
}

/**
 * DX-260 (Phase 2 of DX-246) — recover handler invoked by the
 * `ApiErrorDetector` after the 5s confirmation window confirms a
 * Claude API stream-idle synthetic error.
 *
 * Increments the chain's recover counter (in-memory + DB), then
 * branches on the cap:
 *
 *  - **Cap exhausted** (count > `MAX_RECOVERS`): writes the per-repo
 *    `CRITICAL_FAILURE` flag so the poller halts, then calls
 *    `job.stop("api_error_failed", summary)` which collapses the
 *    in-memory status to `failed` AND the dispatch row to `failed`
 *    via `buildCleanup`. The agent dies; no `/api/resume` POSTs;
 *    operator clears the flag to resume polling.
 *
 *  - **Recover ok** (count ≤ `MAX_RECOVERS`): calls
 *    `job.stop("api_error_recover", summary)` which collapses the
 *    in-memory status to `recovered` and finalizes the dispatch row
 *    as `recovered`; then POSTs `/api/resume` so the chain continues
 *    on a fresh row stamped with `parent_recover_id` pointing back
 *    here. Resume failures are logged but do NOT escalate to the
 *    flag — a one-off /api/resume failure is recoverable (the
 *    poller will re-dispatch the card on its next tick); persisting
 *    the cap-exhausted halt for a transient HTTP error would defeat
 *    the whole feature.
 *
 * Fire-and-forget from the detector's callback because the detector
 * runs inside `setTimeout` and has no way to await our work. The
 * function captures every error in its own try/catch so a thrown
 * error here never escapes as an unhandled rejection.
 */
async function handleApiErrorRecover(args: {
  info: ApiErrorInfo;
  job: AgentJob;
  jobId: string;
  dispatchTracker: DispatchTracker | undefined;
  options: SpawnAgentOptions;
}): Promise<void> {
  const { info, job, jobId, dispatchTracker, options } = args;
  try {
    if (job.status !== "running") {
      // The job already reached terminal — either the agent self-
      // signaled or a sibling observer (stall detector, inactivity
      // timer, cancel) tore it down between the detector arming and
      // firing. The recover would step on the existing terminal.
      log.info(
        `[Job ${jobId}] API-error detector fired after job reached terminal (${job.status}); skipping recover`,
      );
      return;
    }

    const newCount = job.recoverCount + 1;
    job.recoverCount = newCount;
    if (dispatchTracker) {
      await dispatchTracker.recordRecoverCount(newCount);
    }

    const summary = `API error stream-idle recover ${newCount}/${MAX_RECOVERS}: ${info.errorText}`;

    if (newCount > MAX_RECOVERS) {
      log.warn(
        `[Job ${jobId}] API-error recover cap (${MAX_RECOVERS}) exhausted — writing CRITICAL_FAILURE flag and failing dispatch`,
      );
      const recoverContext = options.recoverContext;
      if (recoverContext) {
        // The flag's `dispatchId` is the LAST row in the recover
        // chain — the one whose agent saw the cap fire. Operators
        // walking back via `parent_recover_id` can reach every
        // earlier attempt.
        writeFlag(recoverContext.repoLocalPath, {
          source: "agent",
          dispatchId: jobId,
          reason: "API-error recover cap exhausted",
          detail: info.errorText,
        });
      } else {
        log.error(
          `[Job ${jobId}] cap exhausted but recoverContext absent — cannot write CRITICAL_FAILURE flag`,
        );
      }
      await job.stop("api_error_failed", summary);
      return;
    }

    // Recover-ok branch. Check `recoverContext` BEFORE finalizing the
    // row — otherwise an absent context (tests / ad-hoc spawns / a
    // future caller that bypasses dispatch()) would leave the row
    // marked `recovered` with no resume-child to back it up. The
    // dashboard would show a terminated dispatch in `recovered` state
    // forever, the Slack listener's short-circuit would wait for a
    // recover-child that never comes, and the poller's "skip
    // recovered" check (`handleAgentCompletion` in `poller/index.ts`)
    // would let the next tick re-dispatch the same card with no
    // record of the failure. Failing loudly to `api_error_failed`
    // here surfaces the misconfiguration as a CRITICAL_FAILURE-style
    // halt instead of a silent leak.
    if (!options.recoverContext) {
      log.error(
        `[Job ${jobId}] recover ok-path: recoverContext absent — cannot continue chain; collapsing to api_error_failed`,
      );
      await job.stop("api_error_failed", summary);
      return;
    }

    log.warn(
      `[Job ${jobId}] API-error stream-idle synthetic detected (recover ${newCount}/${MAX_RECOVERS}) — killing dispatch and re-resuming`,
    );

    // job.stop drains the forwarder, finalizes the dispatch row
    // (status=recovered), and SIGTERMs the agent. The resume POST
    // below happens AFTER the row is finalized so the new row's
    // parent_recover_id references a terminal row.
    await job.stop("api_error_recover", summary);

    const { originalTask, workspace, workerPort } = options.recoverContext;
    const resumeUrl = `http://localhost:${workerPort}/api/resume`;
    const body: Record<string, unknown> = {
      repo: options.repoName,
      job_id: jobId,
      task: originalTask,
      workspace,
      recover_count: newCount,
      parent_recover_id: jobId,
    };
    if (options.apiToken) body.api_token = options.apiToken;

    try {
      const response = await fetch(resumeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "<no body>");
        log.error(
          `[Job ${jobId}] /api/resume returned HTTP ${response.status}: ${text}`,
        );
        return;
      }
      log.info(
        `[Job ${jobId}] API-error recover succeeded — /api/resume accepted; chain continues`,
      );
    } catch (err) {
      log.error(`[Job ${jobId}] /api/resume POST failed`, err);
    }
  } catch (err) {
    log.error(`[Job ${jobId}] API-error recover handler threw`, err);
  }
}

/**
 * DX-322 — rate-limit throttle handler. Invoked by `ApiErrorDetector`
 * when a synthetic error matched the rate-limit pattern AND a valid
 * `resume_at` was parsed. Skips the `recoverCount` increment + the
 * `/api/resume` POST entirely; the chain ends here pending the
 * deadline.
 *
 * Two-layer pattern, mirroring `handleApiErrorRecover`:
 *
 *   1. Write the throttle flag (`source: "throttle"`, `resume_at`,
 *      `throttle_kind: "rate_limit"`) to `<repo>/.danxbot/CRITICAL_FAILURE`
 *      so the poller halt-gate honors the deadline. The flag is read
 *      by the gate on every tick; past `resume_at` the read path
 *      auto-unlinks the file and the gate proceeds normally.
 *   2. Call `job.stop("rate_limited", summary)` which collapses the
 *      in-memory status to `throttled` and finalizes the dispatch row
 *      as `throttled` via `buildCleanup`. SIGTERMs the agent; no
 *      `/api/resume` POST (the picker re-dispatches the card on the
 *      first tick past `resume_at`).
 *
 * `recoverContext` is required because the flag path is repo-local
 * (`recoverContext.repoLocalPath`). When it is absent (tests / ad-hoc
 * spawns bypassing dispatch()), we fall back to the legacy
 * stream-idle recover path — same defensive shape `handleApiErrorRecover`
 * uses. Throttles WITHOUT a flag would silently let the next picker
 * tick re-dispatch into the same limit, so we never proceed without
 * the flag landing first.
 */
async function handleRateLimitThrottle(args: {
  info: ApiErrorInfo;
  job: AgentJob;
  jobId: string;
  options: SpawnAgentOptions;
}): Promise<void> {
  const { info, job, jobId, options } = args;
  try {
    if (job.status !== "running") {
      log.info(
        `[Job ${jobId}] Rate-limit throttle fired after job reached terminal (${job.status}); skipping`,
      );
      return;
    }
    if (!info.resume_at) {
      // Internal contract violation — `classifyApiError` only emits
      // `kind: "rate_limit"` when it parsed a `resume_at`. If we got
      // here without one, something upstream silently dropped it.
      // Surface as `api_error_failed` (NOT a silent fall-through to
      // the recover loop) so operators see the regression in the
      // dispatch row.
      log.error(
        `[Job ${jobId}] Rate-limit throttle invoked without resume_at — internal bug; collapsing to api_error_failed`,
      );
      await job.stop("api_error_failed", `Rate-limit detected but resume_at missing: ${info.errorText}`);
      return;
    }
    const summary = `Anthropic rate-limit — resumes at ${info.resume_at} (${info.errorText})`;
    const recoverContext = options.recoverContext;
    if (!recoverContext) {
      log.error(
        `[Job ${jobId}] Rate-limit throttle: recoverContext absent — cannot write throttle flag; collapsing to api_error_failed`,
      );
      await job.stop("api_error_failed", summary);
      return;
    }
    log.warn(
      `[Job ${jobId}] Anthropic rate-limit — writing throttle flag with resume_at=${info.resume_at}; poller auto-clears past deadline`,
    );
    try {
      writeFlag(recoverContext.repoLocalPath, {
        source: "throttle",
        dispatchId: jobId,
        reason: "Anthropic rate-limit reached",
        detail: info.errorText,
        resume_at: info.resume_at,
        throttle_kind: "rate_limit",
      });
    } catch (writeErr) {
      // Flag write can fail on a disk error (ENOSPC, EACCES) or a
      // writer-side invariant violation. Without the flag the
      // poller has no signal to auto-clear past `resume_at`, so we
      // can't safely mark the dispatch `throttled` — the next tick
      // would re-dispatch the card straight into the live rate-
      // limit. Collapse to `api_error_failed` so the dispatch row
      // records the precise failure mode (and the operator sees the
      // ENOSPC / etc. via the summary) rather than silently
      // succeeding past the cleanup.
      const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      log.error(
        `[Job ${jobId}] Rate-limit throttle: writeFlag failed (${errMsg}) — collapsing to api_error_failed`,
      );
      await job.stop(
        "api_error_failed",
        `Rate-limit detected but throttle-flag write failed: ${errMsg}`,
      );
      return;
    }
    await job.stop("rate_limited", summary);
  } catch (err) {
    log.error(`[Job ${jobId}] Rate-limit throttle handler threw`, err);
  }
}
