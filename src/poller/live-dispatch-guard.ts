/**
 * Pre-claim DB guard (ISS-69). Lives outside `src/poller/index.ts` so the
 * test file can import it without dragging in the poller's config-chain
 * load (which hard-requires `DANXBOT_DB_*` at import time and breaks
 * standalone unit tests — see `danx-repo-workflow.md` "Isolate pure
 * helpers from src/poller/index.ts").
 *
 * Returns true when the dispatches table has a non-terminal row for
 * `cardId` whose worker `host_pid` is still alive — i.e. the prior
 * dispatch's claude is still running and the poller MUST NOT spawn a
 * second one for the same card.
 *
 * Host-mode dispatches outlive the worker — `script -q -f` reparents
 * claude to PID 1 — so a worker restart leaves the dispatch row stuck at
 * `running` while the agent is genuinely still working. Without this
 * guard the tracker-side lock TTL eventually reclaims the card and the
 * poller spawns a duplicate. Rows with a dead PID fall through here:
 * worker startup `reattachOrResolveDispatches` (DX-209) is responsible
 * for those — it marks dead-PID rows `failed` and reattaches alive PIDs
 * into the new worker's `activeJobs` registry.
 *
 * Errors are swallowed and logged via the injected `log` — fail open so
 * a transient DB hiccup doesn't permanently halt the poller. Worst case
 * we lose duplicate-protection for one tick; the tracker-side lock TTL
 * still applies.
 */

import type {
  Dispatch,
  TrelloTriggerMetadata,
} from "../dashboard/dispatches.js";
import { isDispatchOrphaned } from "../dashboard/dispatch-liveness.js";

export interface LiveDispatchGuardDeps {
  findNonTerminalDispatches: (repoName: string) => Promise<Dispatch[]>;
  isPidAlive: (pid: number) => boolean;
  log: { warn: (msg: string) => void };
}

export async function hasLiveDispatchForCard(
  repoName: string,
  cardId: string,
  deps: LiveDispatchGuardDeps,
  /**
   * Optional internal issue id (`DX-N`). When supplied, the guard ALSO
   * matches dispatch rows whose `issueId` column equals this — covers
   * non-trello-triggered dispatches that still target the same card
   * (e.g. the worker boot auto-resume path, which uses `trigger: "api"`
   * + `issue_id: <internal>` to mirror a dead poller dispatch). Without
   * this branch the poller's `tryResumeOrphan` was blind to live
   * auto-resume children and spawned duplicates on the next tick.
   */
  internalIssueId?: string,
): Promise<boolean> {
  let rows: Dispatch[];
  try {
    rows = await deps.findNonTerminalDispatches(repoName);
  } catch (err) {
    deps.log.warn(
      `[${repoName}] pre-claim DB guard: findNonTerminalDispatches failed (${err instanceof Error ? err.message : String(err)}) — continuing without guard`,
    );
    return false;
  }
  for (const row of rows) {
    const matchesExternal =
      row.trigger === "trello" &&
      (row.triggerMetadata as TrelloTriggerMetadata).cardId === cardId;
    const matchesInternal =
      internalIssueId !== undefined && row.issueId === internalIssueId;
    if (!matchesExternal && !matchesInternal) continue;
    // Inverse of reconcile's branch: a row is "live" exactly when it is
    // NOT orphaned. Both consumers route through `isDispatchOrphaned` so
    // the rule lives in one place. See `dispatch-liveness.ts`.
    if (!isDispatchOrphaned(row, deps.isPidAlive)) {
      return true;
    }
  }
  return false;
}
