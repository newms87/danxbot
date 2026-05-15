/**
 * Registry assertion for `src/cron/jobs/index.ts` — DX-327 AC9.
 *
 * `worker-loop.ts#runTick` imports `defaultJobs` from this index.
 * Removing or renaming an entry here silently disables the reaper.
 * Pin the presence of `reapOrphanDispatches` so a regression fails CI.
 */

import { describe, expect, it } from "vitest";
import { jobs } from "./index.js";
import { reapOrphanDispatches } from "./reap-orphan-dispatches.js";
import { provisionSfcDepsJob } from "./provision-sfc-deps.js";
import { pruneSfcDepsJob } from "./prune-sfc-deps.js";
import { selfRepairDispatch } from "./self-repair-dispatch.js";

describe("cron jobs registry", () => {
  it("registers the orphan-dispatch reaper", () => {
    expect(jobs).toContain(reapOrphanDispatches);
  });

  it("registers the SFC-deps provision + prune jobs (DX-540)", () => {
    expect(jobs).toContain(provisionSfcDepsJob);
    expect(jobs).toContain(pruneSfcDepsJob);
  });

  it("registers the self-repair dispatcher (DX-563)", () => {
    expect(jobs).toContain(selfRepairDispatch);
  });

  it("currently registers exactly four jobs: reaper + provision-sfc-deps + prune-sfc-deps + self-repair-dispatch", () => {
    // Pin the count so a future PR that adds a job has to update
    // this expectation — keeps the registry surface visible in PR
    // review rather than hiding behind a `toContain` check that
    // green-lights silent additions.
    expect(jobs).toEqual([
      reapOrphanDispatches,
      provisionSfcDepsJob,
      pruneSfcDepsJob,
      selfRepairDispatch,
    ]);
  });
});
