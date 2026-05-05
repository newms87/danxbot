/**
 * Worker startup reconciliation — close out dispatch rows the previous
 * worker left in a non-terminal state.
 *
 * Host-mode dispatches outlive the worker (`script -q -f` reparents the
 * claude child to PID 1). When the worker dies and a new one starts, the
 * `dispatches` table still has `running` rows for the prior worker
 * incarnation. Two distinct cases:
 *
 *   - `host_pid` is alive (or matches the current worker PID) — the
 *     claude process from the prior worker is STILL running, working the
 *     card. Leave the row alone; ISS-68's stop-handler DB fallback will
 *     finalize it when claude calls `danxbot_complete`. The poller's
 *     pre-claim DB guard prevents a duplicate dispatch in the meantime.
 *
 *   - `host_pid` is null (legacy row from before migration 013) OR dead —
 *     the owning process is gone. Mark `failed` with a clear summary so
 *     the dashboard converges and the row stops looking active forever.
 *
 * This is the higher-value half of ISS-69: even without the poller guard,
 * marking orphaned rows terminal at startup keeps the DB honest.
 */

import { isPidAlive } from "../agent/host-pid.js";
import { createLogger } from "../logger.js";
import {
  findNonTerminalDispatches,
  updateDispatch,
} from "../dashboard/dispatches-db.js";
import { isDispatchOrphaned } from "../dashboard/dispatch-liveness.js";

const log = createLogger("worker-reconcile");

const ORPHAN_SUMMARY =
  "Worker restarted while dispatch was running — agent process orphaned";

export interface ReconcileResult {
  scanned: number;
  orphaned: string[];
  alive: string[];
}

/**
 * Scan non-terminal dispatch rows for `repoName` and mark every row whose
 * `host_pid` is null or dead as `failed`. Rows with a still-alive PID are
 * left as-is.
 *
 * Errors per row are logged and swallowed — one bad UPDATE shouldn't
 * abort the whole boot sequence. The DB is a side-channel relative to
 * the worker's primary mission (serving dispatches); we'd rather start
 * with a slightly stale row than not start at all.
 */
export async function reconcileOrphanedDispatches(
  repoName: string,
): Promise<ReconcileResult> {
  const rows = await findNonTerminalDispatches(repoName);
  const result: ReconcileResult = {
    scanned: rows.length,
    orphaned: [],
    alive: [],
  };
  if (rows.length === 0) {
    log.info(`[${repoName}] No non-terminal dispatches to reconcile`);
    return result;
  }

  for (const row of rows) {
    const pid = row.hostPid;
    if (isDispatchOrphaned(row, isPidAlive)) {
      try {
        await updateDispatch(row.id, {
          status: "failed",
          summary: ORPHAN_SUMMARY,
          completedAt: Date.now(),
        });
        result.orphaned.push(row.id);
        log.info(
          `[${repoName}] Reconciled orphaned dispatch ${row.id} (host_pid=${pid ?? "null"}) → failed`,
        );
      } catch (err) {
        log.error(
          `[${repoName}] Failed to mark dispatch ${row.id} as orphaned`,
          err,
        );
      }
    } else {
      result.alive.push(row.id);
      log.info(
        `[${repoName}] Dispatch ${row.id} survived restart (host_pid=${pid} alive) — leaving running`,
      );
    }
  }

  return result;
}
