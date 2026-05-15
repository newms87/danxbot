/**
 * Worker-internal cron dispatcher — DX-551.
 *
 * Replaces the retired system-cron entry point (`src/cron/tick.ts`) +
 * `make install-cron`. Every worker process runs `startWorkerCronLoop`
 * once at boot: it fires the same `jobs[]` registry immediately
 * (the boot one-shot pass that catches anything that leaked while
 * the worker was down) and then every 60s while the worker is alive.
 *
 * Why fold cron into the worker:
 *
 * - The cron line was a separate install surface. A fresh host that
 *   skipped `make install-cron` accumulated orphan systemd scopes
 *   silently — no operator signal until manual inspection.
 * - The worker is treated as always-on (otherwise the system is in
 *   a critical-failure state). Anything cron could do at 60s cadence,
 *   a 60s in-worker `setInterval` does without an external scheduler.
 *
 * Design contracts (pinned by `worker-loop.test.ts`):
 *
 * - `runTick` is the pure dispatcher — same gating semantics as the
 *   retired `tick.ts#runTick` (lastRunMs >= intervalSec * 1000;
 *   skips when not due; isolates throws per-job; stamps state only on
 *   success; preserves unknown keys; writes state only when something
 *   fires or fails).
 * - `startWorkerCronLoop` awaits the boot pass before returning so
 *   leaked scopes get reaped before the HTTP server accepts new
 *   dispatches.
 * - Subsequent ticks run on `setInterval(intervalMs)` and swallow
 *   their own errors — an unhandled rejection here would crash the
 *   worker. Per-job throws are isolated by `runTick`; this layer
 *   guards against the rare state-file-corruption / fs-blip class
 *   that throws BEFORE per-job isolation kicks in.
 * - `stop()` clears the interval. Tests + shutdown handler both
 *   depend on this being synchronous + idempotent.
 * - Re-uses the same `cron-state.json` schema as the retired tick
 *   dispatcher so a host upgrade preserves per-job lastRunMs across
 *   the migration (no spurious double-fire on first worker boot).
 */

import { createLogger } from "../logger.js";
import { jobs as defaultJobs } from "./jobs/index.js";
import { readState, writeState, type CronTickState } from "./state.js";
import type { CronJob, CronJobContext } from "./types.js";

const log = createLogger("cron-worker-loop");

/** Default tick cadence (60s) — the smallest `intervalSec` we ship. */
export const DEFAULT_TICK_MS = 60_000;

export interface RunTickArgs {
  readonly jobs: readonly CronJob[];
  readonly repoRoot: string;
  /**
   * DX-563 — repo name forwarded to each job's `run(ctx)` so per-repo
   * jobs (self-repair dispatcher) can scope their work without each
   * one re-reading `DANXBOT_REPO_NAME` from `process.env`. Tests that
   * skip per-repo jobs may omit this field; existing jobs ignore the
   * value entirely.
   */
  readonly repoName?: string;
  /** Defaults to `Date.now()`. Injected by tests. */
  readonly now?: number;
}

export interface RunTickResult {
  readonly fired: string[];
  readonly skipped: string[];
  readonly failed: Array<{ name: string; error: string }>;
}

/**
 * Pure dispatcher — read state, iterate jobs[], fire each due job in
 * declaration order, stamp lastRunMs on success, isolate throws.
 * Identical semantics to the retired `tick.ts#runTick`.
 */
export async function runTick(args: RunTickArgs): Promise<RunTickResult> {
  const now = args.now ?? Date.now();
  const state: CronTickState = { ...readState(args.repoRoot) };
  const fired: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  const ctx: CronJobContext | undefined =
    args.repoName !== undefined
      ? { repoName: args.repoName, repoRoot: args.repoRoot }
      : undefined;

  for (const job of args.jobs) {
    const lastRunMs = state[job.name];
    const elapsed =
      lastRunMs === undefined ? Number.POSITIVE_INFINITY : now - lastRunMs;
    if (elapsed < job.intervalSec * 1000) {
      skipped.push(job.name);
      continue;
    }

    try {
      await job.run(ctx);
      state[job.name] = now;
      fired.push(job.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ name: job.name, error: message });
      process.stderr.write(
        `[danxbot-cron] job "${job.name}" failed: ${message}\n`,
      );
    }
  }

  if (fired.length > 0 || failed.length > 0) {
    writeState(args.repoRoot, state);
  }

  return { fired, skipped, failed };
}

export interface StartWorkerCronLoopArgs {
  readonly repoRoot: string;
  /**
   * DX-563 — repo name piped through to every per-tick `runTick` so
   * per-repo jobs see it on `ctx.repoName`. Optional for backward
   * compatibility with tests that don't exercise per-repo jobs.
   */
  readonly repoName?: string;
  /** Override the registry; defaults to `./jobs/index.js`. */
  readonly jobs?: readonly CronJob[];
  /** Override the tick cadence; defaults to 60_000ms. */
  readonly intervalMs?: number;
  /** Inject a clock for deterministic test runs. */
  readonly now?: () => number;
}

export interface WorkerCronLoopHandle {
  /** Idempotent — second call is a no-op. */
  stop(): void;
}

/**
 * Start the worker-internal cron loop. Awaits the boot one-shot pass
 * before returning, then schedules ticks every `intervalMs` (default
 * 60s). Returns a handle whose `stop()` clears the interval — call
 * from the shutdown handler.
 */
export async function startWorkerCronLoop(
  args: StartWorkerCronLoopArgs,
): Promise<WorkerCronLoopHandle> {
  const jobs = args.jobs ?? defaultJobs;
  const intervalMs = args.intervalMs ?? DEFAULT_TICK_MS;
  const clock = args.now ?? Date.now;

  // Boot one-shot pass — runs every job whose interval has elapsed
  // since the last worker stopped. A throw here propagates: the
  // caller decides whether a failed boot pass should halt worker
  // boot (today: log + continue is the chosen tradeoff in index.ts).
  await runTick({ jobs, repoRoot: args.repoRoot, repoName: args.repoName, now: clock() });

  let stopped = false;
  // Reentrancy guard. `setInterval` fires every `intervalMs` even if
  // the previous tick has not resolved — `runTick` reads + writes
  // `cron-state.json` non-atomically, so overlapping ticks would
  // last-writer-wins on the stamp map. A job whose `run()` exceeds
  // `intervalMs` (rare but possible — SFC-deps install on a fresh
  // shell version, a slow systemctl on a busy host) would race with
  // its own next-tick predecessor without this flag.
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    runTick({ jobs, repoRoot: args.repoRoot, repoName: args.repoName, now: clock() })
      .catch((err) => {
        // The setInterval callback fires `runTick`; per-job throws are
        // already isolated INSIDE runTick. A throw OUT OF runTick is
        // the rare class (corrupt state file, fs-blip on the readState
        // path). Surface it via stderr (matches the retired tick.ts
        // contract — operator-visible) but never reject — an unhandled
        // rejection would crash the worker.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[danxbot-cron] tick threw: ${message}\n`);
        log.warn(`Worker cron tick threw: ${message}`);
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  // Long-running interval should not keep the event loop alive when
  // every other handle has gone — the shutdown handler owns the
  // explicit stop.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
