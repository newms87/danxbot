/**
 * Post-dispatch reconcile — fired from `handleStop` after every dispatch
 * reaches a terminal status, regardless of trigger source or Trello
 * configuration. This module is named `auto-sync.ts` for historical
 * reasons; its actual responsibility is **business-logic** post-dispatch
 * convergence, NOT Trello sync.
 *
 * # Decoupling invariant (load-bearing)
 *
 * The issue-tracker business logic — dispatch lifecycle, scheduler poke,
 * dispatchable-set diff, parent recurse — MUST run for every terminal
 * dispatch carrying an `issueId`. Trello is a side system; whether
 * `trelloSync` is enabled or disabled, whether the dispatch was triggered
 * by Trello, Slack, /api/launch, or the poller, makes ZERO difference to
 * whether this reconcile fires. The trelloSync override only gates the
 * Trello push step INSIDE `reconcileIssue` (step 7, gated at
 * `src/issue/reconcile.ts:614`); every other reconcile step — including
 * `dispatchableChanged` fanout that pokes the picker — runs unconditionally.
 *
 * **Why this matters.** Pre-DX-{this-fix}, the gate at the top of this
 * module short-circuited the reconcile call when `trelloSync.enabled =
 * false`, so the `onReconcileResult` poke chain never fired and the
 * picker sat idle after every dispatch on a Trello-disabled repo. That
 * bug coupled the picker's liveness to a side-system flag — exactly the
 * coupling the operator wants none of.
 *
 * # Behavior
 *
 *   1. Look up the dispatch row by `jobId`.
 *   2. Skip if the row is missing OR has no `issueId` (Slack chats,
 *      board-chat sessions, ideator runs, /api/launch invocations that
 *      didn't pass an issue — none of those carry an issue YAML to
 *      reconcile against).
 *   3. Call `reconcileIssue(repo, issueId, "lifecycle")`. The "lifecycle"
 *      trigger tells reconcile to AWAIT the trailing tracker push (if
 *      Trello is enabled) before returning so the dashboard sees terminal
 *      tracker state by the time `handleStop` SIGTERMs the agent.
 *
 * Errors (DB lookup failure, reconcile exception) are logged and
 * swallowed — a tracker hiccup or reconcile bug must NEVER block the
 * agent's terminal state from landing. The agent already passed
 * `danxbot_complete`; the worker must not turn that into a stall.
 */

import { reconcileIssue } from "../issue/reconcile.js";
import { onDispatchTerminated } from "../dispatch/scheduler.js";
import { createLogger } from "../logger.js";
import type { Dispatch } from "../dashboard/dispatches.js";
import type { ReconcileTrigger } from "../issue/reconcile-types.js";
import type { ReconcileRepoContext } from "../issue/reconcile.js";
import type { RepoContext } from "../types.js";

const log = createLogger("post-dispatch-reconcile");

export interface AutoSyncDeps {
  getDispatch: (jobId: string) => Promise<Dispatch | null>;
  /**
   * Reconcile invocation seam. Production binds to `reconcileIssue`;
   * tests inject a mock to assert the call without booting the chokepoint.
   */
  reconcile: (
    repo: ReconcileRepoContext,
    id: string,
    trigger: ReconcileTrigger,
  ) => Promise<unknown>;
}

/**
 * Lazy-load `getDispatchById` so this module's top-level import doesn't
 * pull `src/config.ts` (which validates DB env vars at module-init).
 */
async function defaultGetDispatch(jobId: string): Promise<Dispatch | null> {
  const { getDispatchById } = await import("../dashboard/dispatches-db.js");
  return getDispatchById(jobId);
}

export async function autoSyncTrackedIssue(
  jobId: string,
  repo: RepoContext,
  deps: AutoSyncDeps = {
    getDispatch: defaultGetDispatch,
    reconcile: reconcileIssue,
  },
): Promise<void> {
  try {
    const row = await deps.getDispatch(jobId);
    // No row → dispatch already cleaned up by another path; nothing to
    // reconcile. No `issueId` → dispatch wasn't bound to a card YAML
    // (Slack chat, board-chat, ideator, or /api/launch without an issue),
    // so there is no YAML for reconcile to operate on.
    if (row && row.issueId !== null) {
      await deps.reconcile(
        {
          name: repo.name,
          localPath: repo.localPath,
          issuePrefix: repo.issuePrefix,
        },
        row.issueId,
        "lifecycle",
      );
    }
  } catch (err) {
    log.error(
      `[Dispatch ${jobId}] post-dispatch reconcile failed (non-fatal)`,
      err,
    );
  } finally {
    // Always poke the picker, regardless of whether reconcile fired or
    // succeeded. The agent slot this dispatch occupied just freed up;
    // the picker must get a chance to fill it from any other open ToDo
    // card in the queue. Reconcile's `dispatchableChanged` poke flips
    // ONLY when the dispatched card's eligibility changes (status: ToDo
    // + dispatch: null + blocked: null + ...) — for self-Blocked /
    // self-Done completions, the flag stays false→false and the picker
    // would never fire without this explicit kick. See
    // `scheduler.ts#onDispatchTerminated` header for the full contract.
    try {
      onDispatchTerminated(repo.name);
    } catch (err) {
      log.error(
        `[Dispatch ${jobId}] onDispatchTerminated poke failed (non-fatal)`,
        err,
      );
    }
  }
}
