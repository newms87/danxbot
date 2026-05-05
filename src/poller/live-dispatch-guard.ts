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
 * worker startup `reconcileOrphanedDispatches` is responsible for those.
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
    if (row.trigger !== "trello") continue;
    const meta = row.triggerMetadata as TrelloTriggerMetadata;
    if (meta.cardId !== cardId) continue;
    // Inverse of reconcile's branch: a row is "live" exactly when it is
    // NOT orphaned. Both consumers route through `isDispatchOrphaned` so
    // the rule lives in one place. See `dispatch-liveness.ts`.
    if (!isDispatchOrphaned(row, deps.isPidAlive)) {
      return true;
    }
  }
  return false;
}
