/**
 * Best-effort tracker push on the dispatch's tracked issue (DX-218 /
 * Phase 3 of the Event-Driven Worker epic). Wired into `handleStop` so
 * an agent that calls `danxbot_complete` after editing its YAML still
 * gets that YAML pushed to the tracker before the process exits —
 * without waiting up to ~30-60s for the next poller tick to mirror it.
 *
 * Phase 3 changed the implementation: instead of running its own
 * tracker push (the legacy `syncTrackedIssueOnComplete` → `runSync`
 * chain), this module now calls `reconcileIssue(..., "lifecycle")`.
 * Reconcile owns step 7 (outbound tracker push via `pushTrelloDiff`),
 * which goes through the per-card serial queue so concurrent reconciles
 * for the same card don't race each other on Trello. The `lifecycle`
 * trigger tells reconcile to AWAIT the trailing tracker push before
 * returning; the dashboard sees terminal tracker state by the time
 * `handleStop` SIGTERMs the agent.
 *
 * Lookup chain:
 *   1. `getDispatch(jobId)` → trigger metadata.
 *   2. `trigger === "trello"` && `metadata.cardId` → tracker-native
 *      external_id. Translate to internal `id` via the local YAML
 *      directory (`findByExternalId`); skip if no local file mirrors
 *      that external_id.
 *   3. Anything else (Slack, api, missing row) → no-op.
 *
 * Errors (DB lookup failure, reconcile exception) are logged and
 * swallowed — a tracker hiccup must NEVER block the agent's terminal
 * state from landing. The agent already passed `danxbot_complete`; the
 * worker must not turn that into a stall.
 */

import { reconcileIssue } from "../issue/reconcile.js";
import { findByExternalId } from "../poller/yaml-lifecycle.js";
import { createLogger } from "../logger.js";
import { isTrelloSyncOverrideDisabled } from "../settings-file.js";
import type {
  Dispatch,
  TrelloTriggerMetadata,
} from "../dashboard/dispatches.js";
import type { ReconcileTrigger } from "../issue/reconcile-types.js";
import type { ReconcileRepoContext } from "../issue/reconcile.js";
import type { RepoContext } from "../types.js";

const log = createLogger("auto-sync");

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
    // DX-302 — per-repo `trelloSync` operator override. When the
    // operator has explicitly flipped it off in
    // `<repo>/.danxbot/settings.json`, every Trello outbound call must
    // no-op; auto-sync is one of the four outbound paths the epic gates.
    // Checked BEFORE the dispatch lookup so a disabled-Trello repo
    // doesn't even probe the DB for the per-dispatch trigger row.
    //
    // We consult ONLY the explicit override (not the env default) so
    // existing tests + production code that fire a Trello-trigger
    // auto-sync against a repo without `DANX_TRELLO_ENABLED` env (e.g.
    // the system-test fixture) keep working — the trigger filter on
    // the dispatch row is the canonical "is this a Trello sync"
    // signal, and this gate is the additive operator-pause on top.
    if (isTrelloSyncOverrideDisabled(repo.localPath)) {
      log.info(
        `[${repo.name}] trello sync disabled via settings override — skipping auto-sync for dispatch ${jobId}`,
      );
      return;
    }
    const row = await deps.getDispatch(jobId);
    if (!row || row.trigger !== "trello") return;
    const meta = row.triggerMetadata as TrelloTriggerMetadata;
    const externalId = meta.cardId;
    if (!externalId) return;
    const local = await findByExternalId(repo.localPath, externalId);
    if (!local) return;
    await deps.reconcile(
      {
        name: repo.name,
        localPath: repo.localPath,
        issuePrefix: repo.issuePrefix,
      },
      local.id,
      "lifecycle",
    );
  } catch (err) {
    log.error(
      `[Dispatch ${jobId}] danxbot_complete auto-sync failed (non-fatal)`,
      err,
    );
  }
}
