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
import type { AgentJob, SpawnAgentOptions } from "./agent-types.js";

const log = createLogger("attach-monitoring-stack");

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
      trigger: options.dispatch,
      runtimeMode: config.isHost ? "host" : "docker",
      danxbotCommit: getDanxbotCommit(),
      watcher,
      startedAtMs: job.startedAt.getTime(),
      parentJobId: options.parentJobId ?? null,
      issueId: options.issueId ?? null,
      agentName: options.agentName ?? null,
      mcpSettingsPath: options.mcpSettingsPath ?? null,
    });
  }
  if (dispatchTracker) {
    job.dispatchTracker = dispatchTracker;
  }

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

  // --- Inactivity timer: resets on watcher entries, kills via the runtime-
  //     aware handle (docker: child.kill; host: process.kill(pid, sig)). ---
  const inactivityTimer = createInactivityTimer(
    (signal) => job.handle?.kill(signal),
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
          `[Job ${jobId}] Max runtime exceeded — ${options.maxRuntimeMs! / 1000}s — killing process`,
        );
        job.handle?.kill("SIGTERM");
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
