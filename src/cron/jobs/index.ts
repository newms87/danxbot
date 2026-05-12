/**
 * Registry of jobs the system cron tick dispatcher (`src/cron/tick.ts`)
 * fires every minute. DX-324 ships the dispatcher with zero jobs;
 * Phase 4 (DX-327 — reap-orphan-dispatches) registers the first
 * concrete job here.
 *
 * Append-only API: every entry MUST satisfy the `CronJob` contract
 * in `../types.ts`. Renaming a `name` field forfeits the prior
 * `lastRunMs` in `<repo>/.danxbot/cron-state.json` and the job fires
 * on the next tick — fine for the renaming release, surprising if
 * unintentional.
 */

import type { CronJob } from "../types.js";
import { reapOrphanDispatches } from "./reap-orphan-dispatches.js";

export const jobs: CronJob[] = [reapOrphanDispatches];
