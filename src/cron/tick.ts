/**
 * System cron tick dispatcher — DX-324.
 *
 * Entry point invoked once per minute by the system crontab line
 * installed via `make install-cron`:
 *
 *   * * * * * cd /home/newms/web/danxbot && /usr/bin/env npx tsx src/cron/tick.ts >> /tmp/danxbot-cron.log 2>&1 # danxbot-cron
 *
 * The dispatcher reads `<repo>/.danxbot/cron-state.json`, iterates
 * the `jobs[]` registry from `./jobs/index.js`, fires every job
 * whose interval has elapsed, isolates failures per-job (one throw
 * does not block the rest), and stamps `state[job.name] = Date.now()`
 * only on successful runs. The post-tick state is written
 * atomically via `writeState`.
 *
 * DESIGN NOTES
 *
 * - No DB access from `tick.ts` itself — only individual jobs may
 *   touch the DB. The dispatcher stays pure so unit tests need
 *   nothing but a tmp dir.
 * - No global mutex: cron's minute granularity makes overlap
 *   negligible. A slow job whose `run()` exceeds 60s simply finds
 *   itself still within its interval on the next tick and skips.
 * - Failures log to stderr (the canonical crontab line pipes stderr
 *   into `/tmp/danxbot-cron.log` for operator visibility) and do
 *   NOT stamp `state[job.name]`. The prior successful value (if
 *   any) is preserved so the operator can see "last green" for each
 *   job.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { jobs as defaultJobs } from "./jobs/index.js";
import { readState, writeState, type CronTickState } from "./state.js";
import type { CronJob } from "./types.js";

export interface RunTickArgs {
  readonly jobs: readonly CronJob[];
  readonly repoRoot: string;
  /** Defaults to `Date.now()`. Injected by tests. */
  readonly now?: number;
}

export interface RunTickResult {
  readonly fired: string[];
  readonly skipped: string[];
  readonly failed: Array<{ name: string; error: string }>;
}

export async function runTick(args: RunTickArgs): Promise<RunTickResult> {
  const now = args.now ?? Date.now();
  const state: CronTickState = { ...readState(args.repoRoot) };
  const fired: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const job of args.jobs) {
    const lastRunMs = state[job.name];
    const elapsed =
      lastRunMs === undefined ? Number.POSITIVE_INFINITY : now - lastRunMs;
    if (elapsed < job.intervalSec * 1000) {
      skipped.push(job.name);
      continue;
    }

    try {
      await job.run();
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

  // Only persist when something fired or failed — an empty registry
  // (DX-324 ships with zero jobs) is a true no-op that leaves the
  // state file absent and the test's "no .danxbot/ side effect"
  // assertion green.
  if (fired.length > 0 || failed.length > 0) {
    writeState(args.repoRoot, state);
  }

  return { fired, skipped, failed };
}

async function main(): Promise<void> {
  try {
    const cwd = process.cwd();
    // Fail-loud guard against a misconfigured cron line `cd`-ing
    // into the wrong directory. A missing `.danxbot/` here means
    // we'd silently write `cron-state.json` under a random tree;
    // throwing is the only thing that surfaces the misconfig in
    // the cron log.
    if (!existsSync(join(cwd, ".danxbot"))) {
      throw new Error(
        `tick.ts launched outside a danxbot repo (no .danxbot/ at ${cwd})`,
      );
    }
    const result = await runTick({ jobs: defaultJobs, repoRoot: cwd });
    if (result.failed.length > 0) {
      // Per-job failures already logged in runTick. Exit 1 so cron
      // records a non-zero status for any future supervisor.
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(
      `[danxbot-cron] tick aborted: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }\n`,
    );
    process.exit(1);
  }
}

// Auto-start when invoked as the direct entrypoint. Matches the
// idiom in `src/cron/sync-and-audit.ts:542` so tsx/node/symlink
// wrappers all detect direct-mode without diverging.
const isDirectEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/cron/tick.ts");

if (isDirectEntrypoint) {
  void main();
}
