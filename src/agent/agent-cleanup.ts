/**
 * Agent cleanup builder — produces the idempotent teardown closure
 * `cleanup()` returned to the launcher's spawnAgent.
 *
 * Lives outside launcher.ts because it owns ~80 LOC of subtle ordering
 * the launcher orchestration shouldn't have to read end-to-end every
 * time someone changes a fork branch. Behavior is byte-identical to the
 * pre-extraction inline implementation; the only abstraction is that
 * the per-spawn handles (timers, watcher, forwarder, dispatchTracker,
 * temp dirs) are passed in via `CleanupBuilderDeps` instead of captured
 * via a closure that also wraps the rest of spawnAgent.
 *
 * Ordering contract preserved:
 *   1. Synchronous teardown FIRST — stops external observers (heartbeat
 *      PUTs, host exit watcher, inactivity + max-runtime timers) before
 *      the first await yields control. Fire-and-forget callers that read
 *      job state immediately after `void cleanup()` see a fully-quiesced
 *      job.
 *   2. Watcher.drain() → watcher.stop() — the drain catches any JSONL
 *      bytes written between the last poll and the close handler so the
 *      final assistant entry's `usage` block lands in `job.usage` BEFORE
 *      `dispatchTracker.finalize` snapshots it.
 *   3. Forwarder flush stashed on `job._forwarderFlush` (not awaited
 *      here) so production cleanup latency stays short while tests can
 *      drain explicitly via `_drainPendingCleanupsForTesting()` —
 *      Trello 69f77e9b77472aefac1317b2.
 *   4. Dispatch row finalize — only when status is non-running.
 *   5. Temp-dir cleanup runs in a `finally` so a synchronous throw from
 *      any observer cannot strand `/tmp/danxbot-prompt-*` or
 *      `/tmp/danxbot-term-*`.
 *
 * Idempotency: the launcher caches the in-flight cleanup promise on the
 * first call so concurrent callers (close handler's `void cleanup()`
 * racing cancelJob's `await job._cleanup()`) all observe the SAME drain
 * + finalize chain. A bare boolean flag would satisfy idempotency but
 * defeat the only reason cancelJob and job.stop await cleanup at all
 * (sequencing the external `putStatus` PUT after the dispatch row's
 * finalize commit). The cache lives in launcher.ts; this module only
 * builds the un-cached `runCleanup` payload.
 */

import { rmSync } from "node:fs";
import { createLogger } from "../logger.js";
import { stopHeartbeat } from "./agent-status.js";
import type { DispatchTracker } from "../dashboard/dispatch-tracker.js";
import type { SessionLogWatcher } from "./session-log-watcher.js";
import type { createInactivityTimer } from "./process-utils.js";
import type { AgentJob } from "./agent-types.js";

type InactivityTimer = ReturnType<typeof createInactivityTimer>;

const log = createLogger("agent-cleanup");

export interface CleanupBuilderDeps {
  job: AgentJob;
  jobId: string;
  watcher: SessionLogWatcher;
  inactivityTimer: InactivityTimer;
  /** Cleared on cleanup; never set when options.maxRuntimeMs was unset. */
  getMaxRuntimeHandle: () => ReturnType<typeof setTimeout> | undefined;
  forwarderFlush?: () => Promise<void>;
  dispatchTracker?: DispatchTracker;
  /** Prompt temp dir or null when the prompt was inlined. */
  promptDir: string | null;
  /** Set by the host fork after spawnHostMode allocates the dir. */
  getTermSettingsDir: () => string | undefined;
}

export function buildCleanup(
  deps: CleanupBuilderDeps,
): () => Promise<void> {
  const {
    job,
    jobId,
    watcher,
    inactivityTimer,
    getMaxRuntimeHandle,
    forwarderFlush,
    dispatchTracker,
    promptDir,
    getTermSettingsDir,
  } = deps;

  return async function runCleanup(): Promise<void> {
    inactivityTimer.clear();
    stopHeartbeat(job);
    const maxRuntimeHandle = getMaxRuntimeHandle();
    if (maxRuntimeHandle) clearTimeout(maxRuntimeHandle);
    // Idempotent + safe after exit. Docker handles no-op; host handles
    // stop the liveness-poll interval.
    job.handle?.dispose();

    // Observer teardown is wrapped in try/finally so a synchronous throw from
    // any observer (watcher.stop, dispatchTracker.finalize, forwarder.flush)
    // cannot strand the temp dirs. Temp-dir cleanup MUST run.
    try {
      // Drain any JSONL bytes written between the last scheduled poll and
      // now BEFORE stopping the watcher. Without this, the agent's final
      // assistant entry — which carries the closing `usage` block + the
      // `tool_use` for `danxbot_complete` — lands in the JSONL after the
      // last tick fired, the watcher halts before reading it, and
      // `dispatchTracker.finalize` snapshots stale `job.usage`. Manifests
      // as every token + counter field undercounting the on-disk JSONL by
      // exactly what was appended in the trailing <pollIntervalMs window.
      await watcher.drain();
      watcher.stop();
      // drainAndSend swallows its own errors (laravel-forwarder.ts) so
      // this never produces an unhandled rejection. Regression guard:
      // the "flush() resolves (does not reject) when the queue
      // directory is removed mid-run" test in laravel-forwarder.test.ts
      // fails if the inner try/catch is removed.
      //
      // Stash the promise on the job (instead of `void`) so test
      // teardown can await any in-flight queue writes BEFORE rmSync of
      // the logs dir — the fire-and-forget shape stays for production
      // cleanup latency, but tests can drain explicitly via
      // `_drainPendingCleanupsForTesting()` in dispatch/core.ts.
      // Reproduce / Trello 69f77e9b77472aefac1317b2.
      job._forwarderFlush = forwarderFlush?.();
      if (dispatchTracker && job.status !== "running") {
        const dispatchStatus =
          job.status === "completed"
            ? "completed"
            : job.status === "canceled"
              ? "cancelled"
              : "failed";
        try {
          await dispatchTracker.finalize(dispatchStatus, {
            summary: job.summary || null,
            error: dispatchStatus === "failed" ? job.summary || null : null,
            tokens: {
              tokensIn: job.usage.input_tokens,
              tokensOut: job.usage.output_tokens,
              cacheRead: job.usage.cache_read_input_tokens,
              cacheWrite: job.usage.cache_creation_input_tokens,
            },
          });
        } catch (err) {
          log.error(`[Job ${jobId}] Dispatch finalize failed`, err);
        }
      }
    } finally {
      // rmSync with force:true is no-op on missing paths, so we don't need
      // existence guards. `promptDir` is null when the prompt was short
      // enough to inline directly into firstMessage (see INLINE_PROMPT_THRESHOLD
      // in claude-invocation.ts) — nothing to clean up in that case.
      if (promptDir) rmSync(promptDir, { recursive: true, force: true });
      const termSettingsDir = getTermSettingsDir();
      if (termSettingsDir) {
        rmSync(termSettingsDir, { recursive: true, force: true });
      }
    }
  };
}
