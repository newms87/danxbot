/**
 * Single source of truth for "is this dispatch row orphaned?" — used by
 * worker startup reconciliation (`src/worker/reconcile.ts`) and the
 * poller's pre-claim guard (`src/poller/live-dispatch-guard.ts`).
 *
 * A row is orphaned when the worker that spawned it is no longer present
 * to finalize it. That happens in three concrete cases:
 *
 *   1. `host_pid IS NULL` — pre-migration legacy row from before
 *      ISS-69's column landed; the owning worker incarnation has no
 *      stamped PID we can probe.
 *   2. `host_pid <= 0` — sentinel / corrupt value; never a real PID.
 *      Routed here explicitly so we never call `process.kill(0, 0)`,
 *      which targets the current process group and would falsely report
 *      "alive" for every reader.
 *   3. `host_pid` does not respond to signal 0 (`isPidAlive` returns
 *      false) — the kernel has reaped the worker process; nothing left
 *      to finalize the row.
 *
 * Note this is the inverse of "should the poller skip this card." The
 * poller skips when the row is **alive** (not orphaned + has a real
 * PID); reconciliation marks failed when the row IS orphaned. Both
 * consumers should call this helper rather than re-deriving the
 * predicate so the rule stays in one place. See ISS-69.
 */

import type { Dispatch } from "./dispatches.js";

export type IsPidAliveFn = (pid: number) => boolean;

export function isDispatchOrphaned(
  row: Pick<Dispatch, "hostPid">,
  isPidAlive: IsPidAliveFn,
): boolean {
  const pid = row.hostPid;
  if (pid === null) return true;
  if (pid <= 0) return true;
  return !isPidAlive(pid);
}
