/**
 * Registry of jobs the in-worker cron dispatcher (`src/cron/worker-loop.ts`)
 * fires on boot + every 60s. DX-324 introduced the registry via the
 * retired system-cron `tick.ts` entry; DX-551 folded the dispatcher
 * INTO the worker. The registry is unchanged — each job's `intervalSec`
 * still gates its own dispatch via `lastRunMs`.
 *
 * Append-only API: every entry MUST satisfy the `CronJob` contract
 * in `../types.ts`. Renaming a `name` field forfeits the prior
 * `lastRunMs` in `<repo>/.danxbot/cron-state.json` and the job fires
 * on the next tick — fine for the renaming release, surprising if
 * unintentional.
 */

import type { CronJob } from "../types.js";
import { reapOrphanDispatches } from "./reap-orphan-dispatches.js";
import { provisionSfcDepsJob } from "./provision-sfc-deps.js";
import { pruneSfcDepsJob } from "./prune-sfc-deps.js";
import { selfRepairDispatch } from "./self-repair-dispatch.js";

export const jobs: CronJob[] = [
  reapOrphanDispatches,
  provisionSfcDepsJob,
  pruneSfcDepsJob,
  selfRepairDispatch,
];
