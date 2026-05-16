/**
 * In-worker cron tick dispatcher — job contract.
 *
 * DX-324 introduced the registry; DX-551 folded the dispatcher into
 * the running worker. `src/cron/worker-loop.ts` fires every job whose
 * `intervalSec` has elapsed since its last successful run, both on
 * boot (one-shot) and on a 60s `setInterval`. This file is the
 * contract every registered job must satisfy.
 *
 * Distinct from the in-process per-tick sweep in `sync-and-audit.ts`
 * which also runs inside the worker but owns the per-tick poller +
 * audit pass. The cron dispatcher exists so longer-cadence jobs
 * (orphan reaper, SFC-deps provision/prune) hang off ONE shared
 * tick rather than each carrying its own setInterval.
 */

/**
 * Per-tick context every cron job receives. The `repoName` + `repoRoot`
 * pair lets per-repo jobs scope their work without each one re-reading
 * `DANXBOT_REPO_NAME` from `process.env`. Existing jobs whose `run`
 * body takes no args still match the signature — `run` accepts
 * `ctx?` so call sites that ignore it stay zero-churn.
 */
export interface CronJobContext {
  /** Same value as `DANXBOT_REPO_NAME` env. The worker boots one repo per process. */
  readonly repoName: string;
  /** Absolute path to the repo's local clone. Matches `RepoContext.localPath`. */
  readonly repoRoot: string;
}

export interface CronJob {
  /**
   * Stable identifier used as the key in `cron-state.json`. Must
   * remain stable across releases — renaming forfeits the prior
   * `lastRunMs` and the job fires on the next tick.
   */
  readonly name: string;

  /**
   * Minimum seconds between successful runs. The dispatcher checks
   * `Date.now() - lastRunMs >= intervalSec * 1000` (or fires
   * unconditionally when no prior run is recorded).
   */
  readonly intervalSec: number;

  /**
   * The job body. Resolves on success, rejects on failure. A
   * rejection is logged + isolated; the dispatcher keeps running
   * the rest of the registry.
   *
   * `ctx` is supplied by the dispatcher. Existing jobs (orphan
   * reaper, SFC-deps provision/prune) ignore it — they read env /
   * filesystem state directly. Future per-repo jobs (DX-580 worker-
   * fault dispatcher) will consume `ctx.repoName` + `ctx.repoRoot` so
   * they don't re-parse env vars on every tick.
   */
  run(ctx?: CronJobContext): Promise<void>;
}
