/**
 * Per-repo dispatch scheduler — Phase 4 of Event-Driven Worker (DX-219).
 *
 * Today this module is a thin coordinator that ports four protections
 * from the legacy `_poll` single-card dispatch path (which DX-242
 * removed) onto the multi-agent dispatch path (DX-200). Without these
 * ports the multi-agent picker is a regression vs the legacy path it
 * replaces. The full event-driven scheduler (reconcile step 8 wiring,
 * triage `expires_at` setTimeout, per-dispatch TTL setTimeout,
 * settings.json file-watch + `onAgentRosterChange`, `_poll` decision
 * deletion) is deferred to follow-up phases — those concerns are NOT
 * in this card's `ac[]`.
 *
 * The four ports:
 *
 *   1. **Tracker-comment lock + release.** Already wired through
 *      `tryAcquireLock` + `dispatch()`'s `lockRelease` callback in
 *      `src/poller/multi-agent-pick.ts` (DX-241). This module re-exports
 *      the lock helpers from `src/issue-tracker/lock.js` so the
 *      scheduler is the single API surface for dispatch-time protections.
 *      No call-site move required.
 *
 *   2. **Pre-claim DB liveness guard.** `guardLiveDispatchForCard`
 *      wraps `hasLiveDispatchForCard` (ISS-69) and injects the DB +
 *      PID-liveness deps. The multi-agent picker calls this AFTER
 *      `pickCardForAgent` and BEFORE the tracker-comment lock acquire
 *      so that a card currently being worked by a host-mode dispatch
 *      (whose claude reparented to PID 1 after a worker restart) is
 *      not double-claimed. Without this port the picker would spawn a
 *      second claude on the same card after every restart.
 *
 *   3. **Boot-time TrelloTracker credentials guard.** `bootScheduler`
 *      throws when the repo's tracker is a TrelloTracker but
 *      `repo.trello.{apiKey,apiToken,boardId}` is incomplete. Surfaces
 *      config drift at worker boot instead of at the first dispatch
 *      (which might be minutes later) — and registers the tracker in
 *      `trackersByRepo` for the post-dispatch progress check.
 *
 *   4. **Post-dispatch card-progress check + CRITICAL_FAILURE halt.**
 *      `runPostDispatchProgressCheck` is the extracted form of
 *      `checkCardProgressedOrHalt` from `src/poller/index.ts`. The
 *      multi-agent picker wires it into the dispatch's `onComplete`
 *      callback; when the tracked card stayed in ToDo after the
 *      dispatch ended, the function writes `<repo>/.danxbot/CRITICAL_FAILURE`
 *      so the next poll tick's halt gate refuses further dispatches.
 *      This is the $1k/day token-burn safeguard from production.
 *
 * `trackersByRepo` mirrors the registry pattern from
 * `src/issue/reconcile.ts` (Phase 3 / DX-218) — keeps tracker lookup
 * out of the multi-agent picker's argument list. Reset via
 * `_resetSchedulerTrackers` in tests only.
 */

import { findNonTerminalDispatches } from "../dashboard/dispatches-db.js";
import { isPidAlive } from "../agent/host-pid.js";
import { writeFlag } from "../critical-failure.js";
import { hasLiveDispatchForCard } from "../poller/live-dispatch-guard.js";
import { TrelloTracker } from "../issue-tracker/trello.js";
import { findByExternalId } from "../poller/yaml-lifecycle.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger("scheduler");

const trackersByRepo = new Map<string, IssueTracker>();

/**
 * Lookup the tracker registered by `bootScheduler`. Returns undefined
 * when no boot has happened for this repo — callers that need to
 * fail-loud should branch on that.
 */
export function getSchedulerTracker(
  repoName: string,
): IssueTracker | undefined {
  return trackersByRepo.get(repoName);
}

/**
 * Test seam. Reset all registered trackers between tests so a stale
 * registration from a prior test does not leak into a later one.
 */
export function _resetSchedulerTrackers(): void {
  trackersByRepo.clear();
}

/**
 * Boot-time scheduler initialization for one repo. Validates that a
 * TrelloTracker has populated credentials and registers the tracker
 * for later use by the post-dispatch progress check.
 *
 * Called from worker boot (`src/index.ts`) BEFORE the poller starts.
 * Throws synchronously on a missing-creds TrelloTracker so the worker
 * fails to start instead of running with broken dispatch-followup. A
 * MemoryTracker (DANXBOT_TRACKER=memory) constructs without creds and
 * passes the check.
 *
 * Idempotent — re-registering on a hot reload replaces the prior
 * tracker reference cleanly.
 *
 * AC #3 of DX-219.
 */
export function bootScheduler(args: {
  repo: RepoContext;
  tracker: IssueTracker;
}): void {
  const { repo, tracker } = args;
  if (tracker instanceof TrelloTracker) {
    const trello = repo.trello;
    if (!trello?.apiKey || !trello?.apiToken || !trello?.boardId) {
      throw new Error(
        `[scheduler] boot validation failed for repo "${repo.name}": ` +
          `tracker is TrelloTracker but trello credentials on RepoContext are incomplete ` +
          `(apiKey=${Boolean(trello?.apiKey)}, apiToken=${Boolean(trello?.apiToken)}, boardId=${Boolean(trello?.boardId)})`,
      );
    }
  }
  trackersByRepo.set(repo.name, tracker);
  log.info(
    `[${repo.name}] scheduler boot: ${tracker instanceof TrelloTracker ? "TrelloTracker validated" : "MemoryTracker"} and registered`,
  );
}

/**
 * Pre-claim DB liveness guard. Returns true when a non-terminal
 * dispatch row exists for `cardId` AND its worker PID is still alive.
 *
 * The multi-agent picker MUST skip the candidate when this returns
 * true — a host-mode dispatch reparented to PID 1 after a worker
 * restart still owns the card; spawning a second claude on the same
 * card melts the working tree. Live-PID detection is the only signal
 * available across worker restarts; the DB row alone is ambiguous
 * (the row says "running" whether the agent is alive or zombied).
 *
 * `findNonTerminalDispatches` errors fall through to `false`
 * (fail-open) so a transient DB hiccup does not permanently halt the
 * picker. Worst case we lose duplicate-protection for one tick; the
 * tracker-comment lock still applies as defense-in-depth.
 *
 * AC #2 of DX-219.
 */
export async function guardLiveDispatchForCard(args: {
  repoName: string;
  cardId: string;
  internalIssueId?: string;
}): Promise<boolean> {
  return hasLiveDispatchForCard(
    args.repoName,
    args.cardId,
    {
      findNonTerminalDispatches,
      isPidAlive,
      log: { warn: (m) => log.warn(m) },
    },
    args.internalIssueId,
  );
}

export interface PostDispatchCheckInput {
  repo: RepoContext;
  cardId: string;
  jobId: string;
  jobStatus: string;
  jobSummary: string;
}

/**
 * Post-dispatch card-progress check. After a trello-triggered dispatch
 * exits (success OR failure), fetch the tracked card. If it stayed in
 * ToDo, the dispatch did zero progress — an environment-level blocker
 * the worker cannot self-recover from. Write the CRITICAL_FAILURE flag
 * so the next poll tick's halt gate refuses further dispatches.
 *
 * Skipped (no flag written) when:
 *   - `getCard` throws (false-negative is safer than false-positive on
 *     a tracker transient — the next tick reattempts).
 *   - Card moved out of ToDo (any other status = some progress).
 *   - Local YAML has `waiting_on != null` (the agent intentionally
 *     parked the card behind other in-flight work — the worker
 *     forces `status: ToDo` on save, so the tracker will report
 *     ToDo as expected).
 *   - No tracker registered for this repo (`bootScheduler` not called)
 *     — fail-open with a warning rather than a flag write.
 *
 * Extracted from `checkCardProgressedOrHalt` in `src/poller/index.ts`
 * and parameterized so the multi-agent picker can wire it into
 * `onComplete` without depending on `state.trackedCardId`. The
 * production safeguard the legacy `_poll` path had against
 * $1k/day token-burn loops now applies to every multi-agent dispatch.
 *
 * AC #4 of DX-219.
 */
export async function runPostDispatchProgressCheck(
  input: PostDispatchCheckInput,
): Promise<void> {
  const { repo, cardId, jobId, jobStatus, jobSummary } = input;
  const tracker = trackersByRepo.get(repo.name);
  if (!tracker) {
    log.warn(
      `[${repo.name}] post-dispatch check: no tracker registered for repo — skipping (bootScheduler not called?)`,
    );
    return;
  }

  let card: Issue;
  try {
    card = await tracker.getCard(cardId);
  } catch (err) {
    log.error(
      `[${repo.name}] post-dispatch check: failed to fetch ${cardId} — skipping flag`,
      err,
    );
    return;
  }

  if (card.status !== "ToDo") {
    return;
  }

  let local: Issue | null;
  try {
    local = await findByExternalId(repo.localPath, cardId);
  } catch (err) {
    log.error(
      `[${repo.name}] post-dispatch check: failed to read local YAML for ${cardId} — skipping flag`,
      err,
    );
    return;
  }
  if (local?.waiting_on) {
    log.info(
      `[${repo.name}] post-dispatch check: card "${card.title}" (${cardId}) intentionally waiting on ${local.waiting_on.by.join(", ")} — skipping flag`,
    );
    return;
  }

  log.error(
    `[${repo.name}] post-dispatch check: tracked card "${card.title}" (${cardId}) still in ToDo after dispatch ${jobId} — writing critical-failure flag`,
  );
  writeFlag(repo.localPath, {
    source: "post-dispatch-check",
    dispatchId: jobId,
    cardId,
    cardUrl: `https://trello.com/c/${cardId}`,
    reason: `Tracked card "${card.title}" did not move out of ToDo after dispatch`,
    detail:
      `Card ${cardId} (${card.title}) stayed in the ToDo list across dispatch ${jobId} ` +
      `(status=${jobStatus}, summary=${jobSummary || "none"}). ` +
      `Poller halts until this flag is cleared and the underlying environment blocker is fixed.`,
  });
}

/**
 * Re-export the tracker-comment lock helpers so `scheduler` is the
 * single API surface for dispatch-time protections. The actual call
 * sites in `src/poller/multi-agent-pick.ts` already use these via the
 * direct `../issue-tracker/lock.js` import path; new callers SHOULD
 * import from here.
 *
 * AC #1 of DX-219.
 */
export {
  buildLockHolderInfo,
  releaseLock,
  tryAcquireLock,
} from "../issue-tracker/lock.js";
