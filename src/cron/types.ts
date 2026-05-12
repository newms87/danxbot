/**
 * System cron tick dispatcher — job contract.
 *
 * DX-324: a single crontab entry runs `npx tsx src/cron/tick.ts` every
 * minute. The dispatcher iterates the `jobs[]` registry from
 * `src/cron/jobs/index.ts` and fires every job whose `intervalSec`
 * has elapsed since its last successful run. This file is the
 * contract every registered job must satisfy.
 *
 * Distinct from the in-process per-tick sweep in `sync-and-audit.ts`
 * which runs inside the long-running worker. The system cron path
 * exists so jobs that must survive worker death (orphan reaper,
 * future stale-worktree GC) keep firing without the worker process.
 */

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
   */
  run(): Promise<void>;
}
